import * as vscode from "vscode";
import type { DiffService } from "../diff/DiffService";
import type { AgentFileChangeKind, DiffHunk, FileDiff } from "../model";

export class CurrentTurnItem extends vscode.TreeItem {
  constructor() {
    super("Current Turn", vscode.TreeItemCollapsibleState.Expanded);
  }
}

export class AllAgentChangesItem extends vscode.TreeItem {
  constructor() {
    super("All Agent Changes", vscode.TreeItemCollapsibleState.Collapsed);
  }
}

export class FileChangeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(
    readonly uri: vscode.Uri,
    readonly fileDiff: FileDiff,
    readonly reviewable = true,
    readonly kind: AgentFileChangeKind = "modified",
  ) {
    super(
      vscode.workspace.asRelativePath(uri),
      kind === "modified"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = reviewable
      ? "cursorForgery.file"
      : "cursorForgery.historyFile";
    this.resourceUri = uri;
    if (kind === "modified") {
      this.description = `${fileDiff.hunks.length} hunk${
        fileDiff.hunks.length === 1 ? "" : "s"
      }`;
      this.tooltip = uri.fsPath;
    } else {
      this.description = kind === "added" ? "Added" : "Deleted";
      this.tooltip = `${uri.fsPath} (${this.description})`;
    }
    const firstHunk = fileDiff.hunks[0];
    if (firstHunk) {
      this.command = {
        command: "cursorForgery.openHunk",
        title: "Open First Change",
        arguments: [uri.toString(), firstHunk.id],
      };
    }
  }
}

export class HunkChangeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(
    readonly uri: vscode.Uri,
    readonly hunk: DiffHunk,
    readonly reviewable = true,
  ) {
    super(formatHunkLabel(hunk), vscode.TreeItemCollapsibleState.None);
    this.contextValue = reviewable
      ? "cursorForgery.hunk"
      : "cursorForgery.historyHunk";
    this.description = summarizeHunk(hunk);
    this.command = {
      command: "cursorForgery.openHunk",
      title: "Open Change",
      arguments: [uri.toString(), hunk.id],
    };
    if (!reviewable) {
      this.iconPath = new vscode.ThemeIcon("diff");
    }
  }

  get hunkId(): string {
    return this.hunk.id;
  }
}

type ChangeTreeItem =
  | CurrentTurnItem
  | AllAgentChangesItem
  | FileChangeItem
  | HunkChangeItem;

export class ChangeTreeProvider
  implements vscode.TreeDataProvider<ChangeTreeItem>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    ChangeTreeItem | undefined | void
  >();
  private readonly diffSubscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly diffs: DiffService) {
    this.diffSubscription = diffs.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: ChangeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChangeTreeItem): ChangeTreeItem[] {
    if (!element) {
      return this.diffs.hasAgentChanges()
        ? [new CurrentTurnItem(), new AllAgentChangesItem()]
        : [];
    }

    if (element instanceof CurrentTurnItem) {
      return this.diffs.getAll().map((fileDiff) => {
        const uri = vscode.Uri.parse(fileDiff.uri);
        return new FileChangeItem(uri, fileDiff);
      });
    }

    if (element instanceof AllAgentChangesItem) {
      return this.diffs.getAllAgentChanges().map((fileChange) => {
        const uri = vscode.Uri.parse(fileChange.uri);
        return new FileChangeItem(uri, fileChange, false, fileChange.kind);
      });
    }

    if (element instanceof FileChangeItem) {
      return element.fileDiff.hunks.map(
        (hunk) => new HunkChangeItem(element.uri, hunk, element.reviewable),
      );
    }

    return [];
  }

  dispose(): void {
    this.diffSubscription.dispose();
    this.changeEmitter.dispose();
  }
}

function formatHunkLabel(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStartLine + 1},${hunk.oldLineCount} +${
    hunk.newStartLine + 1
  },${hunk.newLineCount} @@`;
}

function summarizeHunk(hunk: DiffHunk): string {
  const candidate = hunk.currentText || hunk.baselineText;
  const firstLine = candidate.split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}
