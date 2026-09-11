import { EventEmitter } from "events";
import type { AgentEvent } from "./AgentSession";

export class EventStore {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly changeEmitter = new EventEmitter();

  readonly onDidChange = (listener: () => void): { dispose(): void } => {
    this.changeEmitter.on("change", listener);
    return { dispose: () => this.changeEmitter.off("change", listener) };
  };

  append(event: AgentEvent): void {
    const events = this.events.get(event.sessionId) ?? [];
    // Payloads contain only primitive values and are immutable event data.
    Object.freeze(event.payload);
    const snapshot = Object.freeze({ ...event });
    events.push(snapshot);
    this.events.set(event.sessionId, events);
    this.changeEmitter.emit("change");
  }

  getEvents(sessionId: string): readonly AgentEvent[] {
    return Object.freeze(
      [...(this.events.get(sessionId) ?? [])].sort(
        (a, b) => a.timestamp - b.timestamp,
      ),
    );
  }

  dispose(): void {
    this.events.clear();
    this.changeEmitter.removeAllListeners();
  }
}
