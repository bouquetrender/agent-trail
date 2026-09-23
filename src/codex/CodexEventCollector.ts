import { pathToFileURL } from "url";
import type { SessionManager } from "../session/SessionManager";
import type { CodexHookEvent, CodexPatch } from "./hook";

export class CodexEventCollector {
  private recordingSince: number | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly requests = new Map<string, CodexHookEvent>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly manager: SessionManager,
    private readonly confirmPatch: (patch: CodexPatch) => void = () => {},
    private readonly fileUri: (filename: string) => string = (filename) => pathToFileURL(filename).toString(),
  ) {}

  startRecording(timestamp = Date.now()): void {
    this.stopRecording();
    this.recordingSince = timestamp;
    this.sessions.clear();
    this.requests.clear();
    this.seen.clear();
  }

  stopRecording(): void {
    this.recordingSince = undefined;
    this.manager.endAllSessions();
    this.requests.clear();
  }

  accept(event: CodexHookEvent): void {
    if (this.recordingSince === undefined || event.timestamp < this.recordingSince || this.seen.has(event.id)) {
      return;
    }
    this.seen.add(event.id);
    let sessionId = this.sessions.get(event.sessionId);
    if (event.phase === "session-end") {
      if (sessionId) { this.manager.endSession("", sessionId); }
      this.sessions.delete(event.sessionId);
      for (const [key, request] of this.requests) {
        if (request.sessionId === event.sessionId) { this.requests.delete(key); }
      }
      return;
    }
    const key = JSON.stringify([event.sessionId, event.turnId, event.callId]);
    // A result without its request may belong to a previous review/recording interval.
    if (event.phase === "completed" && !this.requests.has(key)) {
      return;
    }
    if (!sessionId) {
      sessionId = this.manager.startSession({
        title: `Codex · ${event.sessionId.slice(0, 8)}`,
        agent: "Codex",
        provider: "OpenAI",
        externalSessionId: event.sessionId,
        startedAt: event.timestamp,
      }).id;
      this.sessions.set(event.sessionId, sessionId);
    }
    if (this.manager.getSession(sessionId)?.status !== "active") {
      return;
    }
    if (event.phase === "requested") { this.requests.set(key, event); }
    const metadata = {
      source: "codex-hook",
      confidence: "reported" as const,
      timestamp: event.timestamp,
      externalCallId: event.callId,
      externalTurnId: event.turnId,
    };
    this.manager.recordEvent({
      ...metadata,
      type: "tool-call",
      payload: {
        tool: event.tool,
        phase: event.phase,
        command: event.command,
        cwd: event.cwd,
        outcome: event.outcome,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
      },
    }, sessionId);
    if (event.phase === "completed") {
      const request = this.requests.get(key);
      this.requests.delete(key);
      if (event.tool === "apply_patch" && request?.tool === "apply_patch" && event.outcome === "succeeded") {
        for (const file of event.files) {
          const patch = request.patches.find((item) => item.path === file.path && item.kind === file.kind);
          if (patch && file.content !== undefined && patch.after === file.content) {
            this.confirmPatch(patch);
          }
          this.manager.recordEvent({
            ...metadata,
            type: file.kind === "A" ? "file-created" : file.kind === "D" ? "file-deleted" : "file-modified",
            payload: { uri: this.fileUri(file.path) },
          }, sessionId);
        }
      }
    }
  }
}
