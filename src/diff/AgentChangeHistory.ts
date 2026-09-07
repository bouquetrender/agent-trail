import type { AgentFileChange, DiffHunk, FileDiff } from "../model";

const CHANGE_KIND_ORDER: Readonly<Record<AgentFileChange["kind"], number>> = {
  modified: 0,
  added: 1,
  deleted: 2,
};

export class AgentChangeHistory {
  private readonly hunksByUri = new Map<string, Map<number, DiffHunk>>();
  private readonly wholeFileChanges = new Map<string, AgentFileChange>();
  private sortedChanges: readonly AgentFileChange[] | undefined;

  hasChanges(): boolean {
    return this.hunksByUri.size > 0 || this.wholeFileChanges.size > 0;
  }

  record(fileDiff: FileDiff): void {
    this.sortedChanges = undefined;
    let hunks = this.hunksByUri.get(fileDiff.uri);
    if (!hunks) {
      hunks = new Map<number, DiffHunk>();
      this.hunksByUri.set(fileDiff.uri, hunks);
    }

    for (const hunk of fileDiff.hunks) {
      hunks.set(hunk.oldStartLine, hunk);
    }
  }

  recordWholeFile(uri: string, kind: "added" | "deleted"): void {
    this.sortedChanges = undefined;
    this.wholeFileChanges.set(`${kind}:${uri}`, { uri, kind, hunks: [] });
  }

  hasWholeFile(uri: string, kind: "added" | "deleted"): boolean {
    return this.wholeFileChanges.has(`${kind}:${uri}`);
  }

  getAll(): readonly AgentFileChange[] {
    if (this.sortedChanges) {
      return this.sortedChanges;
    }

    const modified = [...this.hunksByUri.entries()]
      .map(([uri, hunks]) => ({
        uri,
        kind: "modified" as const,
        hunks: [...hunks.values()].sort(
          (a, b) =>
            a.newStartLine - b.newStartLine || a.id.localeCompare(b.id),
        ),
      }));
    this.sortedChanges = [...modified, ...this.wholeFileChanges.values()].sort(
      (a, b) =>
        a.uri.localeCompare(b.uri) ||
        CHANGE_KIND_ORDER[a.kind] - CHANGE_KIND_ORDER[b.kind],
    );
    return this.sortedChanges;
  }

  getHunk(uri: string, hunkId: string): DiffHunk | undefined {
    const hunks = this.hunksByUri.get(uri);
    if (hunks) {
      for (const hunk of hunks.values()) {
        if (hunk.id === hunkId) {
          return hunk;
        }
      }
    }
    return undefined;
  }

  clear(): void {
    this.hunksByUri.clear();
    this.wholeFileChanges.clear();
    this.sortedChanges = undefined;
  }
}
