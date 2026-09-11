import { randomUUID } from "crypto";
import type { AgentEvent, AgentEventInput, AgentSession } from "./AgentSession";
import { EventStore } from "./EventStore";

export class SessionManager {
  private readonly sessions = new Map<string, Omit<AgentSession, "events">>();
  private currentId: string | undefined;
  readonly onDidChange: EventStore["onDidChange"];

  constructor(
    private readonly eventStore: EventStore,
    private readonly now: () => number = Date.now,
  ) {
    this.onDidChange = eventStore.onDidChange;
  }

  startSession(options: {
    title: string;
    agent?: string;
    provider?: string;
  }): AgentSession {
    if (this.currentId) {
      throw new Error("End the current Agent Session before starting another.");
    }
    const session = {
      id: randomUUID(),
      title: options.title,
      agent: options.agent ?? "unknown",
      provider: options.provider ?? "unknown",
      startedAt: this.now(),
      status: "active" as const,
      summary: "",
    };
    this.sessions.set(session.id, session);
    this.currentId = session.id;
    this.eventStore.append({
      id: randomUUID(),
      sessionId: session.id,
      timestamp: session.startedAt,
      type: "session-start",
      source: "extension",
      confidence: "observed",
      payload: { title: session.title },
    });
    return { ...session, events: this.eventStore.getEvents(session.id) };
  }

  recordEvent(input: AgentEventInput, sessionId = this.currentId): AgentEvent | undefined {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || session.status !== "active") {
      return undefined;
    }
    const timestamp = input.timestamp ?? Math.max(this.now(), session.startedAt);
    if (!Number.isFinite(timestamp) || timestamp < session.startedAt) {
      throw new Error("An event timestamp must be within its Agent Session.");
    }
    const event: AgentEvent = {
      ...input,
      id: randomUUID(),
      sessionId: session.id,
      timestamp,
    };
    this.eventStore.append(event);
    return event;
  }

  endSession(summary = ""): AgentSession | undefined {
    const session = this.getCurrentSession();
    if (!session) {
      return undefined;
    }
    const endedAt = Math.max(
      this.now(),
      session.events[session.events.length - 1]?.timestamp ?? session.startedAt,
    );
    const { events, ...metadata } = session;
    this.sessions.set(session.id, { ...metadata, status: "ended", endedAt, summary });
    this.currentId = undefined;
    this.eventStore.append({
      id: randomUUID(),
      sessionId: session.id,
      timestamp: endedAt,
      type: "session-end",
      source: "extension",
      confidence: "observed",
      payload: { summary },
    });
    return this.getSession(session.id);
  }

  getCurrentSession(): AgentSession | undefined {
    return this.currentId ? this.getSession(this.currentId) : undefined;
  }

  getSession(id: string): AgentSession | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session, events: this.eventStore.getEvents(id) } : undefined;
  }

  getSessions(): readonly AgentSession[] {
    return [...this.sessions.values()].map((session) => ({
      ...session,
      events: this.eventStore.getEvents(session.id),
    }));
  }

  dispose(): void {
    this.endSession();
    this.eventStore.dispose();
    this.sessions.clear();
  }
}
