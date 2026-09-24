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
import { AgentEventItem, AgentTurnItem, SessionTimelineProvider } from "../../ui/SessionTimelineProvider";
import { codexWrite, connectTestCodex } from "./codexFixture";

suite("Codex Timeline", () => {
  test("records changes and timeline events in a newly added project without reconnecting", async function () {
    this.timeout(15_000);
    await connectTestCodex();
    const config = path.join(process.env.CODEX_HOME!, "hooks.json");
    const installed = await fs.readFile(config, "utf8");
    const project = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "agenttrail-new-project-")));
    const uri = vscode.Uri.file(path.join(project, "new-project.txt"));
    await fs.writeFile(uri.fsPath, "before\n");
    const index = vscode.workspace.workspaceFolders!.length;
    let added = false;
    const changeFolders = async (add: boolean): Promise<ReviewSession> => {
      const start = ReviewSession.prototype.start;
      let timer: NodeJS.Timeout | undefined;
      let changed = false;
      const subscription = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        changed = (add ? event.added : event.removed).some((folder) => folder.uri.fsPath === project);
      });
      try {
        return await new Promise<ReviewSession>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Workspace change did not automatically restart recording")), 5000);
          ReviewSession.prototype.start = function (report) {
            const pending = start.call(this, report);
            if (changed) { void pending.then(() => resolve(this), reject); }
            return pending;
          };
          const accepted = add
            ? vscode.workspace.updateWorkspaceFolders(index, 0, { uri: vscode.Uri.file(project) })
            : vscode.workspace.updateWorkspaceFolders(index, 1);
          assert.ok(accepted, `VS Code rejected ${add ? "adding" : "removing"} the test project`);
          added = add;
        });
      } finally {
        clearTimeout(timer);
        subscription.dispose();
        ReviewSession.prototype.start = start;
      }
    };
    try {
      const session = await changeFolders(true);
      const timeline = new SessionTimelineProvider(session.agentSessions);
      try {
        await codexWrite(uri, "after\n");
        const deadline = Date.now() + 5000;
        while (session.diffs.getFileCount() === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
        assert.ok(lenses.some((lens) => lens.command?.command === "cursorForgery.rejectHunk"));
        const events = timeline.getChildren().flatMap((item) => timeline.getChildren(item))
          .flatMap((item) => timeline.getChildren(item));
        assert.ok(events.some((item) => item instanceof AgentEventItem && item.event.type === "file-modified" &&
          item.event.payload.uri === uri.toString()));
        assert.strictEqual(await fs.readFile(config, "utf8"), installed);
        await changeFolders(false);
        const history = session.agentSessions.getSessions();
        // A removed project's hook must no longer reach this window's timeline.
        const parsed = JSON.parse(installed);
        await new Promise<void>((resolve, reject) => {
          const child = exec(parsed.hooks.PreToolUse[0].hooks[0].command, (error) => error ? reject(error) : resolve());
          child.stdin?.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "removed-project",
            tool_use_id: "call", cwd: project, tool_name: "Bash", tool_input: { command: "npm test" } }));
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.deepStrictEqual(session.agentSessions.getSessions(), history);
      } finally {
        timeline.dispose();
      }
    } finally {
      if (added && vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === project)) {
        await changeFolders(false);
      }
      await fs.rm(project, { recursive: true, force: true });
    }
  });

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
      const config = await installCodexHooks(storage,
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
      const turns = timeline.getChildren(timeline.getChildren()[0]);
      assert.strictEqual(turns.length, 2);
      assert.ok(turns[0] instanceof AgentTurnItem && turns[0].externalTurnId === "host-turn");
      const items = timeline.getChildren(turns[0]);
      assert.strictEqual(items.length, 2);
      const request = items[1];
      const result = items[0];
      assert.ok(request instanceof AgentEventItem && result instanceof AgentEventItem);
      assert.strictEqual(request.label, `${new Date(request.event.timestamp).toLocaleTimeString()} · npm test`);
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
