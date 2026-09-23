import * as vscode from "vscode";
import { localize } from "./localize";
import { HunkCommands } from "./commands/HunkCommands";
import { FileCommands } from "./commands/FileCommands";
import { DiffService } from "./diff/DiffService";
import { WorkspaceBaselineStore } from "./session/WorkspaceBaselineStore";
import { ReviewSession } from "./session/ReviewSession";
import { TerminalCollector } from "./session/TerminalCollector";
import {
  BASELINE_SCHEME,
  BaselineContentProvider,
} from "./ui/BaselineContentProvider";
import { HunkCodeLensProvider } from "./ui/HunkCodeLensProvider";
import { SelectionHoverProvider } from "./ui/SelectionHoverProvider";
import { ChangeTreeProvider } from "./ui/ChangeTreeProvider";
import { ChangeStatusBar } from "./ui/ChangeStatusBar";
import { SessionTimelineProvider } from "./ui/SessionTimelineProvider";

export function activate(context: vscode.ExtensionContext): void {
  const baselineStore = new WorkspaceBaselineStore();
  const diffs = new DiffService(baselineStore);
  const session = new ReviewSession(baselineStore, diffs);
  const terminalCollector = new TerminalCollector(session.agentSessions, vscode.window);
  const baselineProvider = new BaselineContentProvider(baselineStore);
  const hunkCommands = new HunkCommands(
    baselineStore,
    diffs,
    session,
    baselineProvider,
  );
  const codeLensProvider = new HunkCodeLensProvider(diffs);
  const selectionHoverProvider = new SelectionHoverProvider();
  const treeProvider = new ChangeTreeProvider(diffs);
  const statusBar = new ChangeStatusBar(diffs, session);
  const timelineProvider = new SessionTimelineProvider(session.agentSessions);
  const timelineView = vscode.window.createTreeView("cursorForgery.timeline", {
    treeDataProvider: timelineProvider,
    showCollapseAll: true,
  });
  timelineView.message = terminalCollector.supported
    ? localize("Memory only. Observed terminal activity requires shell integration. The actor is unknown.", "记录仅保存在内存中。观察终端活动需要 Shell Integration，执行者未知。")
    : localize("Memory only. Terminal activity unavailable: requires VS Code 1.93+. The actor is unknown.", "记录仅保存在内存中。终端采集需要 VS Code 1.93 或更高版本，执行者未知。");
  const updateAgentSessionUi = (): void => {
    void vscode.commands.executeCommand(
      "setContext", "cursorForgery.agentSessionActive",
      session.agentSessions.getCurrentSession() !== undefined,
    );
  };
  const agentSessionSubscription = session.agentSessions.onDidChange(updateAgentSessionUi);
  updateAgentSessionUi();
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
      ? localize("No pending changes. Session history is available below.", "暂无待审查变更，可在下方查看本次会话的历史记录。")
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
        localize("AgentTrail is already capturing a baseline.", "正在捕获审查基线，请稍候。"),
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
              title: isReset ? localize("Resetting AgentTrail session", "正在重置审查会话") : localize("Starting AgentTrail session", "正在开始审查会话"),
              cancellable: false,
            },
            (_progress, _token) =>
              session.start((message) => _progress.report({ message })),
          );
      if (!automatic) {
        void vscode.window.showInformationMessage(
          localize(`AgentTrail session ${isReset ? "reset" : "started"} with ${result.fileCount} files using a ${result.kind} baseline.`, `审查会话已${isReset ? "重置" : "开始"}，包含 ${result.fileCount} 个文件，使用${result.kind === "git" ? " Git " : "内存"}基线。`),
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
        localize("Install and enable the Codex extension to add this resource.", "请安装并启用 Codex 扩展以添加此资源。"),
      );
      return;
    }

    await vscode.commands.executeCommand("chatgpt.addFileToThread", uri);
  };

  context.subscriptions.push(
    terminalCollector,
    session,
    baselineProvider,
    codeLensProvider,
    selectionHoverProvider,
    treeProvider,
    statusBar,
    timelineProvider,
    timelineView,
    agentSessionSubscription,
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
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      selectionHoverProvider,
    ),
    vscode.commands.registerCommand("cursorForgery.endAgentSession", () =>
      session.endAgentSession(),
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
