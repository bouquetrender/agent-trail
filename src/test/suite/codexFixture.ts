import * as assert from "assert";
import { exec } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { captureHook, isMissing, isObject } from "../../codex/hook";
import type { ReviewSession } from "../../session/ReviewSession";

let hookCommand: string;

export async function connectTestCodex(): Promise<void> {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome, "Integration tests require an isolated CODEX_HOME");
  const errors: string[] = [];
  const showError = vscode.window.showErrorMessage;
  vscode.window.showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
  try {
    await vscode.extensions.getExtension("local.agent-trail")?.activate();
    assert.ok(vscode.workspace.isTrusted, "Test workspace must be trusted");
    await vscode.commands.executeCommand("cursorForgery.connectCodex");
    assert.deepStrictEqual(errors, []);
  } finally {
    vscode.window.showErrorMessage = showError;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  await assert.rejects(fs.access(path.join(root, ".codex")), { code: "ENOENT" });
  const config: unknown = JSON.parse(await fs.readFile(path.join(codexHome, "hooks.json"), "utf8"));
  assert.ok(isObject(config) && isObject(config.hooks) && Array.isArray(config.hooks.PreToolUse));
  const group: unknown = config.hooks.PreToolUse[0];
  assert.ok(isObject(group) && Array.isArray(group.hooks));
  const handler: unknown = group.hooks[0];
  assert.ok(isObject(handler) && typeof handler.command === "string");
  hookCommand = handler.command;
}

// Drive the same executable and payload contract as Codex, around a controlled file mutation.
export async function codexWrite(uri: vscode.Uri, after: string | null, session?: ReviewSession): Promise<void> {
  const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  assert.ok(root);
  const workspace = await fs.realpath(root);
  const before = await fs.readFile(uri.fsPath, "utf8").catch((error: unknown) => {
    if (isMissing(error)) { return null; }
    throw error;
  });
  const relative = path.relative(root, uri.fsPath);
  const textLines = (value: string) => value.replace(/\n$/, "").split("\n");
  const command = ["*** Begin Patch",
    `*** ${after === null ? "Delete" : before === null ? "Add" : "Update"} File: ${relative}`,
    ...(before !== null && after !== null ? ["@@", ...textLines(before).map((line) => `-${line}`)] : []),
    ...(after !== null ? textLines(after).map((line) => `+${line}`) : []),
    "*** End Patch"].join("\n");
  const payload = {
    session_id: "integration-codex", turn_id: "turn", tool_use_id: randomUUID(),
    cwd: workspace, tool_name: "apply_patch", tool_input: { command },
    tool_response: `Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\n${after === null ? "D" : before === null ? "A" : "M"} ${relative}\n`,
  };
  const emit = async (hook_event_name: string) => {
    const input = { ...payload, hook_event_name };
    if (session) {
      const event = await captureHook(input, workspace);
      assert.ok(event);
      session.codexEvents.accept(event);
      await session.flushCodexChanges();
    }
    await new Promise<void>((resolve, reject) => {
      const child = exec(hookCommand, (error) => error ? reject(error) : resolve());
      child.stdin?.end(JSON.stringify(input));
    });
  };
  await emit("PreToolUse");
  if (after === null) { await vscode.workspace.fs.delete(uri); }
  else { await vscode.workspace.fs.writeFile(uri, Buffer.from(after)); }
  await emit("PostToolUse");
}
