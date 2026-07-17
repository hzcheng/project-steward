# TODO UI Polish Design

## Goal

Improve the global TODO tab from a plain form/list into a restrained Notion/Linear-inspired planning surface that feels native inside the VS Code sidebar.

## Scope

- Keep all current TODO data, storage, search, and message contracts.
- Change only TODO panel markup, TODO styles, generated webview assets, and focused tests if needed.
- Do not add new dependencies.
- Preserve sidebar density and VS Code theme variable compatibility.

## Visual Direction

- Replace the top plain toolbar with a compact command bar: summary metrics first, actions second.
- Turn the add form into a compose panel with a prominent title field and quieter notes/metadata controls.
- Render groups as lightweight sections with title, count, and small action buttons.
- Render todo items as polished task rows: checkbox, title, priority badge, notes, and compact item actions.
- Use subtle priority colors from VS Code theme variables; avoid decorative gradients or single-hue dominance.
- Keep completed items readable but visually de-emphasized.

## Testing

- Existing dashboard webview checks must still pass.
- Source and generated webview assets must remain synchronized.
- Safety checks must continue to pass because `media/webviewProjectScripts.js` is compared with `src/webview/webviewProjectScripts.js`.
