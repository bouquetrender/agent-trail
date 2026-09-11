import * as assert from "assert";
import { EventStore } from "../../session/EventStore";
import { SessionManager } from "../../session/SessionManager";

suite("Agent Sessions", () => {
  test("records all event types chronologically between lifecycle events", () => {
    let now = 100;
    const store = new EventStore();
    const manager = new SessionManager(store, () => now);
    const started = manager.startSession({ title: "Implement feature", agent: "Codex", provider: "OpenAI" });
    manager.recordEvent({ type: "command-start", timestamp: 120, source: "agent", confidence: "reported", payload: { commandId: "cmd-1", command: "npm test" } });
    manager.recordEvent({ type: "file-created", timestamp: 110, source: "filesystem", confidence: "observed", payload: { uri: "file:///new.txt" } });
    manager.recordEvent({ type: "file-modified", timestamp: 130, source: "filesystem", confidence: "observed", payload: { uri: "file:///new.txt" } });
    manager.recordEvent({ type: "file-deleted", timestamp: 130, source: "filesystem", confidence: "observed", payload: { uri: "file:///new.txt" } });
    manager.recordEvent({ type: "command-end", timestamp: 140, source: "agent", confidence: "reported", payload: { commandId: "cmd-1", exitCode: 0 } });
    now = 150;
    const ended = manager.endSession("Implemented and tested");
    assert.ok(ended);
    assert.deepStrictEqual(ended.events.map((event) => event.type), [
      "session-start", "file-created", "command-start", "file-modified",
      "file-deleted", "command-end", "session-end",
    ]);
    assert.strictEqual(ended.events.every((event) => event.sessionId === started.id), true);
    assert.strictEqual(new Set(ended.events.map((event) => event.id)).size, 7);
    assert.strictEqual(ended.status, "ended");
    assert.strictEqual(ended.startedAt, 100);
    assert.strictEqual(ended.endedAt, 150);
    assert.strictEqual(ended.summary, "Implemented and tested");
    assert.strictEqual(manager.getCurrentSession(), undefined);
    assert.deepStrictEqual(store.getEvents(started.id), ended.events);
    assert.strictEqual(started.events.length, 1);
    manager.dispose();
  });

  test("isolates sessions, disallows overlap and ignores late writes", () => {
    const manager = new SessionManager(new EventStore());
    const event = { type: "file-modified", source: "correlation", confidence: "inferred", payload: { uri: "file:///a.txt" } } as const;
    assert.strictEqual(manager.recordEvent(event), undefined);
    const first = manager.startSession({ title: "First" });
    assert.strictEqual(first.agent, "unknown");
    assert.strictEqual(first.provider, "unknown");
    assert.throws(() => manager.startSession({ title: "Overlapping" }), /End the current/);
    manager.recordEvent(event);
    manager.endSession();
    assert.strictEqual(manager.endSession(), undefined);
    const second = manager.startSession({ title: "Second" });
    assert.strictEqual(manager.recordEvent(event, first.id), undefined);
    assert.strictEqual(manager.getSession(first.id)?.events.length, 3);
    assert.strictEqual(manager.getSession(second.id)?.events.length, 1);
    assert.strictEqual(manager.getSessions().length, 2);
    assert.strictEqual(manager.getSession("missing"), undefined);
    manager.dispose();
  });

  test("notifies readers after state changes and retains immutable snapshots", () => {
    const store = new EventStore();
    const manager = new SessionManager(store, () => 100);
    const states: Array<string | undefined> = [];
    const subscription = manager.onDidChange(() => states.push(manager.getCurrentSession()?.status));
    const session = manager.startSession({ title: "Snapshot" });
    manager.recordEvent({ type: "file-modified", source: "filesystem", confidence: "observed", payload: { uri: "file:///a.txt" } });
    assert.strictEqual(session.events.length, 1);
    const events = store.getEvents(session.id);
    assert.ok(Object.isFrozen(events));
    assert.ok(Object.isFrozen(events[1]));
    assert.ok(Object.isFrozen(events[1].payload));
    manager.endSession();
    assert.deepStrictEqual(states, ["active", "active", undefined]);
    subscription.dispose();
    manager.startSession({ title: "Unsubscribed" });
    assert.strictEqual(states.length, 3);
    manager.dispose();
  });

  test("rejects invalid timestamps and keeps end last if the clock moves backwards", () => {
    const manager = new SessionManager(new EventStore(), () => 100);
    manager.startSession({ title: "Clock" });
    for (const timestamp of [99, NaN, Infinity]) {
      assert.throws(() => manager.recordEvent({ type: "file-modified", timestamp, source: "filesystem", confidence: "observed", payload: { uri: "file:///a.txt" } }), /timestamp/);
    }
    manager.recordEvent({ type: "file-modified", timestamp: 150, source: "filesystem", confidence: "observed", payload: { uri: "file:///a.txt" } });
    assert.strictEqual(manager.endSession()?.endedAt, 150);
    manager.dispose();
  });
});
