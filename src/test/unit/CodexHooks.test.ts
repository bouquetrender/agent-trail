import * as assert from "assert";
import { exec } from "child_process";
import { promises as fs } from "fs";
import { homedir, tmpdir } from "os";
import * as path from "path";
import { CodexEventCollector } from "../../codex/CodexEventCollector";
import { CodexEventReader } from "../../codex/CodexEventReader";
import { codexHooksPath, eventDirectory, hookCommand, installCodexHooks, mergeHooks } from "../../codex/CodexHookSetup";
import { applyExactPatch, captureHook, capturePatch, isHookEvent, isObject, normalizeHook } from "../../codex/hook";
import type { CodexHookEvent, CodexPatch } from "../../codex/hook";
import { EventStore } from "../../session/EventStore";
import { SessionManager } from "../../session/SessionManager";

const root = path.resolve("/workspace/project");
const script = path.resolve(__dirname, "../../codex/hook.js");

function hook(phase: string, overrides: Record<string, unknown> = {}, timestamp = 100): CodexHookEvent {
  const event = normalizeHook({
    hook_event_name: phase, session_id: "session-1", turn_id: "turn-1", tool_use_id: "call-1",
    cwd: root, tool_name: "Bash", tool_input: { command: "npm test" },
    ...overrides,
  }, root, timestamp);
  assert.ok(event);
  assert.ok(isHookEvent(event));
  return event;
}

suite("Codex hook attribution", () => {
  test("reconstructs exact patch hunks and refuses ambiguous or fuzzy matches", () => {
    assert.strictEqual(applyExactPatch("a\nb\nc\n", ["@@", " a", "-b", "+B", " c"]), "a\nB\nc\n");
    assert.strictEqual(applyExactPatch("a\nx\nb\nx\n", ["@@", "-a", "+A", "@@", "-b", "+B"]), "A\nx\nB\nx\n");
    assert.strictEqual(applyExactPatch("a\na\n", ["@@", "-a", "+A"]), undefined);
    assert.strictEqual(applyExactPatch("a\na\n", ["@@", "-a", "+A", "*** End of File"]), "a\nA\n");
    assert.strictEqual(applyExactPatch("a\r\n", ["@@", "-a", "+A"]), undefined);
    assert.strictEqual(applyExactPatch(" a\n", ["@@", "-a", "+A"]), undefined);
  });

  test("requires matching pre/post contents before allowing file review", () => {
    const manager = new SessionManager(new EventStore(), () => 100);
    const confirmed: CodexPatch[] = [];
    const collector = new CodexEventCollector(manager, (patch) => confirmed.push(patch));
    collector.startRecording(100);
    const patch: CodexPatch = { path: path.join(root, "a.txt"), kind: "M", before: "a\n", after: "A\n" };
    const payload = { tool_name: "apply_patch", tool_input: { command: "patch" } };
    for (const [call, content] of [["mixed", "A\nuser\n"], ["confirmed", "A\n"]]) {
      collector.accept({ ...hook("PreToolUse", { ...payload, tool_use_id: call }), patches: [patch] });
      collector.accept({ ...hook("PostToolUse", { ...payload, tool_use_id: call,
        tool_response: "Success. Updated the following files:\nM a.txt\n" }), files: [{ path: patch.path, kind: "M", content }] });
    }
    assert.deepStrictEqual(confirmed, [patch]);
    manager.dispose();
  });

  test("only accepts supported Codex tool hooks within the workspace", () => {
    assert.strictEqual(normalizeHook({ hook_event_name: "PreToolUse", cwd: root }, root), undefined);
    for (const overrides of [
      { cwd: `${root}-other` }, { tool_name: "Read" }, { hook_event_name: "UserPromptSubmit" },
      { tool_use_id: "" }, { tool_input: { command: "npm test", workdir: path.dirname(root) } },
    ]) {
      assert.strictEqual(normalizeHook({
        hook_event_name: "PreToolUse", session_id: "s", tool_use_id: "c", cwd: root,
        tool_name: "Bash", tool_input: { command: "npm test" }, ...overrides,
      }, root), undefined);
    }
    assert.strictEqual(isHookEvent({ ...hook("PreToolUse"), timestamp: NaN }), false);
    assert.strictEqual(isHookEvent({ ...hook("PreToolUse"), files: [{ path: "/outside.txt", kind: "M" }] }), false);
  });

  test("extracts shell metadata without treating command stdout as an exit status", () => {
    const success = hook("PostToolUse", {
      tool_response: { output: "test output", metadata: { exit_code: 0, duration_seconds: 8.2 } },
    });
    assert.strictEqual(success.outcome, "succeeded");
    assert.strictEqual(success.durationMs, 8200);
    const failed = hook("PostToolUse", {
      tool_response: "Chunk ID: abc\nWall time: 1.2 seconds\nProcess exited with code 1\nFinal output:\nError\n",
    });
    assert.strictEqual(failed.exitCode, 1);
    assert.strictEqual(failed.outcome, "failed");
    const unknown = hook("PostToolUse", { tool_response: "Some log\nExit code: 0\nSuccess" });
    assert.strictEqual(unknown.outcome, "unknown");
    assert.strictEqual(unknown.exitCode, undefined);
    assert.strictEqual(unknown.durationMs, undefined);
    assert.ok(!JSON.stringify(success).includes("test output"));
  });

  test("records only confirmed patch paths, excluding outside paths and ignored folders", () => {
    const patch = {
      tool_name: "apply_patch", tool_input: { command: "private patch content" },
      tool_response: "Success. Updated the following files:\nA new.txt\nM src/a.ts\nD old.txt\nM ../outside.txt\nM .git/config\nM node_modules/a.js\n",
    };
    const event = hook("PostToolUse", patch);
    assert.deepStrictEqual(event.files.map((file) => file.kind), ["A", "M", "D"]);
    assert.ok(event.files.every((file) => file.path.startsWith(root + path.sep)));
    assert.ok(!JSON.stringify(event).includes("private patch content"));
    assert.deepStrictEqual(hook("PreToolUse", patch).files, []);
    assert.deepStrictEqual(hook("PostToolUse", { ...patch, tool_response: "apply_patch verification failed: no match" }).files, []);
    assert.deepStrictEqual(hook("PostToolUse", { ...patch, tool_response: { output: patch.tool_response, metadata: { exit_code: 1 } } }).files, []);
  });

  test("decodes JSON-serialized tool output before checking patch success and shell metadata", () => {
    const patch = {
      tool_name: "apply_patch", tool_input: { command: "patch" },
      tool_response: JSON.stringify({
        output: "Success. Updated the following files:\nM a.txt\n",
        metadata: { exit_code: 0, duration_seconds: 0.2 },
      }),
    };
    const event = hook("PostToolUse", patch);
    assert.strictEqual(event.outcome, "succeeded");
    assert.strictEqual(event.exitCode, 0);
    assert.strictEqual(event.durationMs, 200);
    assert.deepStrictEqual(event.files, [{ path: path.join(root, "a.txt"), kind: "M" }]);
    const failed = hook("PostToolUse", { ...patch, tool_response: JSON.stringify({
      output: "Success. Updated the following files:\nM a.txt\n",
      metadata: { exit_code: 1 },
    }) });
    assert.strictEqual(failed.outcome, "failed");
    assert.deepStrictEqual(failed.files, []);
    const shell = hook("PostToolUse", { tool_response: JSON.stringify({
      output: "test output", metadata: { exit_code: 0, duration_seconds: 8.2 },
    }) });
    assert.strictEqual(shell.exitCode, 0);
    assert.strictEqual(shell.durationMs, 8200);
    for (const tool_response of ["{invalid json", "null", "[]", JSON.stringify({ output: "unrecognized output" })]) {
      const unknown = hook("PostToolUse", { ...patch, tool_response });
      assert.strictEqual(unknown.outcome, "unknown");
      assert.deepStrictEqual(unknown.files, []);
    }
  });

  test("reads the Codex apply_patch result envelope before confirming changed files", () => {
    const payload = { tool_name: "apply_patch", tool_input: { command: "patch" } };
    const output = `Success. Updated the following files:\nM ${path.join(root, "a.txt")}\nA new.txt\nD old.txt\n`;
    for (const lineCount of ["", "Total output lines: 4\n"]) {
      const event = hook("PostToolUse", { ...payload,
        tool_response: `Exit code: 0\nWall time: 0.1 seconds\n${lineCount}Output:\n${output}`,
      });
      assert.strictEqual(event.outcome, "succeeded");
      assert.strictEqual(event.exitCode, 0);
      assert.strictEqual(event.durationMs, 100);
      assert.deepStrictEqual(event.files, [
        { path: path.join(root, "a.txt"), kind: "M" },
        { path: path.join(root, "new.txt"), kind: "A" },
        { path: path.join(root, "old.txt"), kind: "D" },
      ]);
    }
    for (const tool_response of [
      `Exit code: 1\nWall time: 0.1 seconds\nOutput:\n${output}`,
      "Exit code: 0\nWall time: 0.1 seconds\nOutput:\napply_patch verification failed: no match",
    ]) {
      const event = hook("PostToolUse", { ...payload, tool_response });
      assert.strictEqual(event.outcome, "failed");
      assert.deepStrictEqual(event.files, []);
    }
    for (const tool_response of [
      `Exit code: 0\n${output}`,
      `Some log\nExit code: 0\nWall time: 0.1 seconds\nOutput:\n${output}`,
    ]) {
      const event = hook("PostToolUse", { ...payload, tool_response });
      assert.strictEqual(event.outcome, "unknown");
      assert.deepStrictEqual(event.files, []);
    }
  });

  test("deduplicates calls and keeps concurrent Codex sessions separate", () => {
    const manager = new SessionManager(new EventStore(), () => 100);
    const collector = new CodexEventCollector(manager);
    collector.startRecording(100);
    const first = hook("PreToolUse");
    collector.accept(first);
    collector.accept(first);
    collector.accept(hook("PreToolUse", { session_id: "session-2" }));
    collector.accept(hook("PostToolUse", { tool_response: { exit_code: 1 } }, 120));
    collector.accept(hook("SessionEnd", {}, 130));
    const sessions = manager.getSessions();
    assert.strictEqual(sessions.length, 2);
    assert.strictEqual(sessions[0].externalSessionId, "session-1");
    assert.strictEqual(sessions[0].status, "ended");
    assert.strictEqual(sessions[1].status, "active");
    const events = sessions[0].events;
    assert.deepStrictEqual(events.map((event) => event.type), ["session-start", "tool-call", "tool-call", "session-end"]);
    assert.ok(events[1].type === "tool-call" && events[2].type === "tool-call");
    assert.strictEqual(events[1].payload.phase, "requested");
    assert.strictEqual(events[2].payload.outcome, "failed");
    assert.strictEqual(events[2].externalCallId, "call-1");
    assert.strictEqual(events[2].externalTurnId, "turn-1");
    collector.stopRecording();
    assert.ok(manager.getSessions().every((session) => session.status === "ended"));
    manager.dispose();
  });

  test("ignores ordinary activity, old results and paused recording without affecting history", () => {
    const manager = new SessionManager(new EventStore(), () => 100);
    const collector = new CodexEventCollector(manager);
    collector.accept(hook("PreToolUse"));
    assert.deepStrictEqual(manager.getSessions(), []);
    collector.startRecording(100);
    collector.accept(hook("PreToolUse"));
    collector.stopRecording();
    const ended = manager.getSessions();
    collector.accept(hook("PreToolUse", { tool_use_id: "paused" }, 110));
    assert.deepStrictEqual(manager.getSessions(), ended);
    collector.startRecording(200);
    collector.accept(hook("PostToolUse", { tool_response: { exit_code: 0 } }, 210));
    collector.accept(hook("PreToolUse", { tool_use_id: "old" }, 190));
    assert.deepStrictEqual(manager.getSessions(), ended);
    manager.dispose();
  });

  test("emits successful patch file events once and never infers shell side effects", () => {
    const manager = new SessionManager(new EventStore(), () => 100);
    const collector = new CodexEventCollector(manager);
    collector.startRecording(100);
    const patch = { tool_name: "apply_patch", tool_input: { command: "patch" } };
    collector.accept(hook("PreToolUse", patch));
    const result = hook("PostToolUse", { ...patch, tool_response: "Success. Updated the following files:\nM a.txt\n" });
    collector.accept(result);
    collector.accept(result);
    collector.accept(hook("PreToolUse", { tool_use_id: "shell" }));
    collector.accept(hook("PostToolUse", { tool_use_id: "shell", tool_response: { exit_code: 0 } }));
    assert.strictEqual(manager.getSessions()[0].events.filter((event) => event.type === "file-modified").length, 1);
    manager.dispose();
  });
});

suite("Codex hook installation and local relay", () => {
  let fixture: string;
  let workspace: string;
  let storage: string;
  let codexHome: string;

  setup(async () => {
    fixture = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "agenttrail-hooks-")));
    workspace = path.join(fixture, "project ' with spaces");
    storage = path.join(fixture, "extension storage");
    codexHome = path.join(fixture, "codex home");
    await fs.mkdir(workspace);
  });

  teardown(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

  test("resolves hooks from the user home or a custom Codex home", () => {
    assert.strictEqual(codexHooksPath(""), path.join(homedir(), ".codex", "hooks.json"));
    assert.strictEqual(codexHooksPath(codexHome), path.join(codexHome, "hooks.json"));
  });

  test("installs outside the project without changing legacy project hooks", async () => {
    await fs.mkdir(path.join(workspace, ".codex"));
    const legacyPath = path.join(workspace, ".codex", "hooks.json");
    const legacy = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{
      type: "command", command: "old-machine-command", statusMessage: "AgentTrail Codex activity",
    }] }] } });
    await fs.writeFile(legacyPath, legacy);
    const config = await installCodexHooks(workspace, storage, script, process.execPath, codexHome);
    assert.strictEqual(config, path.join(codexHome, "hooks.json"));
    assert.strictEqual(await fs.readFile(legacyPath, "utf8"), legacy);
    assert.deepStrictEqual(await fs.readdir(path.dirname(legacyPath)), ["hooks.json"]);
  });

  test("captures only text patch snapshots and verifies actual post-tool content", async () => {
    const filename = path.join(workspace, "a.txt");
    await fs.writeFile(filename, "a\n");
    const command = "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+A\n*** Add File: new.txt\n+new\n*** End Patch";
    const patches = await capturePatch(command, workspace, workspace);
    assert.deepStrictEqual(patches, [
      { path: filename, kind: "M", before: "a\n", after: "A\n" },
      { path: path.join(workspace, "new.txt"), kind: "A", before: null, after: "new\n" },
    ]);
    await fs.writeFile(filename, "A\n");
    const result = await captureHook({ hook_event_name: "PostToolUse", session_id: "s", tool_use_id: "c", cwd: workspace,
      tool_name: "apply_patch", tool_input: { command }, tool_response: "Success. Updated the following files:\nM a.txt\n" }, workspace);
    assert.strictEqual(result?.files[0].content, "A\n");
    await fs.writeFile(filename, Buffer.from([255, 254]));
    assert.deepStrictEqual(await capturePatch(command, workspace, workspace), [patches[1]]);
    await fs.writeFile(filename, "delete\n");
    assert.deepStrictEqual(await capturePatch("*** Begin Patch\n*** Delete File: a.txt\n*** End Patch", workspace, workspace),
      [{ path: filename, kind: "D", before: "delete\n", after: null }]);
  });

  test("preserves custom hooks, backs up changes and installs idempotently", async () => {
    await fs.mkdir(codexHome);
    const original = { description: "existing settings", hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "existing-script", timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command: "on-stop" }] }],
    } };
    const config = path.join(codexHome, "hooks.json");
    await fs.writeFile(config, JSON.stringify(original));
    await installCodexHooks(workspace, storage, script, process.execPath, codexHome);
    const installed = await fs.readFile(config, "utf8");
    const parsed: unknown = JSON.parse(installed);
    assert.ok(isObject(parsed) && isObject(parsed.hooks) && Array.isArray(parsed.hooks.PreToolUse));
    assert.deepStrictEqual(parsed.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
    assert.deepStrictEqual(parsed.hooks.Stop, original.hooks.Stop);
    await installCodexHooks(workspace, storage, script, process.execPath, codexHome);
    assert.strictEqual(await fs.readFile(config, "utf8"), installed);
    const backups = (await fs.readdir(path.dirname(config))).filter((name) => name.includes("backup"));
    assert.strictEqual(backups.length, 1);
    assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(path.dirname(config), backups[0]), "utf8")), original);
    await assert.rejects(fs.access(path.join(workspace, ".codex")), { code: "ENOENT" });
  });

  test("connecting and updating one project preserves other project hooks", async () => {
    const otherWorkspace = path.join(fixture, "second project");
    await fs.mkdir(otherWorkspace);
    const config = await installCodexHooks(workspace, storage, script, process.execPath, codexHome);
    await installCodexHooks(otherWorkspace, storage, script, process.execPath, codexHome);
    const before: unknown = JSON.parse(await fs.readFile(config, "utf8"));
    assert.ok(isObject(before) && isObject(before.hooks));
    const updatedExecutable = path.join(fixture, "updated executable");
    await installCodexHooks(workspace, storage, script, updatedExecutable, codexHome);
    const installed = await fs.readFile(config, "utf8");
    const after: unknown = JSON.parse(installed);
    assert.ok(isObject(after) && isObject(after.hooks));
    for (const event of ["PreToolUse", "PostToolUse", "SessionEnd"]) {
      const oldGroups: unknown = before.hooks[event];
      const groups: unknown = after.hooks[event];
      assert.ok(Array.isArray(oldGroups) && Array.isArray(groups));
      assert.strictEqual(groups.length, 2);
      assert.deepStrictEqual(groups[0], oldGroups[1]);
      const updated: unknown = groups[1];
      assert.ok(isObject(updated) && Array.isArray(updated.hooks));
      assert.strictEqual(updated.hooks.length, 1);
      const handler: unknown = updated.hooks[0];
      assert.ok(isObject(handler) && typeof handler.command === "string");
      assert.strictEqual(handler.statusMessage, `AgentTrail Codex activity: ${workspace}`);
      assert.ok(handler.command.includes(updatedExecutable));
    }
    await installCodexHooks(workspace, storage, script, updatedExecutable, codexHome);
    assert.strictEqual(await fs.readFile(config, "utf8"), installed);
    await assert.rejects(fs.access(path.join(otherWorkspace, ".codex")), { code: "ENOENT" });
  });

  test("does not overwrite malformed hook configuration", async () => {
    await fs.mkdir(codexHome);
    const config = path.join(codexHome, "hooks.json");
    await fs.writeFile(config, "{invalid json");
    await assert.rejects(installCodexHooks(workspace, storage, script, process.execPath, codexHome));
    assert.strictEqual(await fs.readFile(config, "utf8"), "{invalid json");
    assert.throws(() => mergeHooks({ hooks: { PreToolUse: {} } }, "command", workspace), /Invalid Codex/);
    assert.throws(() => hookCommand("node", "%unsafe%", "root", "events", "win32"), /Hook paths/);
  });

  test("initializes empty hook configuration and backs up its original contents", async () => {
    await fs.mkdir(codexHome);
    const config = path.join(codexHome, "hooks.json");
    for (const previous of ["", " \n\t"]) {
      await fs.writeFile(config, previous);
      assert.strictEqual(await installCodexHooks(workspace, storage, script, process.execPath, codexHome), config);
      const installed: unknown = JSON.parse(await fs.readFile(config, "utf8"));
      assert.ok(isObject(installed) && isObject(installed.hooks));
      for (const event of ["PreToolUse", "PostToolUse", "SessionEnd"]) {
        const groups: unknown = installed.hooks[event];
        assert.ok(Array.isArray(groups));
        assert.strictEqual(groups.length, 1);
      }
      const backups = (await fs.readdir(codexHome)).filter((name) => name.startsWith("hooks.json.agenttrail-backup-"));
      assert.strictEqual(backups.length, 1);
      const backup = path.join(codexHome, backups[0]);
      assert.strictEqual(await fs.readFile(backup, "utf8"), previous);
      await fs.unlink(backup);
    }
  });

  test("runs the installed hook command and delivers each event to both open readers", async function () {
    this.timeout(10_000);
    if (process.platform === "win32") { this.skip(); }
    const received: CodexHookEvent[][] = [[], []];
    const errors: unknown[] = [];
    const readers = received.map((events) => new CodexEventReader(storage, workspace,
      (event) => events.push(event), (error) => errors.push(error)));
    try {
      await Promise.all(readers.map((reader) => reader.start()));
      const config = await installCodexHooks(workspace, storage, script, process.execPath, codexHome);
      const parsed: unknown = JSON.parse(await fs.readFile(config, "utf8"));
      assert.ok(isObject(parsed) && isObject(parsed.hooks) && Array.isArray(parsed.hooks.PreToolUse));
      const group: unknown = parsed.hooks.PreToolUse[0];
      assert.ok(isObject(group) && Array.isArray(group.hooks));
      const handler: unknown = group.hooks[0];
      assert.ok(isObject(handler) && typeof handler.command === "string");
      const command = handler.command;
      const otherWorkspace = path.join(fixture, "unconnected project");
      await fs.mkdir(otherWorkspace);
      for (const cwd of [otherWorkspace, workspace]) {
        await new Promise<void>((resolve, reject) => {
          const child = exec(command, (error, stdout) => {
            if (error) { reject(error); } else { assert.strictEqual(stdout, ""); resolve(); }
          });
          child.stdin?.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "real-relay",
            tool_use_id: cwd === workspace ? "real-call" : "unconnected-call",
            cwd, tool_name: "Bash", tool_input: { command: "npm test" } }));
        });
      }
      const deadline = Date.now() + 5000;
      while (received.some((events) => events.length === 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(received.map((events) => events.length), [1, 1]);
      assert.strictEqual(received[0][0].sessionId, "real-relay");
      assert.strictEqual(received[0][0].command, "npm test");
      assert.strictEqual(received[0][0].cwd, workspace);
    } finally {
      readers.forEach((reader) => reader.dispose());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  test("does not retain events when the editor is closed", async () => {
    const directory = eventDirectory(storage, workspace);
    const inbox = path.join(directory, "expired-listener");
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(path.join(inbox, "lease.json"), JSON.stringify({ expiresAt: 1 }));
    const command = hookCommand(process.execPath, script, workspace, directory);
    await new Promise<void>((resolve, reject) => {
      const child = exec(command, (error) => error ? reject(error) : resolve());
      child.stdin?.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "closed",
        tool_use_id: "call", cwd: workspace, tool_name: "Bash", tool_input: { command: "npm test" } }));
    });
    assert.deepStrictEqual(await fs.readdir(inbox), ["lease.json"]);
  });
});
