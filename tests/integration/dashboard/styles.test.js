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

function cssRules(source) {
    return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
        selectors: match[1].split(',').map(selector => selector.trim()),
        body: match[2],
    }));
}

function ruleForSelector(source, selector, requiredDeclaration) {
    const matches = cssRules(source).filter(rule => rule.selectors.includes(selector)
        && (!requiredDeclaration || rule.body.includes(requiredDeclaration)));
    assert.equal(matches.length, 1, `expected exactly one compiled CSS rule for ${selector}`);
    return matches[0];
}

function assertDeclarations(rule, id, declarations) {
    for (const declaration of declarations) {
        assert.ok(rule.body.includes(declaration), `${id} missing ${declaration}`);
    }
}

function validateSharedCardPresentation(source) {
    const id = 'WEBVIEW-SHARED-CARD-STATE-001';
    assertDeclarations(ruleForSelector(source, 'body.steward-sidebar .steward-group-header'), id,
        ['padding: 4px 6px', 'border-radius: 7px', 'font-size: 15px', 'line-height: 1.25']);
    assertDeclarations(ruleForSelector(source, 'body.steward-sidebar .steward-item-card', 'height: 58px'), id,
        ['width: calc(100% - 4px)', 'height: 58px', 'padding: 8px 10px 8px 15px', 'border-radius: 18px']);
    const hover = ruleForSelector(source, 'body.steward-sidebar .steward-item-card:focus-within');
    assertDeclarations(hover, id,
        ['background: var(--vscode-list-hoverBackground)', 'border-color: var(--vscode-focusBorder)', 'transform: translateY(-1px)']);
    const expanded = ruleForSelector(source, 'body.steward-sidebar .steward-item-card.expanded');
    assertDeclarations(expanded, id, ['height: auto', 'min-height: 58px']);
    const selected = ruleForSelector(source, 'body.steward-sidebar .steward-item-card.selected');
    assertDeclarations(selected, id, ['border-color: var(--vscode-focusBorder)']);
}

function validateDangerActions(source) {
    const id = 'WEBVIEW-ACTION-ACCESSIBILITY-001';
    const hover = 'body.steward-sidebar .steward-group-header .group-actions > .danger:hover';
    const focus = 'body.steward-sidebar .steward-group-header .group-actions > .danger:focus-visible';
    const rule = ruleForSelector(source, hover);
    assert.ok(rule.selectors.includes(focus), `${id} danger actions must share hover and keyboard focus state`);
    assertDeclarations(rule, id, ['color: var(--vscode-errorForeground)']);
}

function validateTodoVisualState(source) {
    const id = 'TODO-VISUAL-STATE-001';
    assertDeclarations(ruleForSelector(source, '.todo-group-count'), id,
        ['font-size: 10px', 'opacity: 0.55', 'white-space: nowrap']);
    assertDeclarations(ruleForSelector(source, '.todo-priority-choice input:checked + span'), id,
        ['border-color: var(--vscode-panel-border)', 'color: var(--vscode-foreground)',
            'background: var(--vscode-list-inactiveSelectionBackground)']);
    assertDeclarations(ruleForSelector(source, '.todo-list > .steward-item-card:last-child'), id, ['margin-bottom: 0']);
    assertDeclarations(ruleForSelector(source, '.todo-item.expanded .todo-notes'), id, ['white-space: pre-wrap']);
    assertDeclarations(ruleForSelector(source, '.todo-item:not(.expanded) .todo-item-footer'), id, ['display: none']);
    const completedRules = cssRules(source).filter(rule =>
        rule.selectors.some(selector => selector.includes('.todo-item.completed')));
    assert.ok(completedRules.length > 0, `${id} must retain completed TODO presentation`);
    assert.equal(completedRules.some(rule => /(^|;)\s*background(?:-color)?\s*:/.test(rule.body)), false,
        `${id} completed TODO rules must not override the shared card background`);
}

function validateCollapsePresentation(source) {
    const id = 'WEBVIEW-COLLAPSE-PRESENTATION-001';
    assertDeclarations(ruleForSelector(source, '.group.collapsed .collapse-icon svg'), id,
        ['transform: rotate(-90deg)']);
    assertDeclarations(ruleForSelector(source, '.todo-expand-control[aria-expanded=false] svg'), id,
        ['transform: rotate(-90deg)']);
    assertDeclarations(ruleForSelector(source, '.todo-expand-control svg'), id,
        ['transition: transform 120ms ease']);
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

function assertStyleArtifact(scssSource, cssArtifact) {
    assert.equal(minifyStyles(compileStyles(scssSource)), cssArtifact,
        'WEBVIEW-STYLES-ARTIFACT-001 committed CSS must equal compiled and minified SCSS');
}

const compiledStyles = compileStyles(styles);

test('WEBVIEW-STYLES-ARTIFACT-001 committed CSS exactly matches compiled and minified SCSS', () => {
    assertStyleArtifact(styles, generatedStyles);
    const mutatedArtifact = generatedStyles.replace('box-sizing:border-box', 'box-sizing:content-box');
    assert.notEqual(mutatedArtifact, generatedStyles, 'controlled artifact mutation must alter real CSS');
    assert.throws(() => assertStyleArtifact(styles, mutatedArtifact), /WEBVIEW-STYLES-ARTIFACT-001/);
    const mutatedScss = styles.replace('height: 58px;', 'height: 59px;');
    assert.notEqual(mutatedScss, styles, 'controlled SCSS mutation must alter a real declaration');
    assert.throws(() => assertStyleArtifact(mutatedScss, generatedStyles), /WEBVIEW-STYLES-ARTIFACT-001/);
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

test('WEBVIEW-SHARED-CARD-STATE-001 preserves shared header/card geometry and interaction states', () => {
    validateSharedCardPresentation(compiledStyles);
    assert.throws(() => validateSharedCardPresentation(compileStyles(styles.replace('height: 58px;', 'height: 59px;'))),
        /WEBVIEW-SHARED-CARD-STATE-001|expected exactly one compiled CSS rule/);
});

test('WEBVIEW-ACTION-ACCESSIBILITY-001 gives danger actions matching hover and keyboard focus feedback', () => {
    validateDangerActions(compiledStyles);
    assert.throws(() => validateDangerActions(compileStyles(styles.replace(
        '.group-actions > .danger {\n            &:hover,\n            &:focus-visible {',
        '.group-actions > .danger {\n            &:hover,\n            &.removed-focus-state {'))),
        /WEBVIEW-ACTION-ACCESSIBILITY-001|expected exactly one compiled CSS rule/);
});

test('TODO-VISUAL-STATE-001 preserves count, priority, spacing, notes, footer, and completed-card presentation', () => {
    validateTodoVisualState(compiledStyles);
    assert.throws(() => validateTodoVisualState(compileStyles(styles.replace(
        '.todo-item.completed .todo-title-text {',
        '.todo-item.completed .todo-title-text {\n    background: red;'))),
        /TODO-VISUAL-STATE-001/);
});

test('WEBVIEW-COLLAPSE-PRESENTATION-001 rotates group and TODO collapse indicators', () => {
    validateCollapsePresentation(compiledStyles);
    assert.throws(() => validateCollapsePresentation(compileStyles(styles.replace(
        'transform: rotate(-90deg);', 'transform: rotate(0deg);'))),
        /WEBVIEW-COLLAPSE-PRESENTATION-001/);
});
