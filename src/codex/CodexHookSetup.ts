import { createHash } from "crypto";
import { promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";
import { isMissing, isObject } from "./hook";

const OWNER = "AgentTrail Codex activity";

export function codexHooksPath(codexHome = process.env.CODEX_HOME): string {
  return path.join(codexHome || path.join(homedir(), ".codex"), "hooks.json");
}

export function eventDirectory(storage: string, workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(storage, "codex-events", key);
}

export function hookCommand(executable: string, script: string, workspace: string, directory: string, platform = process.platform): string {
  const args = [executable, script, workspace, directory];
  if (platform === "win32") {
    // cmd expands these even inside quotes; fail explicitly instead of installing a broken command.
    if (args.some((arg) => /["%\r\n!]/.test(arg))) {
      throw new Error("Hook paths cannot contain quotes, %, ! or newlines on Windows.");
    }
    return `set "ELECTRON_RUN_AS_NODE=1" && ${args.map((arg) => `"${arg}"`).join(" ")}`;
  }
  return `ELECTRON_RUN_AS_NODE=1 ${args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")}`;
}

export function mergeHooks(value: unknown, command: string, workspace: string): Record<string, unknown> {
  if (!isObject(value) || (value.hooks !== undefined && !isObject(value.hooks))) {
    throw new Error("Codex hooks.json must contain an object with an optional hooks object.");
  }
  const hooks = { ...(isObject(value.hooks) ? value.hooks : {}) };
  const owner = `${OWNER}: ${workspace}`;
  for (const event of ["PreToolUse", "PostToolUse", "SessionEnd"]) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups) || !groups.every((group: unknown) => isObject(group) && Array.isArray(group.hooks))) {
      throw new Error(`Invalid Codex ${event} hook configuration; existing configuration was not changed.`);
    }
    const preserved: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) { continue; }
      const handlers = group.hooks.filter((handler: unknown) => !isObject(handler) || handler.statusMessage !== owner);
      if (handlers.length > 0 || group.hooks.length === 0) {
        preserved.push({ ...group, hooks: handlers });
      }
    }
    hooks[event] = [...preserved, {
      ...(event === "SessionEnd" ? {} : { matcher: "^(Bash|apply_patch)$" }),
      hooks: [{ type: "command", command, timeout: 5, statusMessage: owner }],
    }];
  }
  return { ...value, hooks };
}

export async function installCodexHooks(workspace: string, storage: string, bundledScript: string, executable: string, codexHome?: string): Promise<string> {
  const configPath = codexHooksPath(codexHome);
  let previous: string | undefined;
  try {
    previous = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissing(error)) { throw error; }
  }
  const scriptContent = await fs.readFile(bundledScript);
  const digest = createHash("sha256").update(scriptContent).digest("hex").slice(0, 16);
  const scriptPath = path.join(storage, "codex-hooks", `hook-${digest}.js`);
  const command = hookCommand(executable, scriptPath, workspace, eventDirectory(storage, workspace));
  const parsed: unknown = previous === undefined || previous.trim() === "" ? {} : JSON.parse(previous);
  const next = `${JSON.stringify(mergeHooks(parsed, command, workspace), null, 2)}\n`;
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, scriptContent, { mode: 0o600 });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  if (previous !== next) {
    if (previous !== undefined) {
      await fs.writeFile(`${configPath}.agenttrail-backup-${Date.now()}`, previous, { flag: "wx", mode: 0o600 });
    }
    await fs.writeFile(configPath, next);
  }
  return configPath;
}
