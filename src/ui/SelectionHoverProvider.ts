import * as path from "path";
import * as vscode from "vscode";

export class SelectionHoverProvider
  implements vscode.HoverProvider, vscode.Disposable
{
  private readonly subscriptions: vscode.Disposable[];
  private showTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() =>
        this.scheduleHover(),
      ),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.scheduleHover();
        }
      }),
    ];
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor ||
      editor.document !== document ||
      document.uri.scheme !== "file" ||
      editor.selection.isEmpty ||
      !editor.selection.contains(position) ||
      !vscode.extensions.getExtension("openai.chatgpt")
    ) {
      return undefined;
    }

    const fileArgs = encodeURIComponent(JSON.stringify([document.uri]));
    const folderArgs = encodeURIComponent(JSON.stringify([
      vscode.Uri.file(path.dirname(document.uri.fsPath)),
    ]));
    const contents = new vscode.MarkdownString(
      "[$(comment-discussion) Add Selection](command:chatgpt.addToThread)" +
      ` · [$(file-add) Add File](command:chatgpt.addFileToThread?${fileArgs})` +
      ` · [$(folder-opened) Add Folder](command:chatgpt.addFileToThread?${folderArgs})`,
      true,
    );
    contents.isTrusted = {
      enabledCommands: ["chatgpt.addToThread", "chatgpt.addFileToThread"],
    };
    return new vscode.Hover(contents, editor.selection);
  }

  private scheduleHover(): void {
    clearTimeout(this.showTimer);
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.provideHover(editor.document, editor.selection.active)) {
      return;
    }

    // Wait for selection movement to settle without adding space to the editor.
    this.showTimer = setTimeout(() => {
      this.showTimer = undefined;
      if (
        vscode.window.activeTextEditor === editor &&
        this.provideHover(editor.document, editor.selection.active)
      ) {
        void vscode.commands.executeCommand("editor.action.showHover", {
          focus: "noAutoFocus",
        });
      }
    }, 200);
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    clearTimeout(this.showTimer);
  }
}
