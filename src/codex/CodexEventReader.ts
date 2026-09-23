import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { eventDirectory } from "./CodexHookSetup";
import { isHookEvent, isMissing, isWithin } from "./hook";
import type { CodexHookEvent } from "./hook";

export class CodexEventReader {
  private readonly inbox: string;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private failed = false;

  constructor(
    storage: string,
    private readonly workspace: string,
    private readonly receive: (event: CodexHookEvent) => void,
    private readonly reportError: (error: unknown) => void,
  ) {
    this.inbox = path.join(eventDirectory(storage, workspace), randomUUID());
  }

  async start(): Promise<void> {
    this.pending = fs.mkdir(this.inbox, { recursive: true, mode: 0o700 }).then(() => this.poll());
    await this.pending;
    if (!this.disposed) {
      this.timer = setInterval(() => {
        this.pending = this.pending.then(() => this.poll()).catch((error: unknown) => {
          if (!this.failed && !this.disposed) { this.reportError(error); }
          this.failed = true;
        });
      }, 500);
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed) { return; }
    const temporaryLease = path.join(this.inbox, "lease.tmp");
    await fs.writeFile(temporaryLease, JSON.stringify({ expiresAt: Date.now() + 10_000 }));
    await fs.rename(temporaryLease, path.join(this.inbox, "lease.json"));
    const entries: { filename: string; event: CodexHookEvent }[] = [];
    for (const name of await fs.readdir(this.inbox)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) { continue; }
      const filename = path.join(this.inbox, name);
      try {
        const value: unknown = JSON.parse(await fs.readFile(filename, "utf8"));
        if (!isHookEvent(value) || value.workspace !== this.workspace || !isWithin(this.workspace, value.cwd)) {
          throw new Error(`Invalid Codex event: ${name}`);
        }
        entries.push({ filename, event: value });
      } catch (error) {
        this.reportError(error);
        await fs.unlink(filename).catch((unlinkError: unknown) => {
          if (!isMissing(unlinkError)) { throw unlinkError; }
        });
      }
    }
    const order = { requested: 0, completed: 1, "session-end": 2 };
    entries.sort((a, b) => a.event.timestamp - b.event.timestamp || order[a.event.phase] - order[b.event.phase]);
    for (const entry of entries) {
      if (!this.disposed) { this.receive(entry.event); }
      await fs.unlink(entry.filename);
    }
    this.failed = false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); }
    void this.pending.then(() => fs.rm(this.inbox, { recursive: true, force: true })).catch(this.reportError);
  }
}
