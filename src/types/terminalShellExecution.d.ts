import "vscode";

// The subset of the stable VS Code 1.93 API used by TerminalCollector.
// Keep the events optional while the extension supports VS Code 1.85.
declare module "vscode" {
  export interface TerminalShellExecution {
    readonly commandLine: { readonly value: string };
    readonly cwd: Uri | undefined;
  }

  export interface TerminalShellExecutionStartEvent {
    readonly execution: TerminalShellExecution;
  }

  export interface TerminalShellExecutionEndEvent {
    readonly execution: TerminalShellExecution;
    readonly exitCode: number | undefined;
  }

  export namespace window {
    export const onDidChangeTerminalShellIntegration:
      Event<{ readonly terminal: Terminal }> | undefined;
    export const onDidStartTerminalShellExecution:
      Event<TerminalShellExecutionStartEvent> | undefined;
    export const onDidEndTerminalShellExecution:
      Event<TerminalShellExecutionEndEvent> | undefined;
  }
}
