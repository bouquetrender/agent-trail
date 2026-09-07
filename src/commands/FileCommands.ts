import * as vscode from "vscode";
import type { DiffService } from "../diff/DiffService";
import type { BaselineStore } from "../session/BaselineStore";
import type { ReviewSession } from "../session/ReviewSession";
import type { BaselineContentProvider } from "../ui/BaselineContentProvider";

export interface UriCommandTarget {
  readonly uri: vscode.Uri;
}

export class FileCommands {
  constructor(
    private readonly baselineStore: BaselineStore,
    private readonly diffs: DiffService,
    private readonly session: ReviewSession,
    private readonly baselineProvider: BaselineContentProvider,
  ) {}

  async acceptFile(target?: UriCommandTarget | vscode.Uri | string): Promise<void> {
    const uri = this.resolveUri(target);
    if (!uri || !this.diffs.get(uri)) {
      return this.showNoFileMessage();
    }

    const document = await vscode.workspace.openTextDocument(uri);
    await this.baselineStore.set(uri, document.getText());
    this.baselineProvider.refresh(uri);
    await this.session.recompute(uri);
  }

  async rejectFile(target?: UriCommandTarget | vscode.Uri | string): Promise<void> {
    const uri = this.resolveUri(target);
    const baseline = uri ? await this.baselineStore.get(uri) : undefined;
    if (!uri || baseline === undefined || !this.diffs.get(uri)) {
      return this.showNoFileMessage();
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullDocumentRange(document), baseline);
    if (!(await this.session.applyReviewEdit(edit, [uri]))) {
      void vscode.window.showErrorMessage("Agent Review could not reject this file.");
      return;
    }
    await this.session.recompute(uri);
  }

  async acceptAll(): Promise<void> {
    const uris = this.changedUris();
    await Promise.all(
      uris.map(async (uri) => {
        const document = await vscode.workspace.openTextDocument(uri);
        await this.baselineStore.set(uri, document.getText());
        this.baselineProvider.refresh(uri);
      }),
    );
    await Promise.all(uris.map((uri) => this.session.recompute(uri)));
  }

  async rejectAll(): Promise<void> {
    const uris = this.changedUris();
    if (uris.length === 0) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    const snapshots = await Promise.all(
      uris.map(async (uri) => {
        const baseline = await this.baselineStore.get(uri);
        if (baseline === undefined) {
          return undefined;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        return { uri, baseline, document, version: document.version };
      }),
    );
    const reviewable = snapshots.flatMap((snapshot) => snapshot ? [snapshot] : []);
    if (reviewable.length === 0) {
      return;
    }
    const action = `Reject ${reviewable.length} File${reviewable.length === 1 ? "" : "s"}`;
    const choice = await vscode.window.showWarningMessage(
      `Reject all pending changes in ${reviewable.length} file${reviewable.length === 1 ? "" : "s"}?`,
      {
        modal: true,
        detail: "This replaces the current contents of these files with their review baselines.",
      },
      action,
    );
    if (choice !== action) {
      return;
    }
    const baselines = await Promise.all(
      reviewable.map(({ uri }) => this.baselineStore.get(uri)),
    );
    if (
      reviewable.some((snapshot, index) =>
        snapshot.document.version !== snapshot.version ||
        baselines[index] !== snapshot.baseline ||
        !this.diffs.get(snapshot.uri),
      )
    ) {
      void vscode.window.showWarningMessage(
        "Files or review baselines changed while confirmation was open. Review the latest changes and try again.",
      );
      return;
    }
    for (const { uri, baseline, document } of reviewable) {
      edit.replace(uri, fullDocumentRange(document), baseline);
    }
    const reviewedUris = reviewable.map(({ uri }) => uri);
    if (!(await this.session.applyReviewEdit(edit, reviewedUris))) {
      void vscode.window.showErrorMessage("Agent Review could not reject all changes.");
      return;
    }
    await Promise.all(reviewedUris.map((uri) => this.session.recompute(uri)));
  }

  private changedUris(): vscode.Uri[] {
    return this.diffs.getAll().map((fileDiff) => vscode.Uri.parse(fileDiff.uri));
  }

  private resolveUri(
    target?: UriCommandTarget | vscode.Uri | string,
  ): vscode.Uri | undefined {
    if (typeof target === "string") {
      return vscode.Uri.parse(target);
    }
    if (target instanceof vscode.Uri) {
      return target;
    }
    if (target?.uri) {
      return target.uri;
    }
    return vscode.window.activeTextEditor?.document.uri;
  }

  private showNoFileMessage(): void {
    void vscode.window.showInformationMessage(
      "Open or select a file with Agent Review changes first.",
    );
  }
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
}
