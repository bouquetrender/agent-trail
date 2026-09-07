# cursor-forgery

<img width="100%" height="auto" alt="ScreenShot_2026-09-03_181158_713" src="https://github.com/user-attachments/assets/b3858d45-e78c-4398-9b2a-ed25f9cfb535" />

[English](README.md) | [简体中文](README.zh-CN.md)

`cursor-forgery` is a VS Code extension that emulates Cursor interactions. It
reviews changes made by agents to code files and can quickly add a code selection,
an entire file, or the current folder to a Codex thread. The extension does not
call any APIs or change how agents work.

## Workflow

1. Open or reload a workspace; the extension captures a baseline automatically.
2. Let Codex, Claude, or another agent edit workspace files.
3. Open **AGENT CHANGES** in Explorer.
4. Select a file or hunk to open the current file at that line.
5. Accept or reject changes from the tree or CodeLens. Find **Request Change** in
   the editor or hunk context menu under **More Review Actions**. Run **Agent
   Review: Start Session** at any time to reset the baseline manually.

## Sidebar

- **Pending Review**: pending changes. Items disappear after Accept or Reject.
- **History**: read-only history for the current session, collapsed by
  default. Added and deleted files appear here as whole-file, read-only changes and
  are not shown in Pending Review. A new change at the same location replaces the old
  entry. Starting a new session clears the history. History opens the current file;
  recorded line positions may have shifted.

The empty view distinguishes an inactive session, baseline capture, and a ready
session with no pending changes. Bulk Accept and Reject buttons appear only when
there are pending changes. The status bar shows pending file and change counts.
Automatic startup reports progress there without a success notification; errors
still show a notification.

## Review actions

- `Accept`: keep the current code and advance the baseline. Editor Undo cannot
  undo acceptance.
- `Reject`: restore code from the baseline.
- `Request Change`: select the changed code and add it to the Codex thread.

**Reject All** asks for confirmation with the affected file count. If a target
file or its baseline changes during confirmation, the operation stops so you can
review the latest changes.

Editing a file manually in VS Code takes ownership of that file. The extension
updates its baseline and clears its pending review changes.

## Codex context

With the official Codex extension installed, select code to use
`Add Selection`, `Add File`, or `Add Folder`.

## Commands

- `Agent Review: Start Session`
- `Agent Review: Open Change`
- `Agent Review: View Before ↔ After`
- `Agent Review: Accept Hunk`
- `Agent Review: Reject Hunk`
- `Agent Review: Request Change`
- `Agent Review: Accept File`
- `Agent Review: Reject File`
- `Agent Review: Accept All`
- `Agent Review: Reject All`

## Development

```sh
npm install
npm run compile
npm run test:unit
npm run test:integration
```

Press `F5` to launch an Extension Development Host. Requires VS Code 1.85+;
development dependencies support Node 16.20.1.

## Current scope

- Existing UTF-8 text files are reviewed as line changes.
- Added and deleted UTF-8 text files are recorded as whole-file history without
  Accept or Reject actions. Renames are not identified separately.
- Binary and non-UTF-8 files are not reviewed.
- Git workspaces use an isolated temporary environment and never modify the real
  index or staging area.
- Non-Git and multi-root workspaces use an in-memory baseline.
- Direct filesystem writes are treated as agent changes. Changes that make a
  VS Code document dirty are treated as user edits.
