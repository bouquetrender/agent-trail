import * as assert from "assert";
import type * as vscode from "vscode";
import { EventStore } from "../../session/EventStore";
import { SessionManager } from "../../session/SessionManager";
import { TerminalCollector } from "../../session/TerminalCollector";

class TestEvent<T> {
  readonly listeners = new Set<(event: T) => void>();
  readonly event: vscode.Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  fire(event: T): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

function execution(command = "npm test") {
  return { commandLine: { value: command }, cwd: undefined };
}

suite("TerminalCollector", () => {
  let now: number;
  let sessions: SessionManager;
  let starts: TestEvent<vscode.TerminalShellExecutionStartEvent>;
  let ends: TestEvent<vscode.TerminalShellExecutionEndEvent>;
  let collector: TerminalCollector;

  setup(() => {
    now = 1_000;
    sessions = new SessionManager(new EventStore(), () => now);
    starts = new TestEvent();
    ends = new TestEvent();
    collector = new TerminalCollector(sessions, {
      onDidStartTerminalShellExecution: starts.event,
      onDidEndTerminalShellExecution: ends.event,
    }, () => now);
  });

  teardown(() => {
    collector.dispose();
    sessions.dispose();
  });

  test("records command metadata, elapsed milliseconds and an observed result", () => {
    sessions.startSession({ title: "Terminal activity" });
    const command = execution();
    starts.fire({ execution: command });
    now += 8_200;
    ends.fire({ execution: command, exitCode: 0 });
    const events = sessions.getCurrentSession()?.events ?? [];
    assert.deepStrictEqual(events.map((event) => event.type), ["session-start", "command-start", "command-end"]);
    const start = events[1];
    const end = events[2];
    assert.ok(start.type === "command-start" && end.type === "command-end");
    assert.strictEqual(start.source, "terminal");
    assert.strictEqual(end.source, "terminal");
    assert.strictEqual(start.confidence, "observed");
    assert.strictEqual(end.confidence, "observed");
    assert.strictEqual(start.timestamp, 1_000);
    assert.strictEqual(end.timestamp, 9_200);
    assert.deepStrictEqual(end.payload, {
      commandId: start.payload.commandId,
      command: "npm test",
      cwd: undefined,
      startedAt: 1_000,
      endedAt: 9_200,
      duration: 8_200,
      exitCode: 0,
    });
  });

  test("pairs overlapping identical commands by execution identity", () => {
    sessions.startSession({ title: "Concurrent terminals" });
    const first = execution();
    const second = execution();
    starts.fire({ execution: first });
    now += 100;
    starts.fire({ execution: second });
    now += 200;
    ends.fire({ execution: second, exitCode: 2 });
    now += 300;
    ends.fire({ execution: first, exitCode: 0 });
    const events = sessions.getCurrentSession()?.events ?? [];
    const firstStart = events[1];
    const secondStart = events[2];
    const secondEnd = events[3];
    const firstEnd = events[4];
    assert.ok(firstStart.type === "command-start" && secondStart.type === "command-start");
    assert.ok(firstEnd.type === "command-end" && secondEnd.type === "command-end");
    assert.notStrictEqual(firstStart.payload.commandId, secondStart.payload.commandId);
    assert.strictEqual(firstEnd.payload.commandId, firstStart.payload.commandId);
    assert.strictEqual(secondEnd.payload.commandId, secondStart.payload.commandId);
    assert.strictEqual(firstEnd.payload.duration, 600);
    assert.strictEqual(secondEnd.payload.duration, 200);
    assert.strictEqual(secondEnd.payload.exitCode, 2);
  });

  test("ignores activity outside a session, orphan ends and duplicate notifications", () => {
    const beforeSession = execution();
    starts.fire({ execution: beforeSession });
    sessions.startSession({ title: "Recording" });
    ends.fire({ execution: beforeSession, exitCode: 0 });
    const command = execution();
    starts.fire({ execution: command });
    starts.fire({ execution: command });
    ends.fire({ execution: command, exitCode: 0 });
    ends.fire({ execution: command, exitCode: 0 });
    assert.strictEqual(sessions.getCurrentSession()?.events.length, 3);
  });

  test("does not move unfinished commands into the next session or mutate ended history", () => {
    const first = sessions.startSession({ title: "First" });
    const oldCommand = execution();
    starts.fire({ execution: oldCommand });
    const ended = sessions.endSession();
    const unrecordedCommand = execution();
    starts.fire({ execution: unrecordedCommand });
    sessions.startSession({ title: "Second" });
    ends.fire({ execution: oldCommand, exitCode: 0 });
    ends.fire({ execution: unrecordedCommand, exitCode: 0 });
    assert.deepStrictEqual(sessions.getSession(first.id), ended);
    assert.strictEqual(sessions.getCurrentSession()?.events.length, 1);
    const newCommand = execution();
    starts.fire({ execution: newCommand });
    ends.fire({ execution: newCommand, exitCode: 0 });
    assert.strictEqual(sessions.getCurrentSession()?.events.length, 3);
  });

  test("keeps unknown exit codes and accepts a refined command line at completion", () => {
    sessions.startSession({ title: "Shell metadata" });
    const command = execution("npm");
    starts.fire({ execution: command });
    command.commandLine.value = "npm test";
    ends.fire({ execution: command, exitCode: undefined });
    const events = sessions.getCurrentSession()?.events ?? [];
    const start = events[1];
    const end = events[2];
    assert.ok(start.type === "command-start" && end.type === "command-end");
    assert.strictEqual(start.payload.command, "npm");
    assert.strictEqual(end.payload.command, "npm test");
    assert.strictEqual(end.payload.exitCode, undefined);
  });

  test("unsubscribes and discards pending executions when disposed", () => {
    sessions.startSession({ title: "Disposed" });
    const command = execution();
    starts.fire({ execution: command });
    collector.dispose();
    ends.fire({ execution: command, exitCode: 0 });
    starts.fire({ execution: execution() });
    assert.strictEqual(starts.listeners.size, 0);
    assert.strictEqual(ends.listeners.size, 0);
    assert.strictEqual(sessions.getCurrentSession()?.events.length, 2);
  });

  test("leaves recording disabled when the stable shell execution API is unavailable", () => {
    collector.dispose();
    for (const onDidStartTerminalShellExecution of [undefined, starts.event]) {
      const unsupported = new TerminalCollector(sessions, {
        onDidStartTerminalShellExecution,
        onDidEndTerminalShellExecution: undefined,
      });
      assert.strictEqual(unsupported.supported, false);
      assert.strictEqual(starts.listeners.size, 0);
      unsupported.dispose();
    }
  });
});
