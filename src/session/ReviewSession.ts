import * as vscode from "vscode";
import { localize } from "../localize";
import { DiffService } from "../diff/DiffService";
import type { BaselineStore } from "./BaselineStore";
import { EventStore } from "./EventStore";
import { FileChangeCollector } from "./FileChangeCollector";
import { GitBranchWatcher } from "./GitBranchWatcher";
import { SessionManager } from "./SessionManager";

const WATCH_DEBOUNCE_MS = 250;
const DOCUMENT_ORIGIN_DELAY_MS = 100;
const EXTERNAL_CHANGE_WINDOW_MS = 500;

export type ReviewSessionState = "inactive" | "capturing" | "ready";

export class ReviewSession implements vscode.Disposable {
  private readonly collector: FileChangeCollector;
  private readonly branchWatcher: GitBranchWatcher;
  private branchWatching: Promise<void> | undefined;
  private starting: Promise<{ fileCount: number; kind: "git" | "memory" }> | undefined;
  private restartRequested = false;
  private disposed = false;
  private generation = 0;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly userEditTimers = new Map<string, NodeJS.Timeout>();
  private readonly documentOriginTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingUserEdits = new Set<string>();
  private readonly internalEdits = new Set<string>();
  private readonly externalChangeTimes = new Map<string, number>();
  private readonly baselineChangeEmitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  private readonly documentChangeSubscription: vscode.Disposable;
  private active = false;
  private state: ReviewSessionState = "inactive";
  private readonly stateChangeEmitter = new vscode.EventEmitter<ReviewSessionState>();

  readonly onDidAdvanceBaseline = this.baselineChangeEmitter.event;
  readonly onDidChangeState = this.stateChangeEmitter.event;

  constructor(
    private readonly baselineStore: BaselineStore,
    readonly diffs: DiffService,
    readonly agentSessions = new SessionManager(new EventStore()),
  ) {
    this.collector = new FileChangeCollector(
      baselineStore,
      diffs,
      agentSessions,
      (uri) => this.handleFileSystemChange(uri),
    );
    this.documentChangeSubscription = vscode.workspace.onDidChangeTextDocument(
      (event) => this.handleDocumentChange(event),
    );
    this.branchWatcher = new GitBranchWatcher(
      () => {
        this.restartRequested = true;
        void this.start().catch((error) => this.reportBranchError(error));
      },
      (error) => this.reportBranchError(error),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  getState(): ReviewSessionState {
    return this.state;
  }

  start(
    report?: (message: string) => void,
  ): Promise<{ fileCount: number; kind: "git" | "memory" }> {
    if (!this.starting) {
      this.starting = this.captureBaseline(report).finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async captureBaseline(
    report?: (message: string) => void,
  ): Promise<{ fileCount: number; kind: "git" | "memory" }> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      throw new Error(localize("Open a workspace folder before starting an AgentTrail session.", "请先打开工作区文件夹，再开始审查会话。"));
    }

    const stopping = this.collector.stop();
    this.stopWatcher();
    this.setState("capturing");
    this.diffs.clear();
    try {
      await stopping;
      this.branchWatching ??= this.branchWatcher.start(
        folders.filter((folder) => folder.uri.scheme === "file")
          .map((folder) => folder.uri.fsPath),
      );
      await this.branchWatching;
      do {
        this.restartRequested = false;
        this.diffs.clear();
        await this.baselineStore.capture({ report });
        await Promise.all(
          vscode.workspace.textDocuments
            .filter(
              (document) =>
                document.uri.scheme === "file" &&
                document.isDirty &&
                this.baselineStore.has(document.uri),
            )
            .map((document) =>
              this.baselineStore.set(document.uri, document.getText()),
            ),
        );
      } while (this.restartRequested && !this.disposed);
      if (this.disposed) {
        this.baselineStore.clear();
        return { fileCount: 0, kind: this.baselineStore.kind };
      }
      this.baselineChangeEmitter.fire(undefined);
      report?.(localize("Starting filesystem watcher…", "正在开始监听文件变化…"));
      this.agentSessions.startSession({ title: localize("Workspace Session", "工作区会话") });
      this.collector.start();
      this.active = true;
      this.setState("ready");
      return {
        fileCount: this.baselineStore.uris().length,
        kind: this.baselineStore.kind,
      };
    } catch (error) {
      await this.collector.stop();
      this.stopWatcher();
      throw error;
    }
  }

  async recompute(uri: vscode.Uri): Promise<void> {
    if (this.active && this.baselineStore.has(uri)) {
      await this.diffs.recompute(uri);
    }
  }

  async applyReviewEdit(
    edit: vscode.WorkspaceEdit,
    uris: readonly vscode.Uri[],
  ): Promise<boolean> {
    const keys = uris.map((uri) => uri.toString());
    keys.forEach((key) => this.internalEdits.add(key));
    try {
      return await vscode.workspace.applyEdit(edit);
    } finally {
      keys.forEach((key) => this.internalEdits.delete(key));
    }
  }

  async endAgentSession(): Promise<void> {
    await this.collector.endSession();
  }

  dispose(): void {
    this.disposed = true;
    this.branchWatcher.dispose();
    this.collector.dispose();
    this.stopWatcher();
    this.agentSessions.dispose();
    this.documentChangeSubscription.dispose();
    this.baselineChangeEmitter.dispose();
    this.stateChangeEmitter.dispose();
    this.diffs.dispose();
    this.baselineStore.clear();
  }

  private scheduleRecompute(uri: vscode.Uri): void {
    if (!this.active || !this.baselineStore.has(uri)) {
      return;
    }

    const key = uri.toString();
    if (this.pendingUserEdits.has(key)) {
      return;
    }
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.diffs.recompute(uri);
      }, WATCH_DEBOUNCE_MS),
    );
  }

  private handleFileSystemChange(uri: vscode.Uri): void {
    this.externalChangeTimes.set(uri.toString(), Date.now());
    this.scheduleRecompute(uri);
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const { document } = event;
    const key = document.uri.toString();
    if (
      !this.active ||
      document.uri.scheme !== "file" ||
      event.contentChanges.length === 0 ||
      !this.baselineStore.has(document.uri) ||
      this.internalEdits.has(key)
    ) {
      return;
    }

    const existing = this.documentOriginTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.documentOriginTimers.set(
      key,
      setTimeout(() => {
        this.documentOriginTimers.delete(key);
        const externalChangeAt = this.externalChangeTimes.get(key);
        const isRecentExternalChange =
          externalChangeAt !== undefined &&
          Date.now() - externalChangeAt <= EXTERNAL_CHANGE_WINDOW_MS;
        if (
          this.active &&
          !this.internalEdits.has(key) &&
          (document.isDirty || !isRecentExternalChange)
        ) {
          this.scheduleUserBaselineAdvance(document);
        }
      }, DOCUMENT_ORIGIN_DELAY_MS),
    );
  }

  private scheduleUserBaselineAdvance(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.pendingUserEdits.add(key);
    const existing = this.userEditTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.userEditTimers.set(
      key,
      setTimeout(() => {
        this.userEditTimers.delete(key);
        void this.advanceBaselineForUserEdit(document).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(
            localize(`AgentTrail could not record the user edit: ${message}`, `无法记录用户编辑：${message}`),
          );
        });
      }, 100),
    );
  }

  private async advanceBaselineForUserEdit(
    document: vscode.TextDocument,
  ): Promise<void> {
    const key = document.uri.toString();
    const generation = this.generation;
    try {
      if (!this.active || !this.baselineStore.has(document.uri)) {
        return;
      }
      await this.baselineStore.set(document.uri, document.getText());
      if (generation !== this.generation) {
        return;
      }
      this.baselineChangeEmitter.fire(document.uri);
      await this.diffs.recompute(document.uri);
    } finally {
      if (generation === this.generation) {
        this.pendingUserEdits.delete(key);
      }
    }
  }

  private stopWatcher(): void {
    this.generation++;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const timer of this.userEditTimers.values()) {
      clearTimeout(timer);
    }
    this.userEditTimers.clear();
    for (const timer of this.documentOriginTimers.values()) {
      clearTimeout(timer);
    }
    this.documentOriginTimers.clear();
    this.pendingUserEdits.clear();
    this.internalEdits.clear();
    this.externalChangeTimes.clear();
    this.active = false;
    this.setState("inactive");
  }

  private setState(state: ReviewSessionState): void {
    this.state = state;
    this.stateChangeEmitter.fire(state);
  }

  private reportBranchError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      localize(`AgentTrail could not restart after a Git branch change: ${message}`, `切换 Git 分支后无法重新开始审查：${message}`),
    );
  }
}
