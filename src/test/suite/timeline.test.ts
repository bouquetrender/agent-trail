import * as assert from "assert";
import * as vscode from "vscode";
import { EventStore } from "../../session/EventStore";
import { SessionManager } from "../../session/SessionManager";
import { AgentEventItem, AgentTurnItem, SessionTimelineProvider } from "../../ui/SessionTimelineProvider";

suite("Session timeline grouping", () => {
  test("separates conversation turns, shows newest first, and refreshes existing groups", () => {
    const sessions = new SessionManager(new EventStore(), () => 1_000);
    const timeline = new SessionTimelineProvider(sessions);
    let refreshes = 0;
    const subscription = timeline.onDidChangeTreeData(() => refreshes++);
    try {
      const session = sessions.startSession({ title: "Multiple turns" });
      for (const [externalTurnId, timestamp] of [
        ["turn-2", 4_000], ["turn-1", 2_000], ["turn-2", 4_500], ["turn-1", 3_000],
      ] as const) {
        sessions.recordEvent({
          type: "file-modified", source: "codex-hook", confidence: "reported",
          externalTurnId, timestamp, payload: { uri: "file:///workspace/source.ts" },
        });
      }
      const before = sessions.getSession(session.id);
      const root = timeline.getChildren()[0];
      const groups = timeline.getChildren(root);
      assert.ok(groups.every((item) => item instanceof AgentTurnItem));
      const turns = groups as AgentTurnItem[];
      assert.deepStrictEqual(turns.map((item) => item.externalTurnId), ["turn-2", "turn-1", undefined]);
      assert.strictEqual(turns[0].label, `${new Date(4_000).toLocaleTimeString()} · Turn 2`);
      assert.strictEqual(turns[1].label, `${new Date(2_000).toLocaleTimeString()} · Turn 1`);
      assert.strictEqual(turns[0].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      assert.strictEqual(turns[1].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.strictEqual(turns[2].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      const events = timeline.getChildren(turns[0]) as AgentEventItem[];
      assert.deepStrictEqual(events.map((item) => item.event.timestamp), [4_500, 4_000]);
      assert.strictEqual(events[0].label, `${new Date(4_500).toLocaleTimeString()} · file-modified`);
      assert.deepStrictEqual(timeline.getChildren(events[0]), []);
      const allEvents = turns.flatMap((turn) => timeline.getChildren(turn)) as AgentEventItem[];
      assert.deepStrictEqual(allEvents.map((item) => item.id).sort(), before?.events.map((event) => event.id).sort());
      assert.deepStrictEqual(sessions.getSession(session.id), before);

      const refreshed = sessions.recordEvent({
        type: "file-created", source: "codex-hook", confidence: "reported",
        externalTurnId: "turn-2", timestamp: 5_000, payload: { uri: "file:///workspace/new.ts" },
      });
      assert.ok(refreshed);
      assert.strictEqual(timeline.getChildren(turns[0])[0].id, refreshed.id);
      assert.deepStrictEqual(timeline.getChildren(root).map((item) => item.id), turns.map((item) => item.id));
      sessions.recordEvent({
        type: "file-deleted", source: "codex-hook", confidence: "reported",
        externalTurnId: "turn-3", timestamp: 6_000, payload: { uri: "file:///workspace/old.ts" },
      });
      const updated = timeline.getChildren(root) as AgentTurnItem[];
      assert.deepStrictEqual(updated.map((item) => item.externalTurnId), ["turn-3", "turn-2", "turn-1", undefined]);
      assert.strictEqual(updated[0].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      assert.strictEqual(updated[1].id, turns[0].id);
      assert.strictEqual(updated[1].description, "3 events");
      assert.strictEqual(refreshes, 7);
    } finally {
      subscription.dispose();
      timeline.dispose();
      sessions.dispose();
    }
  });

  test("orders sessions by latest activity and keeps events without turn IDs separate", () => {
    const sessions = new SessionManager(new EventStore(), () => 10_000);
    const timeline = new SessionTimelineProvider(sessions);
    try {
      const first = sessions.startSession({ title: "First", externalSessionId: "first", startedAt: 1_000 });
      const second = sessions.startSession({ title: "Second", externalSessionId: "second", startedAt: 2_000 });
      for (const [sessionId, timestamp] of [[first.id, 6_000], [second.id, 5_000]] as const) {
        sessions.recordEvent({
          type: "file-modified", source: "codex-hook", confidence: "reported",
          externalTurnId: "shared-turn-id", timestamp, payload: { uri: "file:///workspace/source.ts" },
        }, sessionId);
      }
      const roots = timeline.getChildren();
      assert.deepStrictEqual(roots.map((item) => item.id), [first.id, second.id]);
      const firstTurn = timeline.getChildren(roots[0])[0];
      const secondTurn = timeline.getChildren(roots[1])[0];
      assert.notStrictEqual(firstTurn.id, secondTurn.id);
      assert.strictEqual((timeline.getChildren(firstTurn)[0] as AgentEventItem).event.sessionId, first.id);
      assert.strictEqual((timeline.getChildren(secondTurn)[0] as AgentEventItem).event.sessionId, second.id);

      sessions.recordEvent({
        type: "file-modified", source: "codex-hook", confidence: "reported",
        externalTurnId: "", timestamp: 7_000, payload: { uri: "file:///workspace/legacy.ts" },
      }, second.id);
      sessions.endSession("Done", second.id);
      assert.deepStrictEqual(timeline.getChildren().map((item) => item.id), [second.id, first.id]);
      const groups = timeline.getChildren(roots[1]) as AgentTurnItem[];
      assert.deepStrictEqual(groups.map((item) => item.externalTurnId), ["shared-turn-id", undefined]);
      assert.deepStrictEqual((timeline.getChildren(groups[1]) as AgentEventItem[]).map((item) => item.event.type),
        ["session-end", "file-modified", "session-start"]);
      assert.strictEqual(groups[1].description, "3 events");
      assert.strictEqual(timeline.getChildren(groups[0]).length, 1);
    } finally {
      timeline.dispose();
      sessions.dispose();
    }
  });
});
