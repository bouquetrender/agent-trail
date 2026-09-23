import * as vscode from "vscode";
import { localize } from "../localize";
import type {
  BaselineCaptureOptions,
  BaselineStore,
} from "./BaselineStore";
import { GitBaselineStore } from "./GitBaselineStore";
import { MemoryBaselineStore } from "./MemoryBaselineStore";

export class WorkspaceBaselineStore implements BaselineStore {
  private activeStore: BaselineStore = new MemoryBaselineStore();

  get kind(): "git" | "memory" {
    return this.activeStore.kind;
  }

  async capture(options?: BaselineCaptureOptions): Promise<void> {
    this.activeStore.clear();
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length === 1) {
      let gitStore: GitBaselineStore | undefined;
      try {
        gitStore = await GitBaselineStore.create(folders[0].uri);
        await gitStore.capture(options);
        this.activeStore = gitStore;
        return;
      } catch {
        gitStore?.clear();
        // Non-Git and unsupported workspaces intentionally use the portable store.
      }
    }

    const memoryStore = new MemoryBaselineStore();
    options?.report?.(localize("Git baseline unavailable; using memory baseline…", "Git 基线不可用，正在使用内存基线…"));
    await memoryStore.capture(options);
    this.activeStore = memoryStore;
  }

  clear(): void {
    this.activeStore.clear();
    this.activeStore = new MemoryBaselineStore();
  }

  has(uri: vscode.Uri): boolean {
    return this.activeStore.has(uri);
  }

  get(uri: vscode.Uri): Promise<string | undefined> {
    return this.activeStore.get(uri);
  }

  set(uri: vscode.Uri, content: string): Promise<void> {
    return this.activeStore.set(uri, content);
  }

  uris(): readonly vscode.Uri[] {
    return this.activeStore.uris();
  }
}
