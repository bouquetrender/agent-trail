# AgentTrail

[English](README.md) | [简体中文](README.zh-CN.md)

Review coding-agent file changes and observe terminal activity in VS Code.
Works alongside Codex, Claude, and other agents without calling AI APIs.
The review views follow VS Code's display language: Chinese for Chinese locales,
English for all others.

## Getting started

1. Open a workspace; the extension captures a review baseline automatically.
2. Let your agent edit files, then open **AGENT CHANGES** in Explorer.
3. Compare changes and **Accept** or **Reject** individual changes, files, or all
   pending changes. **Accept** keeps the code; **Reject** restores the baseline.
4. Open **SESSION TIMELINE** to see file activity and terminal commands, including
   their working directory, duration, and exit code.

**History** keeps reviewed changes for reference. **Start Session** / **Reset Session**
begins a fresh review; previous timelines remain available. **End Agent Session**
stops recording while keeping review actions available.

With the Codex extension installed, use **Request Change** to send a selected change
to Codex, or use the selection hover to add code, files, or folders to a thread.

## Requirements and limits

- VS Code **1.85+**. Terminal activity requires **1.93+** and a terminal with
  **Shell Integration** enabled.
- Existing UTF-8 text files support review. Added and deleted files are history only;
  binary files are excluded.
- Manual edits in VS Code update the file's baseline. Switching Git branches starts
  a fresh review. Accepting changes cannot be undone with editor Undo.
- Activity does not identify who made a change or ran a command. Terminal output is
  not collected. History and timelines are cleared when the window reloads.
- Your Git index and staging area are left untouched.

## Development

```sh
npm install
npm run compile
npm run test:unit
npm run test:integration
```

Press **F5** to launch the Extension Development Host. Integration tests default to
VS Code 1.85.2; set `VSCODE_EXECUTABLE_PATH` to test another installed version.
