# Workspace New Session Directory-First Design

## Goal

Make session creation feel workspace-native: a multi-root workspace exposes one `NEW` action, and choosing that action starts by selecting the working directory. The separate `IN…` control is removed.

## Interaction

- A multi-root workspace renders only the existing `NEW` button.
- Selecting `NEW` opens the VS Code workspace-root picker before any provider or title prompt.
- Cancelling the root picker cancels creation without showing later prompts or creating partial runtime state.
- After choosing a root, the existing provider, optional title, capability validation, and runtime creation flow continues with that root as the explicit primary working directory.
- A single-folder workspace skips the root picker and retains its existing provider/title flow.
- Resume behavior is unchanged and continues to prefer a historical working directory when available.

## Implementation Boundaries

The creation controller owns the ordering. It receives a root-picker dependency, invokes it only for workspaces with more than one root, and passes the selected root ID into the existing directory-scope resolver. The webview removes the `IN…` menu and its obsolete click handling; the existing `create-ai-session` route remains the only creation entry point.

Provider capability checks remain in directory-scope preflight. They run after provider selection because they depend on the selected provider, while the user's root choice is collected first.

## Validation

Automated checks cover:

- multi-root markup contains `NEW` but no `IN…` actions;
- multi-root creation prompts in root → provider → title order;
- cancelling root selection prevents all later prompts and runtime creation;
- single-folder creation does not open the root picker;
- the selected root reaches the existing launch scope unchanged;
- resume behavior and message validation continue to pass their existing regression suites.
