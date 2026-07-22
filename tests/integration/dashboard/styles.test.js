'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const CleanCSS = require('clean-css');
const sass = require('sass');

const root = path.resolve(__dirname, '../../..');
const stylesPath = path.join(root, 'media/styles.scss');
const generatedStylesPath = path.join(root, 'media/styles.css');
const styles = fs.readFileSync(stylesPath, 'utf8');
const generatedStyles = fs.readFileSync(generatedStylesPath, 'utf8');

function extractBlock(source, selector, occurrence = 0) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...source.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{`, 'gm'))];
    assert.ok(matches[occurrence], `missing ${selector}`);
    const start = matches[occurrence].index;
    const opening = source.indexOf('{', start);
    let depth = 0;
    for (let index = opening; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(opening + 1, index);
    }
    assert.fail(`unterminated ${selector}`);
}

function validateReducedMotion(source) {
    const dashboardMotion = extractBlock(source, '@media (prefers-reduced-motion: reduce)', 0);
    for (const value of ['.steward-item-card', '.steward-item-accent', 'transition: none']) {
        assert.ok(dashboardMotion.includes(value), `WEBVIEW-REDUCED-MOTION-001 missing ${value}`);
    }
    const sessionMotion = extractBlock(source, '@media (prefers-reduced-motion: reduce)', 1);
    for (const value of ['.ai-session-attention-indicator', 'animation: none !important', 'transition: none !important']) {
        assert.ok(sessionMotion.includes(value), `WEBVIEW-REDUCED-MOTION-001 missing ${value}`);
    }
}

function validateTodoFocus(source) {
    const focus = extractBlock(source, '.todo-square-toggle:focus-within');
    assert.ok(focus.includes('outline: 1px solid var(--vscode-focusBorder)'),
        'TODO-KEYBOARD-FOCUS-001 missing visible outline');
    assert.ok(focus.includes('outline-offset: 1px'), 'TODO-KEYBOARD-FOCUS-001 missing outline offset');
}

function validateTodoLayout(source) {
    const list = extractBlock(source, '.todo-list');
    assert.ok(list.includes('max-height: calc(var(--todo-list-max-height) + var(--todo-list-expanded-extra-height, 0px))'),
        'TODO-RESPONSIVE-LAYOUT-001 missing bounded list height');
    assert.ok(list.includes('overflow-y: auto'), 'TODO-RESPONSIVE-LAYOUT-001 missing list scrolling');
    const editing = extractBlock(source, '.todo-list.has-editing-item');
    assert.ok(editing.includes('max-height: none') && editing.includes('overflow-y: visible'),
        'TODO-RESPONSIVE-LAYOUT-001 editing must reveal the full form');
    const title = extractBlock(source, '.todo-title-text');
    for (const value of ['display: block', 'text-overflow: ellipsis', 'white-space: nowrap']) {
        assert.ok(title.includes(value), `TODO-RESPONSIVE-LAYOUT-001 title missing ${value}`);
    }
    assert.equal(title.includes('-webkit-line-clamp'), false,
        'TODO-RESPONSIVE-LAYOUT-001 titles must remain single-line');
    const collapsedNotes = extractBlock(source, '.todo-item:not(.expanded) .todo-notes');
    assert.ok(collapsedNotes.includes('text-overflow: ellipsis') && collapsedNotes.includes('white-space: nowrap'),
        'TODO-RESPONSIVE-LAYOUT-001 collapsed notes must ellipsize');
}

function compileStyles(source) {
    return sass.compileString(source, {
        loadPaths: [path.join(root, 'media'), path.join(root, 'node_modules')],
        style: 'expanded',
    }).css;
}

function minifyStyles(source) {
    const result = new CleanCSS({ rebaseTo: path.dirname(generatedStylesPath) }).minify({
        [generatedStylesPath]: { styles: source },
    });
    assert.deepEqual(result.errors, [], 'WEBVIEW-STYLES-ARTIFACT-001 styles must minify without errors');
    assert.deepEqual(result.warnings, [], 'WEBVIEW-STYLES-ARTIFACT-001 styles must minify without warnings');
    return result.styles;
}

test('WEBVIEW-STYLES-ARTIFACT-001 committed CSS exactly matches compiled and minified SCSS', () => {
    assert.equal(minifyStyles(compileStyles(styles)), generatedStyles);
    assert.throws(() => assert.equal(minifyStyles(compileStyles(styles)), `${generatedStyles}/* mutation */`));
});

test('WEBVIEW-REDUCED-MOTION-001 disables dashboard and session animation for reduced motion', () => {
    validateReducedMotion(styles);
    assert.throws(() => validateReducedMotion(styles.replace('transition: none;', 'transition: all 1s;')),
        /WEBVIEW-REDUCED-MOTION-001/);
});

test('TODO-KEYBOARD-FOCUS-001 keeps the hidden completed toggle keyboard-visible', () => {
    validateTodoFocus(styles);
    assert.throws(() => validateTodoFocus(styles.replace(
        '.todo-square-toggle:focus-within {\n    outline: 1px solid var(--vscode-focusBorder);',
        '.todo-square-toggle:focus-within {\n    outline: none;')),
        /TODO-KEYBOARD-FOCUS-001/);
});

test('TODO-RESPONSIVE-LAYOUT-001 keeps TODO titles compact, lists scrollable, and editors fully visible', () => {
    validateTodoLayout(styles);
    assert.throws(() => validateTodoLayout(styles.replace(
        '.todo-title-text {\n    min-width: 0;\n    overflow: hidden;\n    display: block;\n    color: var(--vscode-foreground);\n    font-size: 13px;\n    font-weight: 600;\n    line-height: 1.35;\n    text-overflow: ellipsis;\n    white-space: nowrap;',
        '.todo-title-text {\n    min-width: 0;\n    overflow: hidden;\n    display: block;\n    color: var(--vscode-foreground);\n    font-size: 13px;\n    font-weight: 600;\n    line-height: 1.35;\n    text-overflow: ellipsis;\n    white-space: normal;')),
        /TODO-RESPONSIVE-LAYOUT-001/);
});
