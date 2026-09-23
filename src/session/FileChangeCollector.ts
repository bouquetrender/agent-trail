import * as vscode from "vscode";
import { localize } from "../localize";
import type { DiffService } from "../diff/DiffService";
import type { AgentEventInput } from "./AgentSession";
import type { BaselineStore } from "./BaselineStore";
import type { SessionManager } from "./SessionManager";
import { readTextFile } from "./readTextFile";

export class FileChangeCollector implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private pending: Promise<void> = Promise.resolve();
  private generation = 0;
  private recording = false;
  private readonly textFiles = new Set<string>();

  constructor(
    private readonly baselineStore: BaselineStore,
    private readonly diffs: DiffService,
    private readonly sessions: SessionManager,
    private readonly onFileChange: (uri: vscode.Uri) => void,
  ) {}

  start(): void {
    this.textFiles.clear();
    this.baselineStore.uris().forEach((uri) => this.textFiles.add(uri.toString()));
    this.recording = true;
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.watcher.onDidCreate((uri) => this.collect(uri, "file-created"));
    this.watcher.onDidChange((uri) => this.collect(uri, "file-modified"));
    this.watcher.onDidDelete((uri) => this.collect(uri, "file-deleted"));
  }

  async endSession(summary = ""): Promise<void> {
    // Freeze the observation boundary before draining asynchronous text checks.
    this.recording = false;
    const sessionId = this.sessions.getCurrentSession()?.id;
    await this.pending;
    if (sessionId && this.sessions.getCurrentSession()?.id === sessionId) {
      this.sessions.endSession(summary);
    }
  }

  async stop(): Promise<void> {
    this.watcher?.dispose();
    this.watcher = undefined;
    await this.endSession();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.recording = false;
    this.generation++;
  }

  private collect(
    uri: vscode.Uri,
    type: "file-created" | "file-modified" | "file-deleted",
  ): void {
    if (!isReviewableWorkspaceUri(uri)) {
      return;
    }
    const timestamp = Date.now();
    const sessionId = this.recording ? this.sessions.getCurrentSession()?.id : undefined;
    const generation = this.generation;
    if (type === "file-modified" || (type === "file-created" && this.baselineStore.has(uri))) {
      this.onFileChange(uri);
    }
    this.pending = this.pending.then(async () => {
      if (generation !== this.generation) {
        return;
      }
      const key = uri.toString();
      if (type === "file-deleted") {
        if (!this.textFiles.delete(key)) {
          return;
        }
        if (
          this.baselineStore.has(uri) ||
          this.diffs.hasWholeFileChange(uri, "added")
        ) {
          this.diffs.recordWholeFileChange(uri, "deleted");
        }
      } else {
        const content = await readTextFile(uri);
        if (generation !== this.generation || content === undefined) {
          return;
        }
        this.textFiles.add(key);
        if (type === "file-created" && !this.baselineStore.has(uri)) {
          this.diffs.recordWholeFileChange(uri, "added");
        }
      }
      if (sessionId) {
        const event: AgentEventInput = {
          type,
          timestamp,
          source: "filesystem",
          confidence: "observed",
          payload: { uri: key },
        };
        this.sessions.recordEvent(event, sessionId);
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(localize(`AgentTrail could not collect a file change: ${message}`, `AgentTrail 无法记录文件变化：${message}`));
    });
  }
}

function isReviewableWorkspaceUri(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") {
    return false;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return false;
  }
  const relativePath = uri.path.slice(folder.uri.path.length + 1);
  return !relativePath
    .split("/")
    .some((segment) => segment === ".git" || segment === "node_modules");
}
