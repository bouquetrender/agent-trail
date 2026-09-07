import * as vscode from "vscode";
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
    this.item.tooltip = "Show changes made since the Agent Review baseline";
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
      this.item.text = "$(sync~spin) Agent Review: Capturing baseline…";
      this.item.tooltip = "Preparing the baseline before watching for agent changes";
      return;
    }
    if (state === "inactive") {
      this.item.text = "$(diff) Agent Review: Not started";
      this.item.tooltip = "Start an Agent Review session";
      return;
    }
    const files = this.diffs.getFileCount();
    const count = this.diffs.getHunkCount();
    this.item.text = `$(diff) ${files} file${files === 1 ? "" : "s"} · ${count} change${count === 1 ? "" : "s"}`;
    this.item.tooltip = "Agent Review is watching for changes. Click to review pending changes.";
  }
}
