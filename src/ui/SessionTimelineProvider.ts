import * as vscode from "vscode";
import type { AgentEvent, AgentSession } from "../session/AgentSession";
import type { SessionManager } from "../session/SessionManager";

export class AgentSessionItem extends vscode.TreeItem {
  constructor(readonly session: AgentSession) {
    super(session.title, session.status === "active"
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = session.id;
    this.description = `${session.status} · ${session.events.length} events`;
    this.tooltip = `${session.agent} / ${session.provider}\n${new Date(session.startedAt).toISOString()}${session.summary ? `\n${session.summary}` : ""}`;
  }
}

export class AgentEventItem extends vscode.TreeItem {
  constructor(readonly event: AgentEvent) {
    super(event.type, vscode.TreeItemCollapsibleState.None);
    this.id = event.id;
    const detail = "uri" in event.payload
      ? vscode.workspace.asRelativePath(vscode.Uri.parse(event.payload.uri))
      : "command" in event.payload ? event.payload.command : "";
    this.description = `${new Date(event.timestamp).toLocaleTimeString()} · ${detail ? `${detail} · ` : ""}${event.source} / ${event.confidence}`;
    this.tooltip = `${new Date(event.timestamp).toISOString()}\nSource: ${event.source}\nConfidence: ${event.confidence}\n${JSON.stringify(event.payload, undefined, 2)}`;
    if (event.source === "filesystem") {
      this.tooltip += "\nA filesystem change was observed; the actor is unknown.";
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
