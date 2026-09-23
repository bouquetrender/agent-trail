import * as vscode from "vscode";
import type { AgentFileChange, FileDiff } from "../model";
import type { BaselineStore } from "../session/BaselineStore";
import { AgentChangeHistory } from "./AgentChangeHistory";
import { computeHunks } from "./computeHunks";

export class DiffService implements vscode.Disposable {
  private readonly fileDiffs = new Map<string, FileDiff>();
  private readonly history = new AgentChangeHistory();
  private hunkCount = 0;
  private generation = 0;
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly baselineStore: BaselineStore) {}

  getAll(): readonly FileDiff[] {
    return [...this.fileDiffs.values()].sort((a, b) =>
      a.uri.localeCompare(b.uri),
    );
  }

  get(uri: vscode.Uri): FileDiff | undefined {
    return this.fileDiffs.get(uri.toString());
  }

  getAllAgentChanges(): readonly AgentFileChange[] {
    return this.history.getAll();
  }

  getHunkCount(): number {
    return this.hunkCount;
  }

  getFileCount(): number {
    return this.fileDiffs.size;
  }

  hasAgentChanges(): boolean {
    return this.history.hasChanges();
  }

  recordWholeFileChange(uri: vscode.Uri, kind: "added" | "deleted"): void {
    if (kind === "deleted") {
      this.updateFileDiff(uri.toString(), undefined);
    }
    this.history.recordWholeFile(uri.toString(), kind);
    this.changeEmitter.fire();
  }

  hasWholeFileChange(uri: vscode.Uri, kind: "added" | "deleted"): boolean {
    return this.history.hasWholeFile(uri.toString(), kind);
  }

  getHunk(uri: vscode.Uri, hunkId: string) {
    return this.get(uri)?.hunks.find((hunk) => hunk.id === hunkId);
  }

  getHistoricalHunk(uri: vscode.Uri, hunkId: string) {
    return this.history.getHunk(uri.toString(), hunkId);
  }

  async recompute(uri: vscode.Uri): Promise<void> {
    const generation = this.generation;
    try {
      const baseline = await this.baselineStore.get(uri);
      if (baseline === undefined || generation !== this.generation) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (generation !== this.generation) {
        return;
      }
      const hunks = computeHunks(uri.toString(), baseline, document.getText());
      if (hunks.length === 0) {
        this.updateFileDiff(uri.toString(), undefined);
      } else {
        const fileDiff = { uri: uri.toString(), hunks };
        this.updateFileDiff(uri.toString(), fileDiff);
        this.history.record(fileDiff);
      }
    } catch {
      if (generation !== this.generation) {
        return;
      }
      // Lifecycle history is recorded before unreadable files leave the reviewable set.
      this.updateFileDiff(uri.toString(), undefined);
    }

    this.changeEmitter.fire();
  }

  async recomputeAll(): Promise<void> {
    await Promise.all(this.baselineStore.uris().map((uri) => this.recompute(uri)));
  }

  clear(): void {
    this.generation++;
    if (this.fileDiffs.size === 0 && !this.history.hasChanges()) {
      return;
    }
    this.fileDiffs.clear();
    this.hunkCount = 0;
    this.history.clear();
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.generation++;
    this.changeEmitter.dispose();
  }

  private updateFileDiff(uri: string, fileDiff: FileDiff | undefined): void {
    this.hunkCount -= this.fileDiffs.get(uri)?.hunks.length ?? 0;
    if (fileDiff) {
      this.fileDiffs.set(uri, fileDiff);
      this.hunkCount += fileDiff.hunks.length;
    } else {
      this.fileDiffs.delete(uri);
    }
  }
}
