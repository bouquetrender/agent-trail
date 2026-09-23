import * as vscode from "vscode";
import { localize } from "../localize";
import type { AgentEvent, AgentSession } from "../session/AgentSession";
import type { SessionManager } from "../session/SessionManager";

const eventLabels: Record<AgentEvent["type"], string> = {
  "tool-call": "工具调用",
  "session-start": "会话开始",
  "session-end": "会话结束",
  "file-created": "文件新增",
  "file-modified": "文件修改",
  "file-deleted": "文件删除",
  "command-start": "命令开始",
  "command-end": "命令结束",
};

const confidenceLabels: Record<AgentEvent["confidence"], string> = {
  observed: "已观察",
  reported: "已上报",
  inferred: "推断",
};

function sourceLabel(source: string): string {
  switch (source) {
    case "filesystem": return localize(source, "文件系统");
    case "terminal": return localize(source, "终端");
    case "extension": return localize(source, "扩展");
    case "codex-hook": return "Codex hook";
    case "unknown": return localize(source, "未知");
    default: return source;
  }
}

export class AgentSessionItem extends vscode.TreeItem {
  constructor(readonly session: AgentSession) {
    super(session.title, session.status === "active"
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = session.id;
    const status = session.status === "active" ? localize("active", "进行中") : localize("ended", "已结束");
    this.description = `${status} · ${localize(`${session.events.length} events`, `${session.events.length} 个事件`)}`;
    const agent = session.agent === "unknown" ? localize("unknown", "未知") : session.agent;
    const provider = session.provider === "unknown" ? localize("unknown", "未知") : session.provider;
    this.tooltip = `${agent} / ${provider}\n${new Date(session.startedAt).toISOString()}${session.externalSessionId ? `\nCodex session: ${session.externalSessionId}` : ""}${session.summary ? `\n${session.summary}` : ""}`;
  }
}

export class AgentEventItem extends vscode.TreeItem {
  constructor(readonly event: AgentEvent) {
    super(localize(event.type, eventLabels[event.type]), vscode.TreeItemCollapsibleState.None);
    this.id = event.id;
    const source = sourceLabel(event.source);
    const confidence = localize(event.confidence, confidenceLabels[event.confidence]);
    const provenance = `${localize("Source", "来源")}: ${source}\n${localize("Confidence", "可信来源")}: ${confidence}`;
    if (event.type === "tool-call") {
      const payload = event.payload;
      const status = payload.phase === "requested"
        ? localize("Requested; execution not confirmed", "已请求，尚未确认执行")
        : payload.outcome === "succeeded" ? localize("Succeeded", "成功")
          : payload.outcome === "failed" ? localize("Failed", "失败")
            : localize("Result received; outcome unknown", "已返回结果，执行状态未知");
      this.label = payload.command || payload.tool;
      const details = [status, `${localize("cwd", "工作目录")}: ${payload.cwd}`];
      if (payload.phase === "completed") {
        details.push(`${localize("exit", "退出码")}: ${payload.exitCode ?? localize("unknown", "未知")}`);
        details.push(`${localize("duration", "耗时")}: ${payload.durationMs === undefined
          ? localize("unknown", "未知") : `${(payload.durationMs / 1000).toFixed(1)}${localize("s", "秒")}`}`);
      }
      this.description = details.join(" · ");
      this.tooltip = [String(this.label), ...details, provenance,
        `${localize("Time", "时间")}: ${new Date(event.timestamp).toISOString()}`,
        `Codex turn: ${event.externalTurnId ?? ""}`, `Codex tool call: ${event.externalCallId ?? ""}`,
      ].join("\n");
      return;
    }
    if (event.type === "command-start" || event.type === "command-end") {
      const payload = event.payload;
      const cwd = `${localize("cwd", "工作目录")}: ${payload.cwd ?? localize("unknown", "未知")}`;
      const result = event.type === "command-end"
        ? `${localize("duration", "耗时")}: ${(event.payload.duration / 1000).toFixed(1)}${localize("s", "秒")} · ${localize("exit", "退出码")}: ${event.payload.exitCode ?? localize("unknown", "未知")}`
        : localize("start observed", "已观察到开始执行");
      this.label = payload.command || localize("(command unavailable)", "（无法获取命令）");
      this.description = `${localize(event.type, eventLabels[event.type])} · ${cwd} · ${result}`;
      this.tooltip = [
        payload.command || localize("(command unavailable)", "（无法获取命令）"),
        ...(event.source === "terminal" ? [localize("Observed terminal activity; the actor is unknown.", "已观察到终端活动，执行者未知。")] : []),
        provenance,
        cwd,
        `${localize("startedAt", "开始时间")}: ${new Date(payload.startedAt).toISOString()}`,
        ...(event.type === "command-end" ? [
          `${localize("endedAt", "结束时间")}: ${new Date(event.payload.endedAt).toISOString()}`,
          `${localize("duration", "耗时")}: ${(event.payload.duration / 1000).toFixed(1)}${localize("s", "秒")}`,
          `${localize("exit", "退出码")}: ${event.payload.exitCode ?? localize("unknown", "未知")}`,
        ] : [localize("Command start observed.", "已观察到命令开始执行。")]),
      ].join("\n");
      return;
    }
    const detail = "uri" in event.payload
      ? vscode.workspace.asRelativePath(vscode.Uri.parse(event.payload.uri))
      : "";
    this.description = `${new Date(event.timestamp).toLocaleTimeString()} · ${detail ? `${detail} · ` : ""}${source} / ${confidence}`;
    const payloadDetail = event.type === "session-start"
      ? `${localize("Title", "标题")}: ${event.payload.title}`
      : event.type === "session-end"
        ? `${localize("Summary", "摘要")}: ${event.payload.summary}`
        : `${localize("File", "文件")}: ${event.payload.uri}`;
    this.tooltip = `${new Date(event.timestamp).toISOString()}\n${provenance}\n${payloadDetail}`;
    if (event.source === "filesystem") {
      this.tooltip += `\n${localize("A filesystem change was observed; the actor is unknown.", "已观察到文件系统变化，执行者未知。")}`;
    }
  }
}

type TimelineItem = AgentSessionItem | AgentEventItem;

export class SessionTimelineProvider
  implements vscode.TreeDataProvider<TimelineItem>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly sessions: SessionManager) {
    this.subscription = sessions.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: TimelineItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TimelineItem): TimelineItem[] {
    if (!element) {
      return this.sessions.getSessions().map((session) => new AgentSessionItem(session));
    }
    if (element instanceof AgentSessionItem) {
      return this.sessions.getSession(element.session.id)?.events.map(
        (event) => new AgentEventItem(event),
      ) ?? [];
    }
    return [];
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}
