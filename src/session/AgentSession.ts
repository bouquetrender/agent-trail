export type AgentEventConfidence = "observed" | "reported" | "inferred";

export type AgentEventData =
  | {
      readonly type: "tool-call";
      readonly payload: {
        readonly tool: string;
        readonly phase: "requested" | "completed";
        readonly command: string;
        readonly cwd: string;
        readonly outcome: "succeeded" | "failed" | "unknown";
        readonly exitCode?: number;
        readonly durationMs?: number;
      };
    }
  | {
      readonly type: "session-start";
      readonly payload: { readonly title: string };
    }
  | {
      readonly type: "session-end";
      readonly payload: { readonly summary: string };
    }
  | {
      readonly type: "file-created" | "file-modified" | "file-deleted";
      readonly payload: { readonly uri: string };
    }
  | {
      readonly type: "command-start";
      readonly payload: {
        readonly commandId: string;
        readonly command: string;
        readonly cwd?: string;
        readonly startedAt: number;
      };
    }
  | {
      readonly type: "command-end";
      readonly payload: {
        readonly commandId: string;
        readonly command: string;
        readonly cwd?: string;
        readonly startedAt: number;
        readonly endedAt: number;
        readonly duration: number;
        readonly exitCode: number | undefined;
      };
    };

export type AgentEvent = AgentEventData & {
  readonly id: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly source: string;
  readonly confidence: AgentEventConfidence;
  readonly externalCallId?: string;
  readonly externalTurnId?: string;
};

export type AgentEventInput = Exclude<
  AgentEventData,
  { readonly type: "session-start" | "session-end" }
> & {
  readonly source: string;
  readonly confidence: AgentEventConfidence;
  readonly timestamp?: number;
  readonly externalCallId?: string;
  readonly externalTurnId?: string;
};

export interface AgentSession {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly provider: string;
  readonly externalSessionId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: "active" | "ended";
  readonly events: readonly AgentEvent[];
  readonly summary: string;
}
