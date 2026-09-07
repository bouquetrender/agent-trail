import * as vscode from "vscode";
import type { DiffService } from "../diff/DiffService";
import { mergeAcceptedHunk } from "../diff/computeHunks";
import type { BaselineStore } from "../session/BaselineStore";
import type { ReviewSession } from "../session/ReviewSession";
import type { BaselineContentProvider } from "../ui/BaselineContentProvider";

export class HunkCommands {
  constructor(
    private readonly baselineStore: BaselineStore,
    private readonly diffs: DiffService,
    private readonly session: ReviewSession,
    private readonly baselineProvider: BaselineContentProvider,
  ) {}

  async acceptHunk(target?: HunkCommandTarget | string, hunkId?: string): Promise<void> {
    const resolved = this.resolveHunk(target, hunkId);
    if (!resolved) {
      return this.showNoHunkMessage();
    }
    const { uri } = resolved;
    await this.session.recompute(uri);
    const hunk = this.diffs.getHunk(uri, resolved.hunk.id);
    const baseline = await this.baselineStore.get(uri);
    if (!hunk || baseline === undefined) {
      return;
    }

    await this.baselineStore.set(uri, mergeAcceptedHunk(baseline, hunk));
    this.baselineProvider.refresh(uri);
    await this.session.recompute(uri);
  }

  async rejectHunk(target?: HunkCommandTarget | string, hunkId?: string): Promise<void> {
    const resolved = this.resolveHunk(target, hunkId);
    if (!resolved) {
      return this.showNoHunkMessage();
    }
    const { uri } = resolved;
    await this.session.recompute(uri);
    const hunk = this.diffs.getHunk(uri, resolved.hunk.id);
    if (!hunk) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        document.positionAt(hunk.currentStartOffset),
        document.positionAt(hunk.currentEndOffset),
      ),
      hunk.baselineText,
    );
    const applied = await this.session.applyReviewEdit(edit, [uri]);
    if (!applied) {
      void vscode.window.showErrorMessage("Agent Review could not reject this hunk.");
      return;
    }
    await this.session.recompute(uri);
  }

  async requestHunkChange(
    target?: HunkCommandTarget | string,
    hunkId?: string,
  ): Promise<void> {
    const resolved = this.resolveHunk(target, hunkId);
    if (!resolved) {
      return this.showNoHunkMessage();
    }
    if (!vscode.extensions.getExtension("openai.chatgpt")) {
      void vscode.window.showInformationMessage(
        "Install and enable the Codex extension to request a change.",
      );
      return;
    }

    const { uri } = resolved;
    await this.session.recompute(uri);
    const hunk = this.diffs.getHunk(uri, resolved.hunk.id);
    if (!hunk) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
    });
    editor.selection = new vscode.Selection(
      document.positionAt(hunk.currentStartOffset),
      document.positionAt(hunk.currentEndOffset),
    );
    await vscode.commands.executeCommand("chatgpt.addToThread");
  }

  async openHunkDiff(target?: HunkCommandTarget | string, hunkId?: string): Promise<void> {
    const resolved = this.resolveHunk(target, hunkId);
    if (!resolved) {
      return this.showNoHunkMessage();
    }
    const { uri } = resolved;
    await this.session.recompute(uri);
    const hunk = this.diffs.getHunk(uri, resolved.hunk.id);
    if (!hunk) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const line = Math.min(hunk.newStartLine, Math.max(document.lineCount - 1, 0));
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.baselineProvider.createUri(uri),
      uri,
      `${vscode.workspace.asRelativePath(uri)} (Baseline ↔ Current)`,
      {
        preview: true,
        selection: new vscode.Range(line, 0, line, 0),
      },
    );
  }

  async openHunk(
    target?: HunkCommandTarget | string,
    hunkId?: string,
    historical = false,
  ): Promise<void> {
    const resolved =
      this.resolveHunk(target, hunkId) ??
      this.resolveHistoricalHunk(target, hunkId);
    if (!resolved) {
      return this.showNoHunkMessage();
    }
    const { uri } = resolved;
    await this.session.recompute(uri);
    const hunk =
      this.diffs.getHunk(uri, resolved.hunk.id) ??
      this.diffs.getHistoricalHunk(uri, resolved.hunk.id);
    if (!hunk) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
    });
    const line = Math.min(
      hunk.newStartLine,
      Math.max(document.lineCount - 1, 0),
    );
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    if (historical || !this.diffs.getHunk(uri, hunk.id)) {
      void vscode.window.showInformationMessage(
        "History is for reference only. Showing the current file; the recorded line position may have shifted.",
      );
    }
  }

  private resolveHunk(target?: HunkCommandTarget | string, hunkId?: string) {
    if (typeof target === "string" && hunkId) {
      const uri = vscode.Uri.parse(target);
      const hunk = this.diffs.getHunk(uri, hunkId);
      return hunk ? { uri, hunk } : undefined;
    }
    if (typeof target === "object" && target.hunkId) {
      const hunk = this.diffs.getHunk(target.uri, target.hunkId);
      return hunk ? { uri: target.uri, hunk } : undefined;
    }

    const uri = vscode.window.activeTextEditor?.document.uri;
    const hunks = uri ? this.diffs.get(uri)?.hunks : undefined;
    if (!uri || !hunks?.length) {
      return undefined;
    }
    const activeLine = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const hunkAtCursor = hunks.find((hunk) => {
      const endLine = hunk.newStartLine + Math.max(hunk.newLineCount, 1);
      return activeLine >= hunk.newStartLine && activeLine < endLine;
    });
    return hunkAtCursor
      ? { uri, hunk: hunkAtCursor }
      : hunks.length === 1
        ? { uri, hunk: hunks[0] }
        : undefined;
  }

  private resolveHistoricalHunk(
    target?: HunkCommandTarget | string,
    hunkId?: string,
  ) {
    if (typeof target === "string" && hunkId) {
      const uri = vscode.Uri.parse(target);
      const hunk = this.diffs.getHistoricalHunk(uri, hunkId);
      return hunk ? { uri, hunk } : undefined;
    }
    if (typeof target === "object" && target.hunkId) {
      const hunk = this.diffs.getHistoricalHunk(target.uri, target.hunkId);
      return hunk ? { uri: target.uri, hunk } : undefined;
    }
    return undefined;
  }

  private showNoHunkMessage(): void {
    void vscode.window.showInformationMessage(
      "Select a hunk in AGENT CHANGES, or place the cursor in a file with one hunk.",
    );
  }
}

interface HunkCommandTarget {
  readonly uri: vscode.Uri;
  readonly hunkId: string;
}
