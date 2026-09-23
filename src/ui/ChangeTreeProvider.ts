import * as vscode from "vscode";
import { localize } from "../localize";
import type { DiffService } from "../diff/DiffService";
import type { AgentFileChangeKind, DiffHunk, FileDiff } from "../model";

export class CurrentTurnItem extends vscode.TreeItem {
  constructor() {
    super(localize("Pending Review", "待审查"), vscode.TreeItemCollapsibleState.Expanded);
    this.id = "pending";
  }
}

export class AllAgentChangesItem extends vscode.TreeItem {
  constructor() {
    super(localize("History", "历史记录"), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "history";
    this.description = localize("Reference only", "仅供参考");
    this.tooltip = localize("Recorded changes from this session, including reviewed changes. Opens the current file; historical line positions may have shifted.", "本次会话的变更记录，包含已审查的变更。点击打开当前文件，历史行号可能已经变化。");
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
    this.id = `${reviewable ? "pending" : "history"}:${kind}:${uri.toString()}`;
    this.resourceUri = uri;
    if (kind === "modified") {
      this.description = localize(`${fileDiff.hunks.length} hunk${
        fileDiff.hunks.length === 1 ? "" : "s"
      }`, `${fileDiff.hunks.length} 处变更`);
      this.tooltip = uri.fsPath;
    } else {
      this.description = kind === "added" ? localize("Added", "新增") : localize("Deleted", "删除");
      this.tooltip = `${uri.fsPath} (${this.description})`;
    }
    if (!reviewable) {
      this.tooltip = `${this.tooltip}\n${localize("Reference only. Opens the current file; historical line positions may have shifted.", "仅供参考。点击打开当前文件，历史行号可能已经变化。")}`;
    } else {
      this.tooltip = `${this.tooltip}\n${localize("Accept advances the review baseline; editor Undo cannot undo acceptance.", "接受变更会更新审查基线，编辑器的撤销操作无法撤销接受。")}`;
    }
    const firstHunk = fileDiff.hunks[0];
    if (firstHunk) {
      this.command = {
        command: "cursorForgery.openHunk",
        title: localize("Open First Change", "打开首处变更"),
        arguments: [uri.toString(), firstHunk.id, !reviewable],
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
    this.id = `${reviewable ? "pending" : "history"}:${uri.toString()}:${hunk.id}`;
    this.description = summarizeHunk(hunk);
    this.command = {
      command: "cursorForgery.openHunk",
      title: localize("Open Change", "打开变更"),
      arguments: [uri.toString(), hunk.id, !reviewable],
    };
    if (!reviewable) {
      this.iconPath = new vscode.ThemeIcon("diff");
      this.tooltip = localize("Reference only. Opens the current file; historical line positions may have shifted.", "仅供参考。点击打开当前文件，历史行号可能已经变化。");
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
