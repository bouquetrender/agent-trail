import * as assert from "assert";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import * as vscode from "vscode";
import { EventStore } from "../../session/EventStore";
import { SessionManager } from "../../session/SessionManager";
import { TerminalCollector } from "../../session/TerminalCollector";
import { AgentEventItem, SessionTimelineProvider } from "../../ui/SessionTimelineProvider";

suite("Terminal Timeline", () => {
  test("shows npm test, its starting cwd, 8.2s duration and exit 0 with refresh notifications", () => {
    let now = 1_000;
    const sessions = new SessionManager(new EventStore(), () => now);
    const starts = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
    const ends = new vscode.EventEmitter<vscode.TerminalShellExecutionEndEvent>();
    const collector = new TerminalCollector(sessions, {
      onDidStartTerminalShellExecution: starts.event,
      onDidEndTerminalShellExecution: ends.event,
    }, () => now);
    const timeline = new SessionTimelineProvider(sessions);
    let refreshes = 0;
    const subscription = timeline.onDidChangeTreeData(() => refreshes++);
    try {
      sessions.startSession({ title: "Observed commands" });
      const root = timeline.getChildren()[0];
      const cwd = vscode.Uri.file("/workspace/project");
      const execution = { commandLine: { value: "npm test" }, cwd };
      starts.fire({ execution });
      const startItem = timeline.getChildren(root)[1];
      assert.ok(startItem instanceof AgentEventItem);
      assert.strictEqual(startItem.event.type, "command-start");
      assert.strictEqual(startItem.label, "npm test");
      assert.match(String(startItem.tooltip), /Observed terminal activity/);
      now += 8_200;
      execution.cwd = vscode.Uri.file("/workspace/other");
      ends.fire({ execution, exitCode: 0 });
      const endItem = timeline.getChildren(root)[2];
      assert.ok(endItem instanceof AgentEventItem);
      assert.strictEqual(endItem.event.type, "command-end");
      assert.strictEqual(endItem.label, "npm test");
      assert.strictEqual(endItem.description, `command-end · cwd: ${cwd.fsPath} · duration: 8.2s · exit: 0`);
      assert.match(String(endItem.tooltip), /Observed terminal activity; the actor is unknown/);
      assert.match(String(endItem.tooltip), /startedAt: .*\nendedAt: .*\nduration: 8.2s\nexit: 0/);
      assert.strictEqual(refreshes, 3);
    } finally {
      subscription.dispose();
      timeline.dispose();
      collector.dispose();
      starts.dispose();
      ends.dispose();
      sessions.dispose();
    }
  });

  test("keeps remote cwd identities and displays missing cwd and exit code as unknown", () => {
    const sessions = new SessionManager(new EventStore());
    const starts = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
    const ends = new vscode.EventEmitter<vscode.TerminalShellExecutionEndEvent>();
    const collector = new TerminalCollector(sessions, {
      onDidStartTerminalShellExecution: starts.event,
      onDidEndTerminalShellExecution: ends.event,
    });
    try {
      sessions.startSession({ title: "Cwd reporting" });
      for (const cwd of [vscode.Uri.parse("vscode-remote://ssh-remote+host/project"), undefined]) {
        const execution = { commandLine: { value: "npm test" }, cwd };
        starts.fire({ execution });
        ends.fire({ execution, exitCode: undefined });
        const events = sessions.getCurrentSession()?.events ?? [];
        const end = events[events.length - 1];
        assert.ok(end.type === "command-end");
        assert.strictEqual(end.payload.cwd, cwd?.toString());
        const item = new AgentEventItem(end);
        assert.ok(String(item.description).includes(`cwd: ${cwd?.toString() ?? "unknown"}`));
        assert.match(String(item.description), /exit: unknown/);
      }
    } finally {
      collector.dispose();
      starts.dispose();
      ends.dispose();
      sessions.dispose();
    }
  });

  test("observes npm test in a real shell integration terminal", async function () {
    this.timeout(25_000);
    const onDidChangeIntegration = vscode.window.onDidChangeTerminalShellIntegration;
    if (!onDidChangeIntegration || !vscode.window.onDidStartTerminalShellExecution ||
      !vscode.window.onDidEndTerminalShellExecution || process.platform === "win32") {
      this.skip();
    }
    const fixture = await fs.mkdtemp(path.join(tmpdir(), "agent-trail-terminal-"));
    const sessions = new SessionManager(new EventStore());
    const collector = new TerminalCollector(sessions, vscode.window);
    const subscriptions: vscode.Disposable[] = [];
    const timers: NodeJS.Timeout[] = [];
    let terminal: vscode.Terminal | undefined;
    try {
      await fs.writeFile(path.join(fixture, "package.json"), JSON.stringify({
        name: "terminal-observation-fixture",
        version: "1.0.0",
        scripts: { test: "node -e \"setTimeout(() => {}, 100)\"" },
      }));
      sessions.startSession({ title: "Real terminal activity" });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Shell integration did not activate")), 10_000);
        timers.push(timer);
        subscriptions.push(onDidChangeIntegration(({ terminal: changed }) => {
          if (changed === terminal) {
            clearTimeout(timer);
            resolve();
          }
        }));
      });
      terminal = vscode.window.createTerminal({
        name: "AgentTrail terminal test",
        shellPath: "/bin/bash",
        shellArgs: ["--noprofile", "--norc"],
        cwd: fixture,
      });
      terminal.show(true);
      const integrationScript = path.join(vscode.env.appRoot,
        "out/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh");
      terminal.sendText(`. '${integrationScript.replace(/'/g, "'\\''")}'`);
      await ready;
      const finished = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("npm test completion was not observed")), 10_000);
        timers.push(timer);
        subscriptions.push(sessions.onDidChange(() => {
          if (sessions.getCurrentSession()?.events.some((event) =>
            event.type === "command-end" && event.payload.command === "npm test")) {
            clearTimeout(timer);
            resolve();
          }
        }));
      });
      terminal.sendText("npm test");
      await finished;
      const events = sessions.getCurrentSession()?.events ?? [];
      const start = events.find((event) => event.type === "command-start" && event.payload.command === "npm test");
      const end = events.find((event) => event.type === "command-end" && event.payload.command === "npm test");
      assert.ok(start?.type === "command-start" && end?.type === "command-end");
      assert.strictEqual(end.payload.commandId, start.payload.commandId);
      assert.strictEqual(await fs.realpath(end.payload.cwd ?? ""), await fs.realpath(fixture));
      assert.strictEqual(end.payload.exitCode, 0);
      assert.ok(end.payload.duration > 0);
      assert.strictEqual(end.payload.duration, end.payload.endedAt - end.payload.startedAt);
      const item = new AgentEventItem(end);
      assert.strictEqual(item.label, "npm test");
      assert.match(String(item.description), /duration: \d+\.\ds · exit: 0/);
      console.log(`Observed terminal activity: ${item.label} · ${item.description}`);
    } finally {
      timers.forEach(clearTimeout);
      subscriptions.forEach((subscription) => subscription.dispose());
      terminal?.dispose();
      collector.dispose();
      sessions.dispose();
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });
});
