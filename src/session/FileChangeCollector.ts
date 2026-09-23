import * as vscode from "vscode";

export class FileChangeCollector implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly onFileChange: (uri: vscode.Uri) => void) {}

  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const changed = (uri: vscode.Uri) => {
      if (isReviewableWorkspaceUri(uri)) { this.onFileChange(uri); }
    };
    this.watcher.onDidCreate(changed);
    this.watcher.onDidChange(changed);
    this.watcher.onDidDelete(changed);
  }

  async stop(): Promise<void> {
    this.dispose();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
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
