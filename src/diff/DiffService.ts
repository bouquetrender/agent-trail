import * as vscode from "vscode";
import type { AgentFileChange, FileDiff } from "../model";
import type { BaselineStore } from "../session/BaselineStore";
import { AgentChangeHistory } from "./AgentChangeHistory";
import { computeHunks } from "./computeHunks";
import { readTextFile } from "../session/readTextFile";

export class DiffService implements vscode.Disposable {
  private readonly fileDiffs = new Map<string, FileDiff>();
  private readonly history = new AgentChangeHistory();
  private hunkCount = 0;
  private generation = 0;
  private readonly revisions = new Map<string, number>();
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

  removePending(uri: vscode.Uri): void {
    this.revisions.set(uri.toString(), (this.revisions.get(uri.toString()) ?? 0) + 1);
    if (this.fileDiffs.has(uri.toString())) {
      this.updateFileDiff(uri.toString(), undefined);
      this.changeEmitter.fire();
    }
  }

  recordConfirmedChange(uri: vscode.Uri, before: string, after: string): void {
    const hunks = computeHunks(uri.toString(), before, after);
    if (hunks.length > 0) {
      this.history.record({ uri: uri.toString(), hunks });
      this.changeEmitter.fire();
    }
  }

  async recompute(uri: vscode.Uri, expectedContent?: string): Promise<void> {
    const generation = this.generation;
    const key = uri.toString();
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    const isCurrent = () => generation === this.generation && this.revisions.get(key) === revision;
    try {
      const baseline = await this.baselineStore.get(uri);
      if (baseline === undefined || !isCurrent()) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const diskContent = expectedContent !== undefined && !document.isDirty ? await readTextFile(uri) : undefined;
      if (!isCurrent()) {
        return;
      }
      if (expectedContent !== undefined &&
          ((!document.isDirty && diskContent !== expectedContent) || document.getText() !== expectedContent)) {
        this.removePending(uri);
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
      if (!isCurrent()) {
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
    this.revisions.clear();
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
