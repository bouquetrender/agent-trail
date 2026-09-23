import * as vscode from "vscode";
import { localize } from "../localize";
import type { DiffService } from "../diff/DiffService";
import type { ReviewSession } from "../session/ReviewSession";

export class ChangeStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly diffSubscription: vscode.Disposable;
  private readonly sessionSubscription: vscode.Disposable;

  constructor(
    private readonly diffs: DiffService,
    private readonly session: ReviewSession,
  ) {
    this.item.command = "cursorForgery.changes.focus";
    this.item.tooltip = localize("Show changes made since the AgentTrail baseline", "查看审查基线之后的变更");
    this.diffSubscription = diffs.onDidChange(() => this.update());
    this.sessionSubscription = session.onDidChangeState(() => this.update());
    this.update();
    this.item.show();
  }

  dispose(): void {
    this.diffSubscription.dispose();
    this.sessionSubscription.dispose();
    this.item.dispose();
  }

  private update(): void {
    const state = this.session.getState();
    this.item.command = state === "inactive"
      ? "cursorForgery.startSession"
      : "cursorForgery.changes.focus";
    if (state === "capturing") {
      this.item.text = localize("$(sync~spin) AgentTrail: Capturing baseline…", "$(sync~spin) AgentTrail：正在捕获基线…");
      this.item.tooltip = localize("Preparing the baseline before watching for agent changes", "正在准备基线，完成后开始监听变更");
      return;
    }
    if (state === "inactive") {
      this.item.text = localize("$(diff) AgentTrail: Not started", "$(diff) AgentTrail：未开始");
      this.item.tooltip = localize("Start an AgentTrail session", "开始审查会话");
      return;
    }
    const files = this.diffs.getFileCount();
    const count = this.diffs.getHunkCount();
    this.item.text = localize(`$(diff) ${files} file${files === 1 ? "" : "s"} · ${count} change${count === 1 ? "" : "s"}`, `$(diff) ${files} 个文件 · ${count} 处变更`);
    this.item.tooltip = localize("AgentTrail is watching for changes. Click to review pending changes.", "正在监听变更，点击查看待审查变更。");
  }
}
