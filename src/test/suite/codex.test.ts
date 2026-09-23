import * as assert from "assert";
import { exec } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CodexEventReader } from "../../codex/CodexEventReader";
import { installCodexHooks } from "../../codex/CodexHookSetup";
import { isObject, normalizeHook } from "../../codex/hook";
import { DiffService } from "../../diff/DiffService";
import { MemoryBaselineStore } from "../../session/MemoryBaselineStore";
import { ReviewSession } from "../../session/ReviewSession";
import { AgentEventItem, SessionTimelineProvider } from "../../ui/SessionTimelineProvider";

suite("Codex Timeline", () => {
  test("runs the installed hook using the extension host executable and refreshes the timeline", async function () {
    this.timeout(15_000);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root);
    const workspace = await fs.realpath(root);
    const storage = await fs.mkdtemp(path.join(tmpdir(), "agenttrail-codex-host-"));
    const store = new MemoryBaselineStore();
    const session = new ReviewSession(store, new DiffService(store));
    const timeline = new SessionTimelineProvider(session.agentSessions);
    const errors: unknown[] = [];
    const reader = new CodexEventReader(storage, workspace,
      (event) => session.codexEvents.accept(event), (error) => errors.push(error));
    let refreshes = 0;
    const subscription = timeline.onDidChangeTreeData(() => refreshes++);
    try {
      await session.start();
      await reader.start();
      const codexHome = path.join(storage, "codex-home");
      await fs.mkdir(codexHome);
      await fs.writeFile(path.join(codexHome, "hooks.json"), "");
      const config = await installCodexHooks(workspace, storage,
        path.resolve(__dirname, "../../codex/hook.js"), process.execPath, codexHome);
      const parsed: unknown = JSON.parse(await fs.readFile(config, "utf8"));
      assert.ok(isObject(parsed) && isObject(parsed.hooks) && Array.isArray(parsed.hooks.PreToolUse));
      const group: unknown = parsed.hooks.PreToolUse[0];
      assert.ok(isObject(group) && Array.isArray(group.hooks));
      const handler: unknown = group.hooks[0];
      assert.ok(isObject(handler) && typeof handler.command === "string");
      const command = handler.command;
      for (const hook_event_name of ["PreToolUse", "PostToolUse"]) {
        await new Promise<void>((resolve, reject) => {
          const child = exec(command, (error) => error ? reject(error) : resolve());
          child.stdin?.end(JSON.stringify({
            hook_event_name, session_id: "host-session", turn_id: "host-turn", tool_use_id: "host-call",
            cwd: workspace, tool_name: "Bash", tool_input: { command: "npm test" },
            tool_response: { output: "not collected", metadata: { exit_code: 1, duration_seconds: 8.2 } },
          }));
        });
      }
      const deadline = Date.now() + 5000;
      while ((session.agentSessions.getCurrentSession()?.events.length ?? 0) < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepStrictEqual(errors, []);
      const items = timeline.getChildren(timeline.getChildren()[0]);
      assert.strictEqual(items.length, 3);
      const request = items[1];
      const result = items[2];
      assert.ok(request instanceof AgentEventItem && result instanceof AgentEventItem);
      assert.strictEqual(request.label, "npm test");
      assert.match(String(request.description), /Requested; execution not confirmed/);
      assert.match(String(result.description), /Failed.*exit: 1.*duration: 8.2s/);
      assert.match(String(result.tooltip), /Codex hook.*\nConfidence: reported/);
      assert.ok(!String(result.tooltip).includes("not collected"));
      assert.ok(refreshes >= 3);
      await session.endAgentSession();
      const ended = session.agentSessions.getSessions();
      const late = normalizeHook({
        hook_event_name: "PreToolUse", session_id: "host-session", tool_use_id: "late",
        cwd: workspace, tool_name: "Bash", tool_input: { command: "echo late" },
      }, workspace);
      assert.ok(late);
      session.codexEvents.accept(late);
      assert.deepStrictEqual(session.agentSessions.getSessions(), ended);
      assert.strictEqual(session.isActive(), true);
    } finally {
      subscription.dispose();
      reader.dispose();
      timeline.dispose();
      session.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.rm(storage, { recursive: true, force: true });
    }
  });
});
