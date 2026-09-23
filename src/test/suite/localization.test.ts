import * as assert from "assert";
import * as vscode from "vscode";
import { computeHunks } from "../../diff/computeHunks";
import { DiffService } from "../../diff/DiffService";
import { EventStore } from "../../session/EventStore";
import { MemoryBaselineStore } from "../../session/MemoryBaselineStore";
import { ReviewSession } from "../../session/ReviewSession";
import { SessionManager } from "../../session/SessionManager";
import { AllAgentChangesItem, CurrentTurnItem, FileChangeItem, HunkChangeItem } from "../../ui/ChangeTreeProvider";
import { AgentEventItem, AgentSessionItem } from "../../ui/SessionTimelineProvider";

suite("Review localization", () => {
  let languageDescriptor: PropertyDescriptor;

  setup(() => {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.env, "language");
    assert.ok(descriptor);
    languageDescriptor = descriptor;
  });

  teardown(() => {
    Object.defineProperty(vscode.env, "language", languageDescriptor);
  });

  for (const [language, chinese] of [
    ["zh", true], ["zh-cn", true], ["zh-tw", true], ["zh-hk", true],
    ["en", false], ["ja", false], ["de", false],
  ] as const) {
    test(`renders review and timeline text for ${language} while preserving commands and data`, () => {
      Object.defineProperty(vscode.env, "language", { value: language, configurable: true });
      assert.strictEqual(new CurrentTurnItem().label, chinese ? "待审查" : "Pending Review");
      const history = new AllAgentChangesItem();
      assert.strictEqual(history.label, chinese ? "历史记录" : "History");
      assert.strictEqual(history.description, chinese ? "仅供参考" : "Reference only");
      const uri = vscode.Uri.file("/workspace/source.ts");
      const hunks = computeHunks(uri.toString(), "before\n", "after\n");
      const file = new FileChangeItem(uri, { uri: uri.toString(), hunks });
      assert.strictEqual(file.description, chinese ? "1 处变更" : "1 hunk");
      assert.strictEqual(file.command?.command, "cursorForgery.openHunk");
      const hunk = new HunkChangeItem(uri, hunks[0]);
      assert.strictEqual(hunk.command?.title, chinese ? "打开变更" : "Open Change");
      assert.strictEqual(hunk.description, "after");
      assert.strictEqual(hunk.command?.command, "cursorForgery.openHunk");
      const sessions = new SessionManager(new EventStore(), () => 1_000);
      try {
        sessions.startSession({ title: "My custom session" });
        const event = sessions.recordEvent({
          type: "command-end",
          source: "terminal",
          confidence: "observed",
          timestamp: 9_200,
          payload: {
            commandId: "test-command",
            command: "npm test",
            cwd: "/workspace/project",
            startedAt: 1_000,
            endedAt: 9_200,
            duration: 8_200,
            exitCode: 0,
          },
        });
        assert.ok(event);
        const item = new AgentEventItem(event);
        assert.strictEqual(item.label, "npm test");
        assert.strictEqual(item.description, chinese
          ? "命令结束 · 工作目录: /workspace/project · 耗时: 8.2秒 · 退出码: 0"
          : "command-end · cwd: /workspace/project · duration: 8.2s · exit: 0");
        assert.ok(String(item.tooltip).includes(chinese ? "已观察到终端活动，执行者未知。" : "Observed terminal activity; the actor is unknown."));
        assert.strictEqual(item.event.type, "command-end");
        assert.strictEqual(item.event.source, "terminal");
        const fileEvent = sessions.recordEvent({
          type: "file-modified", source: "filesystem", confidence: "observed",
          payload: { uri: uri.toString() },
        });
        assert.ok(fileEvent);
        const fileItem = new AgentEventItem(fileEvent);
        assert.strictEqual(fileItem.label, chinese ? "文件修改" : "file-modified");
        assert.ok(String(fileItem.tooltip).includes(chinese ? "来源: 文件系统" : "Source: filesystem"));
        const active = sessions.getCurrentSession();
        assert.ok(active);
        const activeItem = new AgentSessionItem(active);
        assert.strictEqual(activeItem.label, "My custom session");
        assert.strictEqual(activeItem.description, chinese ? "进行中 · 3 个事件" : "active · 3 events");
        assert.ok(String(activeItem.tooltip).startsWith(chinese ? "未知 / 未知" : "unknown / unknown"));
        const ended = sessions.endSession();
        assert.ok(ended);
        assert.strictEqual(new AgentSessionItem(ended).description, chinese ? "已结束 · 4 个事件" : "ended · 4 events");
      } finally {
        sessions.dispose();
      }
    });
  }

  test("gives automatically started Chinese sessions a Chinese title", async () => {
    Object.defineProperty(vscode.env, "language", { value: "zh-cn", configurable: true });
    const store = new MemoryBaselineStore();
    const session = new ReviewSession(store, new DiffService(store));
    try {
      await session.start();
      assert.strictEqual(session.agentSessions.getCurrentSession()?.title, "工作区会话");
    } finally {
      session.dispose();
    }
  });
});
