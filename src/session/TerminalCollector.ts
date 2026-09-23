import { randomUUID } from "crypto";
import type * as vscode from "vscode";
import type { SessionManager } from "./SessionManager";

interface PendingCommand {
  readonly sessionId: string;
  readonly commandId: string;
  readonly command: string;
  readonly cwd: string | undefined;
  readonly startedAt: number;
}

export class TerminalCollector implements vscode.Disposable {
  private executions = new WeakMap<vscode.TerminalShellExecution, PendingCommand>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly supported: boolean;

  constructor(
    private readonly sessions: SessionManager,
    events: Pick<typeof vscode.window,
      "onDidStartTerminalShellExecution" | "onDidEndTerminalShellExecution">,
    private readonly now: () => number = Date.now,
  ) {
    const { onDidStartTerminalShellExecution, onDidEndTerminalShellExecution } = events;
    this.supported = typeof onDidStartTerminalShellExecution === "function" &&
      typeof onDidEndTerminalShellExecution === "function";
    if (typeof onDidStartTerminalShellExecution !== "function" ||
      typeof onDidEndTerminalShellExecution !== "function") {
      return;
    }
    this.subscriptions.push(
      onDidStartTerminalShellExecution(({ execution }) => this.start(execution)),
      onDidEndTerminalShellExecution(({ execution, exitCode }) => this.end(execution, exitCode)),
    );
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.executions = new WeakMap();
  }

  private start(execution: vscode.TerminalShellExecution): void {
    const session = this.sessions.getCurrentSession();
    if (!session || this.executions.has(execution)) {
      return;
    }
    const command: PendingCommand = {
      sessionId: session.id,
      commandId: randomUUID(),
      command: execution.commandLine.value,
      cwd: execution.cwd?.scheme === "file" ? execution.cwd.fsPath : execution.cwd?.toString(),
      startedAt: Math.max(this.now(), session.startedAt),
    };
    this.executions.set(execution, command);
    this.sessions.recordEvent({
      type: "command-start",
      timestamp: command.startedAt,
      source: "terminal",
      confidence: "observed",
      payload: {
        commandId: command.commandId,
        command: command.command,
        cwd: command.cwd,
        startedAt: command.startedAt,
      },
    }, command.sessionId);
  }

  private end(execution: vscode.TerminalShellExecution, exitCode: number | undefined): void {
    const command = this.executions.get(execution);
    if (!command) {
      return;
    }
    this.executions.delete(execution);
    const endedAt = Math.max(this.now(), command.startedAt);
    this.sessions.recordEvent({
      type: "command-end",
      timestamp: endedAt,
      source: "terminal",
      confidence: "observed",
      payload: {
        commandId: command.commandId,
        // Shell integration can provide a more accurate command line on completion.
        command: execution.commandLine.value || command.command,
        cwd: command.cwd,
        startedAt: command.startedAt,
        endedAt,
        duration: endedAt - command.startedAt,
        exitCode,
      },
    }, command.sessionId);
  }
}
