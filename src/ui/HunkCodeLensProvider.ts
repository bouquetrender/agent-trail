import * as vscode from "vscode";
import type { DiffService } from "../diff/DiffService";

export class HunkCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly diffSubscription: vscode.Disposable;

  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly diffs: DiffService) {
    this.diffSubscription = diffs.onDidChange(() => this.changeEmitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const fileDiff = this.diffs.get(document.uri);
    if (!fileDiff) {
      return [];
    }

    return fileDiff.hunks.flatMap((hunk) => {
      const line = Math.min(hunk.newStartLine, Math.max(document.lineCount - 1, 0));
      const range = new vscode.Range(line, 0, line, 0);
      const args: [string, string] = [hunk.uri, hunk.id];
      return [
        new vscode.CodeLens(range, {
          title: "$(diff) Before ↔ After",
          command: "cursorForgery.openHunkDiff",
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          title: "$(check) Accept",
          command: "cursorForgery.acceptHunk",
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          title: "$(discard) Reject",
          command: "cursorForgery.rejectHunk",
          arguments: args,
        }),
      ];
    });
  }

  dispose(): void {
    this.diffSubscription.dispose();
    this.changeEmitter.dispose();
  }
}
