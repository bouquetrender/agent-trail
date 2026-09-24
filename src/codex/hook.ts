import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { TextDecoder } from "util";

export interface CodexPatch {
  readonly path: string;
  readonly kind: "A" | "M" | "D";
  readonly before: string | null;
  readonly after: string | null;
}

export interface CodexHookEvent {
  readonly version: 1;
  readonly id: string;
  readonly workspace: string;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly phase: "requested" | "completed" | "session-end";
  readonly tool: "Bash" | "apply_patch" | "";
  readonly command: string;
  readonly cwd: string;
  readonly outcome: "succeeded" | "failed" | "unknown";
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly files: readonly { readonly path: string; readonly kind: "A" | "M" | "D"; readonly content?: string | null }[];
  readonly patches: readonly CodexPatch[];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function allowedFile(root: string, target: string): boolean {
  return isWithin(root, target) && target !== root &&
    !path.relative(root, target).split(path.sep).some((part) => part === ".git" || part === "node_modules");
}

export function normalizeHook(input: unknown, workspace: string, timestamp = Date.now()): CodexHookEvent | undefined {
  if (!isObject(input) || typeof input.session_id !== "string" || !input.session_id ||
      typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || !isWithin(workspace, input.cwd)) {
    return undefined;
  }
  const phase = input.hook_event_name === "PreToolUse" ? "requested"
    : input.hook_event_name === "PostToolUse" ? "completed"
      : input.hook_event_name === "SessionEnd" ? "session-end" : undefined;
  if (!phase) {
    return undefined;
  }
  const tool = input.tool_name;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  if (phase !== "session-end" && ((tool !== "Bash" && tool !== "apply_patch") ||
      typeof input.tool_use_id !== "string" || !input.tool_use_id || typeof toolInput.command !== "string")) {
    return undefined;
  }
  const cwdInput = typeof toolInput.workdir === "string" ? toolInput.workdir
    : typeof toolInput.cwd === "string" ? toolInput.cwd : input.cwd;
  const cwd = path.resolve(input.cwd, cwdInput);
  if (!isWithin(workspace, cwd)) {
    return undefined;
  }
  let response: unknown = input.tool_response;
  // Codex can pass its model-facing JSON envelope as a string in tool_response.
  if (typeof response === "string" && response.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(response);
      if (isObject(parsed)) { response = parsed; }
    } catch (error) {
      // Plain tool output need not be valid JSON; keep it for text-format parsing.
      if (!(error instanceof SyntaxError)) { throw error; }
    }
  }
  const result = isObject(response) ? response : {};
  const metadata = isObject(result.metadata) ? result.metadata : result;
  let output = typeof response === "string" ? response : typeof result.output === "string" ? result.output : "";
  const rawExit = metadata.exit_code ?? metadata.exitCode;
  let exitCode = typeof rawExit === "number" && Number.isInteger(rawExit) ? rawExit : undefined;
  let durationMs = typeof metadata.duration_seconds === "number" ? metadata.duration_seconds * 1000 : undefined;
  // These are tool envelopes, not arbitrary lines from the command's stdout.
  const shellEnvelope = /^(?:Chunk ID: [^\n]+\n)?Wall time: ([\d.]+) seconds\n(?:Process exited with code |Exit code: )(-?\d+)\n(?:Final output:|Output:)\n/.exec(output);
  if (tool === "Bash" && shellEnvelope) {
    exitCode = Number(shellEnvelope[2]);
    durationMs = Number(shellEnvelope[1]) * 1000;
  }
  // apply_patch includes a model-facing envelope with the exit code before wall time.
  const patchEnvelope = tool === "apply_patch" && typeof response === "string"
    ? /^Exit code: (-?\d+)\nWall time: (\d+(?:\.\d+)?) seconds\n(?:Total output lines: \d+\n)?Output:\n/.exec(output) : null;
  if (patchEnvelope) {
    exitCode = Number(patchEnvelope[1]);
    durationMs = Number(patchEnvelope[2]) * 1000;
    output = output.slice(patchEnvelope[0].length);
  }
  const patchSuccess = tool === "apply_patch" && output.startsWith("Success. Updated the following files:\n");
  const failed = (exitCode !== undefined && exitCode !== 0) || result.success === false ||
    result.isError === true || result.error !== undefined || output.startsWith("apply_patch verification failed:");
  const outcome = failed ? "failed" : exitCode === 0 || patchSuccess ? "succeeded" : "unknown";
  const files: { path: string; kind: "A" | "M" | "D" }[] = [];
  if (phase === "completed" && outcome === "succeeded" && patchSuccess) {
    for (const line of output.trimEnd().split("\n").slice(1)) {
      const match = /^([AMD]) (.+)$/.exec(line);
      if (!match) {
        continue;
      }
      const kind = match[1];
      const filename = path.resolve(cwd, match[2]);
      if ((kind === "A" || kind === "M" || kind === "D") && allowedFile(workspace, filename)) {
        files.push({ path: filename, kind });
      }
    }
  }
  const turnId = typeof input.turn_id === "string" ? input.turn_id : "";
  const callId = typeof input.tool_use_id === "string" ? input.tool_use_id : "";
  return {
    version: 1,
    id: createHash("sha256").update(JSON.stringify([input.session_id, turnId, callId, phase, phase === "session-end" ? timestamp : ""])).digest("hex"),
    workspace,
    timestamp,
    sessionId: input.session_id,
    turnId,
    callId,
    phase,
    tool: tool === "Bash" || tool === "apply_patch" ? tool : "",
    command: tool === "Bash" && typeof toolInput.command === "string" ? toolInput.command : "",
    cwd,
    outcome,
    exitCode,
    durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
    files,
    patches: [],
  };
}

export function isHookEvent(value: unknown): value is CodexHookEvent {
  return isObject(value) && value.version === 1 && typeof value.id === "string" &&
    typeof value.workspace === "string" && path.isAbsolute(value.workspace) &&
    typeof value.timestamp === "number" && Number.isFinite(value.timestamp) &&
    typeof value.sessionId === "string" && value.sessionId.length > 0 &&
    typeof value.turnId === "string" && typeof value.callId === "string" &&
    (value.phase === "requested" || value.phase === "completed" || value.phase === "session-end") &&
    (value.tool === "Bash" || value.tool === "apply_patch" || value.tool === "") &&
    typeof value.command === "string" && typeof value.cwd === "string" && path.isAbsolute(value.cwd) &&
    (value.outcome === "succeeded" || value.outcome === "failed" || value.outcome === "unknown") &&
    (value.exitCode === undefined || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
    (value.durationMs === undefined || (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0)) &&
    Array.isArray(value.files) && value.files.every((file: unknown) => isObject(file) &&
      typeof file.path === "string" && path.isAbsolute(file.path) && typeof value.workspace === "string" && allowedFile(value.workspace, file.path) &&
      (file.kind === "A" || file.kind === "M" || file.kind === "D") &&
      (file.content === undefined || file.content === null || typeof file.content === "string")) &&
    Array.isArray(value.patches) && value.patches.every((patch: unknown) => isObject(patch) &&
      typeof patch.path === "string" && path.isAbsolute(patch.path) && typeof value.workspace === "string" && allowedFile(value.workspace, patch.path) &&
      (patch.kind === "A" || patch.kind === "M" || patch.kind === "D") &&
      (patch.before === null || typeof patch.before === "string") &&
      (patch.after === null || typeof patch.after === "string"));
}

// Reconstruct only exact, unambiguous hunks. Fuzzy or unsupported patches stay unreviewable.
export function applyExactPatch(before: string, patch: readonly string[]): string | undefined {
  if (before.includes("\r")) { return undefined; }
  const lines = before.split("\n");
  if (lines[lines.length - 1] === "") { lines.pop(); }
  let cursor = 0;
  let position = 0;
  while (position < patch.length) {
    const header = patch[position];
    if (header === "@@" || header.startsWith("@@ ")) {
      position++;
      if (header.startsWith("@@ ")) {
        const anchor = lines.indexOf(header.slice(3), cursor);
        if (anchor < 0) { return undefined; }
        cursor = anchor + 1;
      }
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let endOfFile = false;
    const start = position;
    while (position < patch.length && !patch[position].startsWith("@@")) {
      const line = patch[position++];
      if (line === "*** End of File") { endOfFile = true; break; }
      if (line.startsWith(" ")) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); }
      else if (line.startsWith("-")) { oldLines.push(line.slice(1)); }
      else if (line.startsWith("+")) { newLines.push(line.slice(1)); }
      else { return undefined; }
    }
    if (position === start) { return undefined; }
    const matches: number[] = [];
    if (oldLines.length === 0) {
      matches.push(lines.length);
    } else {
      for (let index = cursor; index <= lines.length - oldLines.length; index++) {
        if ((!endOfFile || index + oldLines.length === lines.length) &&
            oldLines.every((line, offset) => lines[index + offset] === line)) {
          matches.push(index);
        }
      }
    }
    if (matches.length !== 1) { return undefined; }
    lines.splice(matches[0], oldLines.length, ...newLines);
    cursor = matches[0] + newLines.length;
  }
  return `${lines.join("\n")}\n`;
}

async function readSnapshot(filename: string, workspace: string): Promise<string | null | undefined> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) { return undefined; }
    if (!allowedFile(workspace, await fs.realpath(filename))) { return undefined; }
    const bytes = await fs.readFile(filename);
    if (bytes.includes(0)) { return undefined; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (isMissing(error)) { return null; }
    if (error instanceof TypeError) { return undefined; }
    throw error;
  }
}

export async function capturePatch(command: string, cwd: string, workspace: string): Promise<readonly CodexPatch[]> {
  const lines = command.trim().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") { return []; }
  const patches: CodexPatch[] = [];
  let position = 1;
  while (position < lines.length - 1) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[position++]);
    if (!header) { return []; }
    const filename = path.resolve(cwd, header[2]);
    const body: string[] = [];
    while (position < lines.length - 1 && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[position])) {
      body.push(lines[position++]);
    }
    if (!allowedFile(workspace, filename)) { continue; }
    const before = await readSnapshot(filename, workspace);
    if (header[1] === "Add" && before === null && body.every((line) => line.startsWith("+"))) {
      patches.push({ path: filename, kind: "A", before, after: body.length ? `${body.map((line) => line.slice(1)).join("\n")}\n` : "" });
    } else if (header[1] === "Delete" && typeof before === "string" && body.length === 0) {
      patches.push({ path: filename, kind: "D", before, after: null });
    } else if (header[1] === "Update" && typeof before === "string") {
      const moveHeader = body[0];
      const move = moveHeader?.startsWith("*** Move to: ") ? path.resolve(cwd, moveHeader.slice(13)) : undefined;
      if (move) { body.shift(); }
      const after = applyExactPatch(before, body);
      if (after === undefined) { continue; }
      if (move) {
        if (allowedFile(workspace, move) && await readSnapshot(move, workspace) === null) {
          patches.push({ path: filename, kind: "D", before, after: null }, { path: move, kind: "A", before: null, after });
        }
      } else {
        patches.push({ path: filename, kind: "M", before, after });
      }
    }
  }
  return patches.filter((item, index) => patches.findIndex((other) => other.path === item.path) === index);
}

export async function captureHook(input: unknown, workspace: string): Promise<CodexHookEvent | undefined> {
  const event = normalizeHook(input, workspace);
  if (!event || event.tool !== "apply_patch" || !isObject(input) || !isObject(input.tool_input)) { return event; }
  if (event.phase === "requested" && typeof input.tool_input.command === "string") {
    return { ...event, patches: await capturePatch(input.tool_input.command, event.cwd, workspace) };
  }
  return { ...event, files: await Promise.all(event.files.map(async (file) => ({
    ...file, content: await readSnapshot(file.path, workspace),
  }))) };
}

export function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

export function eventDirectory(storage: string, workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(storage, "codex-events", key);
}

async function relayWorkspace(input: unknown, storage: string, workspace: string): Promise<void> {
  const directory = eventDirectory(storage, workspace);
  const listeners = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) { return []; }
    throw error;
  });
  let event: CodexHookEvent | undefined;
  for (const listener of listeners) {
    if (!listener.isDirectory()) { continue; }
    const inbox = path.join(directory, listener.name);
    try {
      const lease: unknown = JSON.parse(await fs.readFile(path.join(inbox, "lease.json"), "utf8"));
      if (!isObject(lease) || typeof lease.expiresAt !== "number" || lease.expiresAt < Date.now()) { continue; }
      event ??= await captureHook(input, workspace);
      if (!event) { return; }
      const temporary = path.join(inbox, `${randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(event), { mode: 0o600 });
      await fs.rename(temporary, path.join(inbox, `${event.id}.json`));
    } catch (error) {
      if (!isMissing(error)) { throw error; }
    }
  }
}

async function relay(): Promise<void> {
  const [storage] = process.argv.slice(2);
  if (!storage) {
    throw new Error("Expected extension storage argument.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isObject(input) || typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) { return; }
  const cwd = await fs.realpath(input.cwd);
  input.cwd = cwd;
  // Readers register automatically when a trusted project opens. Check its ancestors
  // so tools running in subdirectories also reach the matching workspace(s).
  for (let workspace = cwd; ; workspace = path.dirname(workspace)) {
    await relayWorkspace(input, storage, workspace);
    if (path.dirname(workspace) === workspace) { break; }
  }
}

if (require.main === module) {
  void relay().catch((error: unknown) => {
    process.stderr.write(`AgentTrail hook: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
