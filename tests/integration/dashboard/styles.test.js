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
    for (const value of ['.steward-item-card', '.steward-item-accent', 'transition: none;']) {
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
    assert.ok(list.includes(
        'max-height: calc(var(--todo-list-max-height) + var(--todo-list-expanded-extra-height, 0px))'
    ), 'TODO-RESPONSIVE-LAYOUT-001 list must honor the configured group viewport');
    assert.ok(list.includes('overflow-y: auto'),
        'TODO-RESPONSIVE-LAYOUT-001 overflowing groups must remain scrollable');
    const title = extractBlock(source, '.todo-title-text');
    for (const value of ['display: -webkit-box', '-webkit-line-clamp: 2', '-webkit-box-orient: vertical',
        'overflow-wrap: anywhere']) {
        assert.ok(title.includes(value), `TODO-RESPONSIVE-LAYOUT-001 title missing ${value}`);
    }
    assert.equal(title.includes('white-space: nowrap'), false,
        'TODO-RESPONSIVE-LAYOUT-001 titles must use both available lines');
    const expanded = extractBlock(source, '.todo-item.expanded');
    assert.ok(expanded.includes('height: auto !important'),
        'TODO-MAX-VISIBLE-PER-GROUP-001 expanded cards must override the shared collapsed height');
    assert.ok(expanded.includes('-webkit-line-clamp: unset'),
        'TODO-RESPONSIVE-LAYOUT-001 inline detail must reveal the complete title');
    const inlineValue = extractBlock(source, '.todo-inline-value');
    assert.ok(inlineValue.includes('overflow-wrap: anywhere') && inlineValue.includes('white-space: pre-wrap'),
        'TODO-RESPONSIVE-LAYOUT-001 inline detail values must wrap without clipping');
    const narrow = extractBlock(source, '@media (max-width: 320px)');
    for (const value of ['.todo-quick-add-form', 'grid-template-columns: minmax(0, 1fr) auto',
        '.todo-compose-meta', 'flex-wrap: wrap']) {
        assert.ok(narrow.includes(value), `TODO-RESPONSIVE-LAYOUT-001 narrow layout missing ${value}`);
    }
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
        ['width: 100%', 'height: 58px', 'padding: 8px 10px 8px 15px', 'border-radius: 18px']);
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
    assertDeclarations(ruleForSelector(source, '.todo-detail-notes'), id, ['white-space: pre-wrap']);
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
    assert.throws(() => validateReducedMotion(styles.replace(
        'body.steward-sidebar .steward-item-accent {\n        transition: none;',
        'body.steward-sidebar .steward-item-accent {\n        transition: all 1s;')),
        /WEBVIEW-REDUCED-MOTION-001/);
});

test('TODO-KEYBOARD-FOCUS-001 keeps the hidden completed toggle keyboard-visible', () => {
    validateTodoFocus(styles);
    assert.throws(() => validateTodoFocus(styles.replace(
        '.todo-square-toggle:focus-within {\n    outline: 1px solid var(--vscode-focusBorder);',
        '.todo-square-toggle:focus-within {\n    outline: none;')),
        /TODO-KEYBOARD-FOCUS-001/);
});

test('TODO-RESPONSIVE-LAYOUT-001 keeps TODO titles readable in configured scrolling groups', () => {
    validateTodoLayout(styles);
    assert.throws(() => validateTodoLayout(styles.replace(
        'overflow-wrap: anywhere;\n    -webkit-box-orient: vertical;\n    -webkit-line-clamp: 2;',
        'overflow-wrap: anywhere;\n    -webkit-box-orient: vertical;\n    -webkit-line-clamp: 1;')),
        /TODO-RESPONSIVE-LAYOUT-001/);
    assert.throws(() => validateTodoLayout(styles.replace(
        'overflow-y: auto;',
        'overflow: visible;')),
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
