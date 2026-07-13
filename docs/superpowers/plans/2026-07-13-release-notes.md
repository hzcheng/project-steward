# GitHub Release Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate each GitHub Release body from the matching curated `CHANGELOG.md` section and repair the existing v1.1.8 body.

**Architecture:** A dependency-free Node.js CLI extracts one exact changelog version section and fails closed when it is absent or empty. The GitHub Actions workflow writes that output to a file and supplies it to `gh release create --notes-file`.

**Tech Stack:** Node.js 22 in CI, CommonJS, GitHub Actions, GitHub CLI, Node.js `assert`

## Global Constraints

- Use the exact `CHANGELOG.md` version section as the GitHub Release body.
- Fail the release job if the requested version section is missing or empty.
- Keep existing tag, title, VSIX asset, draft, and prerelease behavior unchanged.
- Add no runtime dependency.
- Preserve and do not stage `.vscode/settings.json`.

---

### Task 1: Changelog Extraction and Workflow Integration

**Files:**

- Create: `scripts/extract-release-notes.js`
- Create: `scripts/run-release-notes-checks.js`
- Modify: `.github/workflows/release-vsix.yml`
- Modify: `package.json`

**Interfaces:**

- Produces: `extractReleaseNotes(changelog, version): string` and CLI usage `node scripts/extract-release-notes.js <version> [changelog-path]`.
- Consumes: `CHANGELOG.md` and the workflow's existing `VERSION` environment variable.

- [x] **Step 1: Write the failing regression check**

Create a temporary changelog containing versions `1.2.3` and `1.2.2`. Invoke the not-yet-existing CLI for `1.2.3` and assert exit status `0`, output containing only that section body, and no `1.2.2` content. Invoke it for `9.9.9` and assert a non-zero status with a precise missing-version message. Assert the workflow contains `--notes-file release-notes.md` and does not contain the fixed `VSIX package for` placeholder.

- [x] **Step 2: Verify RED**

Run `node scripts/run-release-notes-checks.js`.

Expected: FAIL because `scripts/extract-release-notes.js` does not exist and the workflow still uses the placeholder `--notes` argument.

- [x] **Step 3: Implement the minimal extractor**

Parse level-two headings line by line, match `## [${version}]` with optional trailing date/text, collect until the next `## ` heading, trim the body, and throw when no non-empty body exists. The CLI reads the supplied path or root `CHANGELOG.md`, prints the body, and reports errors to stderr with exit status `1`.

- [x] **Step 4: Integrate the notes file into the workflow**

Before `gh release create`, run:

```bash
node scripts/extract-release-notes.js "$VERSION" > release-notes.md
```

Replace the placeholder with:

```bash
--notes-file release-notes.md
```

Expose the regression check as `npm run test:release-notes` and run it in the release workflow after installing dependencies.

- [x] **Step 5: Verify GREEN and repository checks**

Run:

```bash
npm run test:release-notes
npm run test:safety
npm run lint
```

Expected: all commands exit `0` with no assertion, compilation, or lint failures.

- [x] **Step 6: Repair v1.1.8 release metadata**

Generate the body with `node scripts/extract-release-notes.js 1.1.8` and update release ID `353047493` through `gh api --method PATCH`, because the installed GitHub CLI has no `release edit` command. Verify the release API body exactly contains the changelog body.

- [ ] **Step 7: Submit the workflow fix**

Review the diff, commit only the design, plan, workflow, extractor, test, and package script; push `fix/release-notes`; open and merge a PR into `main`; then switch back to `feat/ai-session-attention-monitor`.
