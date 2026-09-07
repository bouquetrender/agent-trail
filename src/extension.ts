import * as vscode from "vscode";
import { HunkCommands } from "./commands/HunkCommands";
import { FileCommands } from "./commands/FileCommands";
import { DiffService } from "./diff/DiffService";
import { WorkspaceBaselineStore } from "./session/WorkspaceBaselineStore";
import { ReviewSession } from "./session/ReviewSession";
import {
  BASELINE_SCHEME,
  BaselineContentProvider,
} from "./ui/BaselineContentProvider";
import { HunkCodeLensProvider } from "./ui/HunkCodeLensProvider";
import { SelectionCodeLensProvider } from "./ui/SelectionCodeLensProvider";
import { ChangeTreeProvider } from "./ui/ChangeTreeProvider";
import { ChangeStatusBar } from "./ui/ChangeStatusBar";

export function activate(context: vscode.ExtensionContext): void {
  const baselineStore = new WorkspaceBaselineStore();
  const diffs = new DiffService(baselineStore);
  const session = new ReviewSession(baselineStore, diffs);
  const baselineProvider = new BaselineContentProvider(baselineStore);
  const hunkCommands = new HunkCommands(
    baselineStore,
    diffs,
    session,
    baselineProvider,
  );
  const codeLensProvider = new HunkCodeLensProvider(diffs);
  const selectionCodeLensProvider = new SelectionCodeLensProvider();
  const treeProvider = new ChangeTreeProvider(diffs);
  const statusBar = new ChangeStatusBar(diffs, session);
  const fileCommands = new FileCommands(
    baselineStore,
    diffs,
    session,
    baselineProvider,
  );
  const baselineChangeSubscription = session.onDidAdvanceBaseline((uri) =>
    baselineProvider.refresh(uri),
  );
  const treeView = vscode.window.createTreeView("cursorForgery.changes", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  let previousState: string | undefined;
  let previousHasPending: boolean | undefined;
  let previousActiveFileHasPending: boolean | undefined;
  const updateReviewUi = (): void => {
    const state = session.getState();
    const hasPending = state === "ready" && diffs.getFileCount() > 0;
    if (state !== previousState) {
      previousState = state;
      void vscode.commands.executeCommand(
        "setContext", "cursorForgery.sessionState", state,
      );
    }
    if (hasPending !== previousHasPending) {
      previousHasPending = hasPending;
      void vscode.commands.executeCommand(
        "setContext", "cursorForgery.hasPendingChanges", hasPending,
      );
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFileHasPending =
      hasPending && activeUri !== undefined && diffs.get(activeUri) !== undefined;
    if (activeFileHasPending !== previousActiveFileHasPending) {
      previousActiveFileHasPending = activeFileHasPending;
      void vscode.commands.executeCommand(
        "setContext", "cursorForgery.activeFileHasPendingChanges", activeFileHasPending,
      );
    }
    treeView.message = state === "ready" && !hasPending && diffs.hasAgentChanges()
      ? "No pending changes. Session history is available below."
      : undefined;
  };
  const stateSubscription = session.onDidChangeState(updateReviewUi);
  const pendingSubscription = diffs.onDidChange(updateReviewUi);
  const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(
    updateReviewUi,
  );
  updateReviewUi();
  let sessionStartInProgress = false;
  const startSession = async (isReset = false, automatic = false): Promise<void> => {
    if (sessionStartInProgress) {
      void vscode.window.showInformationMessage(
        "Agent Review is already capturing a baseline.",
      );
      return;
    }

    sessionStartInProgress = true;
    try {
      const result = automatic
        ? await session.start()
        : await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `${isReset ? "Resetting" : "Starting"} Agent Review session`,
              cancellable: false,
            },
            (_progress, _token) =>
              session.start((message) => _progress.report({ message })),
          );
      if (!automatic) {
        void vscode.window.showInformationMessage(
          `Agent Review session ${isReset ? "reset" : "started"} with ${result.fileCount} files using a ${result.kind} baseline.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(message);
    } finally {
      sessionStartInProgress = false;
    }
  };
  const addToCodexThread = async (uri?: vscode.Uri): Promise<void> => {
    if (!uri) {
      return;
    }
    if (!vscode.extensions.getExtension("openai.chatgpt")) {
      void vscode.window.showInformationMessage(
        "Install and enable the Codex extension to add this resource.",
      );
      return;
    }

    await vscode.commands.executeCommand("chatgpt.addFileToThread", uri);
  };

  context.subscriptions.push(
    session,
    baselineProvider,
    codeLensProvider,
    selectionCodeLensProvider,
    treeProvider,
    statusBar,
    baselineChangeSubscription,
    stateSubscription,
    pendingSubscription,
    activeEditorSubscription,
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(
      BASELINE_SCHEME,
      baselineProvider,
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: "file" },
      codeLensProvider,
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: "file" },
      selectionCodeLensProvider,
    ),
    vscode.commands.registerCommand("cursorForgery.startSession", () => startSession()),
    vscode.commands.registerCommand("cursorForgery.resetSession", () =>
      startSession(true),
    ),
    vscode.commands.registerCommand(
      "cursorForgery.acceptHunk",
      (target, hunkId) => hunkCommands.acceptHunk(target, hunkId),
    ),
    vscode.commands.registerCommand(
      "cursorForgery.rejectHunk",
      (target, hunkId) => hunkCommands.rejectHunk(target, hunkId),
    ),
    vscode.commands.registerCommand(
      "cursorForgery.requestHunkChange",
      (target, hunkId) => hunkCommands.requestHunkChange(target, hunkId),
    ),
    vscode.commands.registerCommand(
      "cursorForgery.openHunkDiff",
      (target, hunkId) => hunkCommands.openHunkDiff(target, hunkId),
    ),
    vscode.commands.registerCommand(
      "cursorForgery.openHunk",
      (target, hunkId, historical) =>
        hunkCommands.openHunk(target, hunkId, historical),
    ),
    vscode.commands.registerCommand("cursorForgery.acceptFile", (target) =>
      fileCommands.acceptFile(target),
    ),
    vscode.commands.registerCommand("cursorForgery.rejectFile", (target) =>
      fileCommands.rejectFile(target),
    ),
    vscode.commands.registerCommand("cursorForgery.acceptAll", () =>
      fileCommands.acceptAll(),
    ),
    vscode.commands.registerCommand("cursorForgery.rejectAll", () =>
      fileCommands.rejectAll(),
    ),
    vscode.commands.registerCommand(
      "cursorForgery.addToCodexThread",
      addToCodexThread,
    ),
  );

  if (vscode.workspace.workspaceFolders?.length) {
    void startSession(false, true);
  }
}

export function deactivate(): void {}
