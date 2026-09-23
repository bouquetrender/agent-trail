# AgentTrail

[English](README.md) | [简体中文](README.zh-CN.md)

Review coding-agent file changes and record Codex tool activity in VS Code.
Agent Changes and Session Timeline both use Codex hooks as their source.
The extension does not call AI APIs.
The review views follow VS Code's display language: Chinese for Chinese locales,
English for all others.

## Getting started

1. Open a workspace; the extension captures a review baseline automatically.
2. Connect Codex as described below, let it edit files with `apply_patch`, then open
   **AGENT CHANGES** in Explorer.
3. Compare changes and **Accept** or **Reject** individual changes, files, or all
   pending changes. **Accept** keeps the code; **Reject** restores the baseline.
4. **SESSION TIMELINE** shows tool requests/results and tool-reported patch paths,
   with command metadata when available.

**History** keeps reviewed changes for reference. **Start Session** / **Reset Session**
begins a fresh review; previous timelines remain available. **End Agent Session**
stops recording while keeping review actions available.

With the Codex extension installed, use **Request Change** to send a selected change
to Codex, or use the selection hover to add code, files, or folders to a thread.

## Connect Codex

1. Install the AgentTrail VSIX and open a trusted local project.
2. Click the plug icon in **SESSION TIMELINE**, or run **AgentTrail: Connect Codex**.
   In a multi-root workspace, choose the project to connect; repeat for other projects.
3. The command opens the user-level `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`
   if `CODEX_HOME` is set in VS Code's environment). Use the same Codex home for VS Code
   and Codex. Existing hooks and connections for other projects are preserved; changes
   to an existing file are backed up alongside it. Each project's handlers only collect
   activity inside that project. The collector script stays in VS Code's extension
   storage. No project files or Git ignore rules are created or changed.
4. Review and trust the hooks in Codex (CLI: `/hooks`). Start a new Codex turn after
   the configuration is loaded. Installing a VSIX alone does not enable recording.
5. Keep the VS Code window open while Codex works. **End Agent Session** pauses recording;
   **Start Session** / **Reset Session** resumes it with a fresh review baseline.

Requires a Codex runtime supporting `PreToolUse` / `PostToolUse` for `Bash` and
`apply_patch`, plus `SessionEnd`. See the [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).
The extension does not automatically grant hook trust. After an AgentTrail or VS Code update, run
**Connect Codex** again to install the updated script, then review any changed hook definitions.
Generated commands contain machine-specific absolute paths; configure each machine separately.
To disconnect a project, remove only handlers labelled `AgentTrail Codex activity: <project path>`
from the user-level hook file.

If you previously connected with project-level hooks, reconnect and trust the user-level
hooks, then remove only the old handlers labelled `AgentTrail Codex activity` from
`<project>/.codex/hooks.json`. Codex loads both sources, so leaving the old handlers can
run them twice or keep invoking old machine paths. AgentTrail does not automatically
modify the old project file. Keep any team hooks; if the file contains only AgentTrail
hooks, it and its `.agenttrail-backup-*` copies can be removed from the repository.

## Requirements and limits

- VS Code **1.138+**. Timeline does not require Shell Integration or a separate Node.js installation;
  the hook script uses the local VS Code executable. Only local desktop workspaces are supported; hooks must run on the same machine as the extension host.
- Existing UTF-8 text files support review. Added and deleted files are history only;
  binary files are excluded.
- Manual edits in VS Code update the file's baseline. Switching Git branches starts
  a fresh review. Accepting changes cannot be undone with editor Undo.
- Both views exclude ordinary file saves, manual terminal commands and activity from other agents.
  Filesystem notifications only refresh or invalidate review items; they do not prove attribution.
- `PreToolUse` is displayed as a request, not proof of execution. Only paired results
  are recorded; requests predating a reset or connection are not reconstructed.
- File events require a successful `apply_patch` result with explicit paths. Shell-generated
  files and unsupported result formats are not attributed by timing. Unavailable exit codes,
  duration and result status remain unknown; failed patches do not create success events.
- Agent Changes additionally requires an exact reconstruction from the pre-tool contents
  that matches the post-tool file. Ambiguous/fuzzy patches, CRLF patches, moves and mixed writes
  are not reviewable. Later unrelated writes invalidate pending review; confirmed history remains.
  Unreported edits preceding a patch are absorbed into its baseline, so rejection preserves them.
- Timeline retains command text and metadata, excluding terminal output and prompts. Patch
  verification transports text snapshots through local temporary event files, removed after reading;
  snapshots are not stored in timeline events. Closed windows do not accumulate new events.
  History and timelines are cleared on reload.
- Your Git index and staging area are left untouched.

## Development

```sh
npm install
npm run compile
npm run test:unit
npm run test:integration
```

Press **F5** to launch the Extension Development Host. Integration tests default to
the latest stable VS Code; set `VSCODE_EXECUTABLE_PATH` to test another installed version.
