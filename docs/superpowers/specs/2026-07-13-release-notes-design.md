# GitHub Release Notes Design

**Date:** 2026-07-13

## Goal

Publish useful GitHub Release notes from the matching `CHANGELOG.md` version section instead of a fixed placeholder sentence.

## Design

- Add a small Node.js command that accepts a version and optional changelog path, then prints only that version's body.
- Match an exact `## [version]` heading and stop at the next level-two heading so neighboring releases cannot leak into the output.
- Treat a missing version or an empty section as an error with a non-zero exit status.
- Have the release workflow write the extracted content to `release-notes.md` and pass it to `gh release create --notes-file`.
- Keep `CHANGELOG.md` as the single curated source; do not combine it with GitHub-generated commit notes.

## Current Release Repair

Update the existing `v1.1.8` GitHub Release body from the already-published `CHANGELOG.md` section. This changes release metadata only and does not replace the VSIX asset or tag.

## Testing

An executable Node.js regression check will use temporary changelog fixtures to verify exact extraction, heading boundaries, and failure for a missing or empty version. It will also assert that the workflow runs the check and uses the generated notes file rather than inline placeholder text.

## Constraints

- Add no runtime dependency.
- Preserve the release title, draft/prerelease behavior, tag, and VSIX upload behavior.
- Preserve the user's local `.vscode/settings.json` modification and exclude it from all commits.
