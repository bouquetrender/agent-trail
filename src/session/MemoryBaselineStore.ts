import * as vscode from "vscode";
import { localize } from "../localize";
import type {
  BaselineCaptureOptions,
  BaselineStore,
} from "./BaselineStore";
import { readTextFile } from "./readTextFile";

export class MemoryBaselineStore implements BaselineStore {
  readonly kind = "memory" as const;
  private readonly entries = new Map<string, { uri: vscode.Uri; text: string }>();

  async capture(options?: BaselineCaptureOptions): Promise<void> {
    this.clear();
    options?.report?.(localize("Discovering workspace files…", "正在查找工作区文件…"));
    const uris =
      options?.uris ??
      (await vscode.workspace.findFiles("**/*", "**/{.git,node_modules}/**"));
    options?.report?.(localize(`Capturing ${uris.length} files in memory…`, `正在捕获 ${uris.length} 个文件的内存基线…`));
    await Promise.all(
      uris.map(async (uri) => {
        const text = await readTextFile(uri);
        if (text !== undefined) {
          this.entries.set(uri.toString(), { uri, text });
        }
      }),
    );
  }

  clear(): void {
    this.entries.clear();
  }

  has(uri: vscode.Uri): boolean {
    return this.entries.has(uri.toString());
  }

  async get(uri: vscode.Uri): Promise<string | undefined> {
    return this.entries.get(uri.toString())?.text;
  }

  async set(uri: vscode.Uri, content: string): Promise<void> {
    const entry = this.entries.get(uri.toString());
    if (entry) {
      entry.text = content;
    }
  }

  uris(): readonly vscode.Uri[] {
    return [...this.entries.values()].map(({ uri }) => uri);
  }
}
