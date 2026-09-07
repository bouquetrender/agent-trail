import * as vscode from "vscode";
import type { DiffService } from "../diff/DiffService";

export class ChangeStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly diffSubscription: vscode.Disposable;

  constructor(private readonly diffs: DiffService) {
    this.item.command = "cursorForgery.changes.focus";
    this.item.tooltip = "Show changes made since the Agent Review baseline";
    this.diffSubscription = diffs.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  dispose(): void {
    this.diffSubscription.dispose();
    this.item.dispose();
  }

  private update(): void {
    const count = this.diffs.getHunkCount();
    this.item.text = `$(diff) Agent Changes: ${count}`;
  }
}
