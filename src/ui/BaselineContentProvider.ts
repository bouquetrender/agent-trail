import * as vscode from "vscode";
import type { BaselineStore } from "../session/BaselineStore";

export const BASELINE_SCHEME = "agent-review-baseline";

export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly sources = new Map<string, vscode.Uri>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly baselineStore: BaselineStore) {}

  createUri(source: vscode.Uri): vscode.Uri {
    const virtual = vscode.Uri.from({
      scheme: BASELINE_SCHEME,
      path: source.path,
      query: `source=${encodeURIComponent(source.toString())}`,
    });
    this.sources.set(virtual.toString(), source);
    return virtual;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const source = this.sources.get(uri.toString());
    return source ? ((await this.baselineStore.get(source)) ?? "") : "";
  }

  refresh(source?: vscode.Uri): void {
    if (source) {
      this.changeEmitter.fire(this.createUri(source));
    } else {
      for (const uri of this.sources.keys()) {
        this.changeEmitter.fire(vscode.Uri.parse(uri));
      }
    }
  }

  dispose(): void {
    this.sources.clear();
    this.changeEmitter.dispose();
  }
}
