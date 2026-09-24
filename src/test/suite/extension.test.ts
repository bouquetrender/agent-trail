import * as assert from "assert";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DiffService } from "../../diff/DiffService";
import { MemoryBaselineStore } from "../../session/MemoryBaselineStore";
import { ReviewSession } from "../../session/ReviewSession";
import { codexWrite, connectTestCodex } from "./codexFixture";
import { normalizeHook } from "../../codex/hook";
import { AgentEventItem, AgentSessionItem, SessionTimelineProvider } from "../../ui/SessionTimelineProvider";
import { WorkspaceBaselineStore } from "../../session/WorkspaceBaselineStore";
import { ChangeStatusBar } from "../../ui/ChangeStatusBar";
import { SelectionHoverProvider } from "../../ui/SelectionHoverProvider";
import { FileCommands } from "../../commands/FileCommands";
import { BaselineContentProvider } from "../../ui/BaselineContentProvider";
import {
  AllAgentChangesItem,
  ChangeTreeProvider,
  CurrentTurnItem,
  FileChangeItem,
  HunkChangeItem,
} from "../../ui/ChangeTreeProvider";

const ORIGINAL = "alpha\nbeta\ngamma\n";
const MODIFIED = "alpha\nBETA\ngamma\n";
const SECOND_ORIGINAL = "red\ngreen\nblue\n";
const SECOND_MODIFIED = "red\nGREEN\nblue\n";

suite("AgentTrail extension", function () {
  this.timeout(5_000);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder);
  const sampleUri = vscode.Uri.joinPath(workspaceFolder.uri, "sample.txt");
  const secondUri = vscode.Uri.joinPath(workspaceFolder.uri, "second.txt");
  const createdUri = vscode.Uri.joinPath(workspaceFolder.uri, "created.txt");
  const deletedUri = vscode.Uri.joinPath(workspaceFolder.uri, "deleted.txt");

  suiteSetup(async function () {
    this.timeout(10_000);
    await connectTestCodex();
  });

  setup(async () => {
    await deleteIfExists(createdUri);
    await deleteIfExists(deletedUri);
    await replaceAndSave(sampleUri, ORIGINAL);
    await replaceAndSave(secondUri, SECOND_ORIGINAL);
    await vscode.commands.executeCommand("cursorForgery.startSession");
  });

  teardown(async () => {
    await deleteIfExists(createdUri);
    await deleteIfExists(deletedUri);
    await replaceAndSave(sampleUri, ORIGINAL);
    await replaceAndSave(secondUri, SECOND_ORIGINAL);
  });

  test("registers the complete review command set", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "cursorForgery.startSession",
      "cursorForgery.resetSession",
      "cursorForgery.endAgentSession",
      "cursorForgery.connectCodex",
      "cursorForgery.openHunk",
      "cursorForgery.openHunkDiff",
      "cursorForgery.acceptHunk",
      "cursorForgery.rejectHunk",
      "cursorForgery.requestHunkChange",
      "cursorForgery.acceptFile",
      "cursorForgery.rejectFile",
      "cursorForgery.acceptAll",
      "cursorForgery.rejectAll",
      "cursorForgery.addToCodexThread",
    ]) {
      assert.ok(commands.includes(command), `${command} is not registered`);
    }
  });

  test("uses an isolated mutable Git tree without changing the real index", async () => {
    const store = new WorkspaceBaselineStore();
    const realIndexPath = path.join(workspaceFolder.uri.fsPath, ".git", "index");
    const realIndexBefore = readFileSync(realIndexPath);

    await store.capture({ uris: [sampleUri, secondUri] });
    assert.strictEqual(store.kind, "git");
    assert.strictEqual(await store.get(sampleUri), ORIGINAL);

    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
    assert.strictEqual(await store.get(sampleUri), ORIGINAL);
    await store.set(sampleUri, MODIFIED);
    assert.strictEqual(await store.get(sampleUri), MODIFIED);
    assert.deepStrictEqual(readFileSync(realIndexPath), realIndexBefore);
    store.clear();
  });

  test("retains the memory store as a non-Git fallback", async () => {
    const store = new MemoryBaselineStore();
    await store.capture({ uris: [sampleUri] });

    assert.strictEqual(store.kind, "memory");
    assert.strictEqual(await store.get(sampleUri), ORIGINAL);
    await store.set(sampleUri, MODIFIED);
    assert.strictEqual(await store.get(sampleUri), MODIFIED);
    store.clear();
  });

  test("offers selection actions in a hover without adding CodeLens rows", async () => {
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const editor = await vscode.window.showTextDocument(document);
    const provider = new SelectionHoverProvider();
    const originalGetExtension = vscode.extensions.getExtension;
    try {
      vscode.extensions.getExtension = <T>(id: string) => originalGetExtension<T>(
        id === "openai.chatgpt" ? "local.agent-trail" : id,
      );
      editor.selection = new vscode.Selection(1, 0, 2, 0);
      const hover = provider.provideHover(document, editor.selection.active);
      assert.ok(hover);
      assert.ok(hover.range?.isEqual(editor.selection));
      const contents = hover.contents[0];
      assert.ok(contents instanceof vscode.MarkdownString);
      assert.match(contents.value, /Add Selection\]\(command:chatgpt.addToThread\)/);
      assert.ok(contents.value.includes(
        `Add File](command:chatgpt.addFileToThread?${encodeURIComponent(JSON.stringify([document.uri]))})`,
      ));
      assert.ok(contents.value.includes(
        `Add Folder](command:chatgpt.addFileToThread?${encodeURIComponent(JSON.stringify([vscode.Uri.file(path.dirname(document.uri.fsPath))]))})`,
      ));
      assert.deepStrictEqual(contents.isTrusted, {
        enabledCommands: ["chatgpt.addToThread", "chatgpt.addFileToThread"],
      });
      assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
      assert.strictEqual(provider.provideHover(document, new vscode.Position(0, 0)), undefined);
      const otherDocument = await vscode.workspace.openTextDocument(secondUri);
      assert.strictEqual(provider.provideHover(otherDocument, editor.selection.active), undefined);
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      assert.strictEqual(provider.provideHover(document, editor.selection.active), undefined);
      editor.selection = new vscode.Selection(2, 0, 1, 0);
      assert.ok(provider.provideHover(document, editor.selection.active));
      vscode.extensions.getExtension = originalGetExtension;
      assert.strictEqual(provider.provideHover(document, editor.selection.active), undefined);
    } finally {
      vscode.extensions.getExtension = originalGetExtension;
      provider.dispose();
      editor.selection = new vscode.Selection(0, 0, 0, 0);
    }
  });

  test("automatically shows selection hover after movement settles and cancels for an empty selection", async () => {
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const originalGetExtension = vscode.extensions.getExtension;
    const originalExecute = vscode.commands.executeCommand;
    const hoverArgs: unknown[][] = [];
    try {
      vscode.extensions.getExtension = <T>(id: string) => originalGetExtension<T>(
        id === "openai.chatgpt" ? "local.agent-trail" : id,
      );
      vscode.commands.executeCommand = <T>(command: string, ...args: unknown[]) => {
        if (command === "editor.action.showHover") {
          hoverArgs.push(args);
        }
        return originalExecute<T>(command, ...args);
      };
      editor.selection = new vscode.Selection(0, 0, 1, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const selection = new vscode.Selection(0, 0, 2, 0);
      editor.selection = selection;
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.deepStrictEqual(hoverArgs, [[{ focus: "noAutoFocus" }]]);
      assert.ok(editor.selection.isEqual(selection));
      assert.strictEqual(document.getText(), ORIGINAL);

      editor.selection = new vscode.Selection(0, 0, 1, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.strictEqual(hoverArgs.length, 1);
    } finally {
      vscode.extensions.getExtension = originalGetExtension;
      vscode.commands.executeCommand = originalExecute;
      editor.selection = new vscode.Selection(0, 0, 0, 0);
    }
  });

  test("shows session lifecycle and pending file counts in the status bar", async () => {
    const store = new class extends MemoryBaselineStore {
      failCapture = false;

      async capture(): Promise<void> {
        if (this.failCapture) {
          throw new Error("Capture failed");
        }
        await super.capture({ uris: [sampleUri, secondUri] });
      }
    }();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    const items: vscode.StatusBarItem[] = [];
    const originalCreate = vscode.window.createStatusBarItem;
    vscode.window.createStatusBarItem = (
      idOrAlignment?: string | vscode.StatusBarAlignment,
      alignmentOrPriority?: number,
      priority?: number,
    ): vscode.StatusBarItem => {
      const item = typeof idOrAlignment === "string"
        ? originalCreate(idOrAlignment, alignmentOrPriority, priority)
        : originalCreate(idOrAlignment, alignmentOrPriority);
      items.push(item);
      return item;
    };
    let statusBar: ChangeStatusBar;
    try {
      statusBar = new ChangeStatusBar(diffs, session);
    } finally {
      vscode.window.createStatusBarItem = originalCreate;
    }
    const item = items[0];
    const states: string[] = [];
    const subscription = session.onDidChangeState((state) => states.push(state));
    try {
      assert.strictEqual(session.getState(), "inactive");
      assert.match(item.text, /Not started/);
      assert.strictEqual(item.command, "cursorForgery.startSession");
      const start = session.start();
      assert.strictEqual(session.getState(), "capturing");
      assert.strictEqual(session.isActive(), false);
      assert.match(item.text, /Capturing baseline/);
      await start;
      assert.strictEqual(session.getState(), "ready");
      assert.strictEqual(session.isActive(), true);
      assert.strictEqual(item.text, "$(diff) 0 files · 0 changes");
      assert.strictEqual(item.command, "cursorForgery.changes.focus");

      await store.set(sampleUri, "ALPHA\nbeta\nGAMMA\n");
      await store.set(secondUri, SECOND_MODIFIED);
      await diffs.recomputeAll();
      assert.strictEqual(item.text, "$(diff) 2 files · 3 changes");
      await store.set(sampleUri, ORIGINAL);
      await diffs.recompute(sampleUri);
      assert.strictEqual(item.text, "$(diff) 1 file · 1 change");

      await session.start();
      assert.strictEqual(item.text, "$(diff) 0 files · 0 changes");
      store.failCapture = true;
      await assert.rejects(session.start(), /Capture failed/);
      assert.strictEqual(session.getState(), "inactive");
      assert.strictEqual(session.isActive(), false);
      assert.match(item.text, /Not started/);
      assert.deepStrictEqual(states, [
        "inactive", "capturing", "ready",
        "inactive", "capturing", "ready",
        "inactive", "capturing", "inactive",
      ]);
    } finally {
      subscription.dispose();
      statusBar.dispose();
      session.dispose();
    }
  });

  test("canceling bulk rejection preserves files and baselines", async () => {
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    const provider = new BaselineContentProvider(store);
    const commands = new FileCommands(store, diffs, session, provider);
    const originalWarning = vscode.window.showWarningMessage;
    let prompts = 0;
    vscode.window.showWarningMessage = async () => {
      prompts += 1;
      return undefined;
    };
    try {
      await commands.rejectAll();
      assert.strictEqual(prompts, 0);
      await session.start();
      await codexWrite(sampleUri, MODIFIED, session);
      await waitForWatcher();
      await commands.rejectAll();
      assert.strictEqual(prompts, 1);
      assert.strictEqual((await vscode.workspace.openTextDocument(sampleUri)).getText(), MODIFIED);
      assert.strictEqual(await store.get(sampleUri), ORIGINAL);
      assert.strictEqual(diffs.getFileCount(), 1);
      store.clear();
      await commands.rejectAll();
      assert.strictEqual(prompts, 1);
    } finally {
      vscode.window.showWarningMessage = originalWarning;
      provider.dispose();
      session.dispose();
    }
  });

  test("bulk rejection stops when a file or baseline changes during confirmation", async function () {
    this.timeout(10_000);
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    const provider = new BaselineContentProvider(store);
    const commands = new FileCommands(store, diffs, session, provider);
    const originalWarning = vscode.window.showWarningMessage;
    let changedTarget = "document";
    const warnings: string[] = [];
    vscode.window.showWarningMessage = async <T extends string | vscode.MessageItem>(
      message: string,
      _optionsOrItem?: vscode.MessageOptions | T,
      ...items: T[]
    ): Promise<T | undefined> => {
      warnings.push(message);
      if (items.length > 0) {
        if (changedTarget === "document") {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(sampleUri, new vscode.Position(0, 0), "new user edit\n");
          await vscode.workspace.applyEdit(edit);
        } else {
          await store.set(sampleUri, "new baseline\n");
        }
      }
      return items[0];
    };
    try {
      await session.start();
      await codexWrite(sampleUri, MODIFIED, session);
      await waitForWatcher();
      await commands.rejectAll();
      const document = await vscode.workspace.openTextDocument(sampleUri);
      assert.strictEqual(document.getText(), `new user edit\n${MODIFIED}`);
      assert.match(warnings[1], /changed while confirmation was open/);

      await replaceAndSave(sampleUri, ORIGINAL);
      await waitForWatcher();
      await session.start();
      await codexWrite(sampleUri, MODIFIED, session);
      await waitForWatcher();
      changedTarget = "baseline";
      await commands.rejectAll();
      assert.strictEqual(document.getText(), MODIFIED);
      assert.strictEqual(await store.get(sampleUri), "new baseline\n");
      assert.match(warnings[3], /changed while confirmation was open/);
    } finally {
      vscode.window.showWarningMessage = originalWarning;
      provider.dispose();
      session.dispose();
    }
  });

  test("keeps pending hunk counts correct across replacements, removals and reset", async () => {
    const store = new class extends MemoryBaselineStore {
      failReads = false;

      async get(uri: vscode.Uri): Promise<string | undefined> {
        if (this.failReads) {
          throw new Error("Baseline is unreadable");
        }
        return super.get(uri);
      }
    }();
    const diffs = new DiffService(store);
    const countsAtEvents: number[] = [];
    const subscription = diffs.onDidChange(() => {
      countsAtEvents.push(diffs.getHunkCount());
    });

    try {
      await store.capture({ uris: [sampleUri, secondUri] });
      assert.strictEqual(diffs.getHunkCount(), 0);
      assert.strictEqual(diffs.hasAgentChanges(), false);

      await store.set(sampleUri, "ALPHA\nbeta\nGAMMA\n");
      await store.set(secondUri, SECOND_MODIFIED);
      await diffs.recomputeAll();
      assert.strictEqual(diffs.getHunkCount(), 3);
      assert.strictEqual(diffs.hasAgentChanges(), true);

      await diffs.recompute(sampleUri);
      assert.strictEqual(diffs.getHunkCount(), 3);
      await store.set(sampleUri, MODIFIED);
      await diffs.recompute(sampleUri);
      assert.strictEqual(diffs.getHunkCount(), 2);

      await store.set(sampleUri, ORIGINAL);
      await diffs.recompute(sampleUri);
      assert.strictEqual(diffs.getHunkCount(), 1);
      diffs.recordWholeFileChange(secondUri, "deleted");
      diffs.recordWholeFileChange(secondUri, "deleted");
      assert.strictEqual(diffs.getHunkCount(), 0);
      assert.strictEqual(diffs.hasAgentChanges(), true);

      await diffs.recompute(secondUri);
      assert.strictEqual(diffs.getHunkCount(), 1);
      store.failReads = true;
      await diffs.recompute(secondUri);
      assert.strictEqual(diffs.getHunkCount(), 0);
      assert.strictEqual(diffs.hasAgentChanges(), true);
      store.failReads = false;
      await diffs.recompute(secondUri);
      assert.strictEqual(diffs.getHunkCount(), 1);
      diffs.clear();
      assert.strictEqual(diffs.getHunkCount(), 0);
      assert.strictEqual(diffs.hasAgentChanges(), false);
      assert.deepStrictEqual(countsAtEvents.slice(2), [3, 2, 1, 0, 0, 1, 0, 1, 0]);
    } finally {
      subscription.dispose();
      diffs.dispose();
      store.clear();
    }
  });

  test("detects a confirmed Codex patch and exposes review actions", async () => {
    await codexWrite(sampleUri, MODIFIED);
    await waitForWatcher();
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      sampleUri,
    );

    assert.strictEqual(lenses.length, 3);
    assert.deepStrictEqual(
      lenses.map((lens) => lens.command?.command),
      [
        "cursorForgery.openHunkDiff",
        "cursorForgery.acceptHunk",
        "cursorForgery.rejectHunk",
      ],
    );

    const reject = lenses[2].command;
    assert.ok(reject?.arguments);
    await vscode.commands.executeCommand(reject.command, ...reject.arguments);
    assert.strictEqual(document.getText(), ORIGINAL);
  });

  test("reset clears agent changes and captures the current files as a new baseline", async function () {
    this.timeout(5_000);
    await codexWrite(sampleUri, MODIFIED);
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 3);

    await vscode.commands.executeCommand("cursorForgery.resetSession");

    assert.strictEqual(
      (await vscode.workspace.openTextDocument(sampleUri)).getText(),
      MODIFIED,
    );
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);

    await codexWrite(sampleUri, ORIGINAL);
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 3);
  });

  test("restarts review from the checked-out branch without changing files or the real index", async function () {
    this.timeout(15_000);
    const git = (...args: string[]): string => execFileSync("git", [
      "-c", "user.name=AgentTrail Test", "-c", "user.email=review@example.test",
      "-c", "commit.gpgsign=false", ...args,
    ], { cwd: workspaceFolder.uri.fsPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const originalBranch = git("symbolic-ref", "--short", "HEAD");
    const branchAdded = vscode.Uri.joinPath(workspaceFolder.uri, "branch-added.txt");
    const branchDeleted = vscode.Uri.joinPath(workspaceFolder.uri, "branch-deleted.txt");
    const store = new WorkspaceBaselineStore();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    const baselineProvider = new BaselineContentProvider(store);
    const sampleBaseline = baselineProvider.createUri(sampleUri);
    const deletedBaseline = baselineProvider.createUri(branchDeleted);
    const refreshed = new Set<string>();
    const subscription = session.onDidAdvanceBaseline((uri) => baselineProvider.refresh(uri));
    const refreshSubscription = baselineProvider.onDidChange((uri) => refreshed.add(uri.toString()));
    try {
      git("add", "sample.txt", "second.txt");
      git("commit", "--quiet", "-m", "Branch test base");
      git("switch", "--quiet", "-c", "review-base");
      await vscode.workspace.fs.writeFile(branchDeleted, Buffer.from("old branch\n"));
      git("add", "branch-deleted.txt");
      git("commit", "--quiet", "-m", "Old branch file");
      git("switch", "--quiet", "-c", "review-target");
      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
      await vscode.workspace.fs.writeFile(branchAdded, Buffer.from("new branch\n"));
      await vscode.workspace.fs.delete(branchDeleted);
      git("add", "sample.txt", "branch-added.txt", "branch-deleted.txt");
      git("commit", "--quiet", "-m", "Target branch files");
      git("switch", "--quiet", "review-base");
      await waitForWatcher();
      await session.start();
      const request = normalizeHook({
        hook_event_name: "PreToolUse", session_id: "before-branch", tool_use_id: "call",
        cwd: workspaceFolder.uri.fsPath, tool_name: "Bash", tool_input: { command: "npm test" },
      }, workspaceFolder.uri.fsPath);
      assert.ok(request);
      session.codexEvents.accept(request);
      const previousId = session.agentSessions.getCurrentSession()?.id;
      assert.ok(previousId);

      await codexWrite(secondUri, SECOND_MODIFIED, session);
      await codexWrite(createdUri, "carried untracked file\n", session);
      await waitForWatcher();
      assert.ok(diffs.get(secondUri));
      assert.ok(diffs.hasWholeFileChange(createdUri, "added"));
      refreshed.clear();

      git("switch", "--quiet", "review-target");
      const indexAfterCheckout = readFileSync(path.join(workspaceFolder.uri.fsPath, ".git", "index"));
      const deadline = Date.now() + 5_000;
      while (
        (session.getState() !== "ready" || session.agentSessions.getCurrentSession()?.id === previousId) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.strictEqual(session.getState(), "ready");
      assert.notStrictEqual(session.agentSessions.getCurrentSession()?.id, previousId);
      await waitForWatcher();
      assert.strictEqual(session.agentSessions.getSession(previousId)?.status, "ended");
      assert.strictEqual(await store.get(sampleUri), MODIFIED);
      assert.strictEqual(await store.get(secondUri), SECOND_MODIFIED);
      assert.strictEqual(await store.get(createdUri), "carried untracked file\n");
      assert.strictEqual(await store.get(branchAdded), "new branch\n");
      assert.strictEqual(store.has(branchDeleted), false);
      assert.strictEqual(diffs.getFileCount(), 0);
      assert.strictEqual(diffs.hasAgentChanges(), false);
      assert.ok(refreshed.has(sampleBaseline.toString()));
      assert.ok(refreshed.has(deletedBaseline.toString()));
      assert.strictEqual(await baselineProvider.provideTextDocumentContent(sampleBaseline), MODIFIED);
      assert.strictEqual(await baselineProvider.provideTextDocumentContent(deletedBaseline), "");
      assert.deepStrictEqual(
        readFileSync(path.join(workspaceFolder.uri.fsPath, ".git", "index")), indexAfterCheckout,
      );
      assert.strictEqual(readFileSync(sampleUri.fsPath, "utf8"), MODIFIED);
      assert.strictEqual(readFileSync(secondUri.fsPath, "utf8"), SECOND_MODIFIED);

      await codexWrite(sampleUri, "new agent change\n", session);
      await waitForWatcher();
      assert.ok(diffs.get(sampleUri));
      const provider = new BaselineContentProvider(store);
      try {
        await new FileCommands(store, diffs, session, provider).rejectFile(sampleUri);
        assert.strictEqual((await vscode.workspace.openTextDocument(sampleUri)).getText(), MODIFIED);
        assert.strictEqual(diffs.get(sampleUri), undefined);
      } finally {
        provider.dispose();
      }
    } finally {
      subscription.dispose();
      refreshSubscription.dispose();
      baselineProvider.dispose();
      session.dispose();
      await replaceAndSave(sampleUri, MODIFIED);
      await replaceAndSave(secondUri, SECOND_ORIGINAL);
      git("switch", "--quiet", originalBranch);
      await waitForWatcher();
    }
  });

  test("repeats an in-progress capture when the branch changes before it finishes", async function () {
    this.timeout(10_000);
    const git = (...args: string[]): string => execFileSync("git", args, {
      cwd: workspaceFolder.uri.fsPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const originalBranch = git("symbolic-ref", "--short", "HEAD");
    const store = new MemoryBaselineStore();
    const session = new ReviewSession(store, new DiffService(store));
    let releaseCapture: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseCapture = resolve; });
    let captured: (() => void) | undefined;
    const firstCapture = new Promise<void>((resolve) => { captured = resolve; });
    let reset: ReturnType<ReviewSession["start"]> | undefined;
    try {
      await session.start();
      const capture = store.capture.bind(store);
      let captures = 0;
      store.capture = async (options) => {
        await capture(options);
        if (++captures === 1) {
          captured?.();
          await blocked;
        }
      };
      reset = session.start();
      await firstCapture;
      git("switch", "--quiet", "-c", "review-during-capture");
      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
      await waitForWatcher();
      releaseCapture?.();
      await reset;
      assert.strictEqual(captures, 2);
      assert.strictEqual(session.agentSessions.getSessions().length, 0);
      assert.strictEqual(session.getState(), "ready");
      assert.strictEqual(await store.get(sampleUri), MODIFIED);
      assert.strictEqual(session.diffs.hasAgentChanges(), false);
    } finally {
      releaseCapture?.();
      await reset;
      session.dispose();
      await replaceAndSave(sampleUri, ORIGINAL);
      git("switch", "--quiet", originalBranch);
      await waitForWatcher();
    }
  });

  test("does not restore stale diffs when an old baseline read finishes after reset", async () => {
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    try {
      await store.capture({ uris: [sampleUri] });
      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
      await waitForWatcher();
      let finishRead: ((content: string) => void) | undefined;
      store.get = () => new Promise<string>((resolve) => { finishRead = resolve; });
      const pending = diffs.recompute(sampleUri);
      assert.ok(finishRead);
      diffs.clear();
      finishRead(ORIGINAL);
      await pending;
      assert.strictEqual(diffs.getFileCount(), 0);
      assert.strictEqual(diffs.hasAgentChanges(), false);
    } finally {
      diffs.dispose();
      store.clear();
    }
  });

  test("does not let an older verification remove a newer confirmed diff", async () => {
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    try {
      await store.capture({ uris: [sampleUri] });
      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
      await waitForWatcher();
      const get = store.get.bind(store);
      let finishRead: ((content: string) => void) | undefined;
      store.get = () => new Promise<string>((resolve) => { finishRead = resolve; });
      const old = diffs.recompute(sampleUri, ORIGINAL);
      assert.ok(finishRead);
      store.get = get;
      await diffs.recompute(sampleUri, MODIFIED);
      assert.strictEqual(diffs.getFileCount(), 1);
      finishRead(ORIGINAL);
      await old;
      assert.strictEqual(diffs.getFileCount(), 1);
    } finally {
      diffs.dispose();
      store.clear();
    }
  });

  test("separates pending and historical changes and opens their tree rows", async () => {
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const provider = new ChangeTreeProvider(diffs);

    try {
      await store.capture({ uris: [sampleUri, secondUri] });
      assert.deepStrictEqual(provider.getChildren(), []);

      await codexWrite(sampleUri, MODIFIED);
      await codexWrite(secondUri, SECOND_MODIFIED);
      await waitForWatcher();
      await diffs.recomputeAll();

      const roots = provider.getChildren();
      assert.strictEqual(roots.length, 2);
      assert.ok(roots[0] instanceof CurrentTurnItem);
      assert.strictEqual(roots[0].label, "Pending Review");
      assert.strictEqual(
        roots[0].collapsibleState,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      assert.ok(roots[1] instanceof AllAgentChangesItem);
      assert.strictEqual(roots[1].label, "History");
      assert.strictEqual(roots[1].description, "Reference only");
      assert.deepStrictEqual(provider.getChildren().map((item) => item.id), roots.map((item) => item.id));
      assert.strictEqual(
        roots[1].collapsibleState,
        vscode.TreeItemCollapsibleState.Collapsed,
      );

      const files = provider.getChildren(roots[0]);
      assert.strictEqual(files.length, 2);
      const sampleFile = files.find(
        (item) =>
          item instanceof FileChangeItem &&
          item.uri.toString() === sampleUri.toString(),
      );
      const secondFile = files.find(
        (item) =>
          item instanceof FileChangeItem &&
          item.uri.toString() === secondUri.toString(),
      );
      assert.ok(sampleFile instanceof FileChangeItem);
      assert.ok(secondFile instanceof FileChangeItem);
      assert.strictEqual(sampleFile.contextValue, "cursorForgery.file");
      assert.strictEqual(
        provider.getChildren(roots[0]).find((item) => item.resourceUri?.toString() === sampleUri.toString())?.id,
        sampleFile.id,
      );
      assert.strictEqual(
        sampleFile.collapsibleState,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      assert.strictEqual(
        secondFile.collapsibleState,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      assert.strictEqual(sampleFile.command?.command, "cursorForgery.openHunk");

      const sampleHunks = provider.getChildren(sampleFile);
      const secondHunks = provider.getChildren(secondFile);
      assert.strictEqual(sampleHunks.length, 1);
      assert.strictEqual(secondHunks.length, 1);
      assert.ok(sampleHunks[0] instanceof HunkChangeItem);
      assert.strictEqual(sampleHunks[0].contextValue, "cursorForgery.hunk");
      assert.strictEqual(
        sampleHunks[0].command?.command,
        "cursorForgery.openHunk",
      );

      const fileCommand = sampleFile.command;
      assert.ok(fileCommand?.arguments);
      await vscode.commands.executeCommand(
        fileCommand.command,
        ...fileCommand.arguments,
      );
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        sampleUri.toString(),
      );
      assert.strictEqual(
        vscode.window.activeTextEditor?.selection.active.line,
        1,
      );
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputText,
      );

      const editor = vscode.window.activeTextEditor;
      assert.ok(editor);
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      const hunkCommand = sampleHunks[0].command;
      assert.ok(hunkCommand?.arguments);
      await vscode.commands.executeCommand(
        hunkCommand.command,
        ...hunkCommand.arguments,
      );
      assert.strictEqual(
        vscode.window.activeTextEditor?.selection.active.line,
        1,
      );

      const secondHunkCommand = secondHunks[0].command;
      assert.ok(secondHunkCommand?.arguments);
      await vscode.commands.executeCommand(
        "cursorForgery.acceptHunk",
        ...hunkCommand.arguments,
      );
      await vscode.commands.executeCommand(
        "cursorForgery.rejectHunk",
        ...secondHunkCommand.arguments,
      );
      await store.set(sampleUri, MODIFIED);
      await diffs.recomputeAll();

      const reviewedRoots = provider.getChildren();
      assert.strictEqual(reviewedRoots.length, 2);
      assert.deepStrictEqual(provider.getChildren(reviewedRoots[0]), []);
      const historyFiles = provider.getChildren(reviewedRoots[1]);
      assert.strictEqual(historyFiles.length, 2);
      assert.ok(historyFiles.every((item) => item instanceof FileChangeItem));
      assert.ok(
        historyFiles.every(
          (item) => item.contextValue === "cursorForgery.historyFile",
        ),
      );

      const rejectedHistoryFile = historyFiles.find(
        (item) =>
          item instanceof FileChangeItem &&
          item.uri.toString() === secondUri.toString(),
      );
      assert.ok(rejectedHistoryFile instanceof FileChangeItem);
      assert.notStrictEqual(rejectedHistoryFile.id, secondFile.id);
      const rejectedHistoryHunks = provider.getChildren(rejectedHistoryFile);
      assert.strictEqual(rejectedHistoryHunks.length, 1);
      assert.strictEqual(
        rejectedHistoryHunks[0].contextValue,
        "cursorForgery.historyHunk",
      );
      const historyCommand = rejectedHistoryHunks[0].command;
      assert.ok(historyCommand?.arguments);
      assert.strictEqual(historyCommand.arguments[2], true);
      assert.match(String(rejectedHistoryHunks[0].tooltip), /historical line positions may have shifted/);
      const originalInformation = vscode.window.showInformationMessage;
      const historyMessages: string[] = [];
      vscode.window.showInformationMessage = async (message: string) => {
        historyMessages.push(message);
        return undefined;
      };
      try {
        await vscode.commands.executeCommand(
          historyCommand.command,
          ...historyCommand.arguments,
        );
        assert.ok(historyMessages.some((message) => message.includes("recorded line position may have shifted")));
      } finally {
        vscode.window.showInformationMessage = originalInformation;
      }
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        secondUri.toString(),
      );
      assert.strictEqual(
        vscode.window.activeTextEditor?.selection.active.line,
        1,
      );
    } finally {
      provider.dispose();
      diffs.dispose();
      store.clear();
    }
  });

  test("records added and deleted files only in agent change history", async function () {
    this.timeout(5_000);
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    const provider = new ChangeTreeProvider(diffs);

    try {
      await session.start();
      assert.deepStrictEqual(session.agentSessions.getSessions(), []);
      await codexWrite(createdUri, "first\n", session);
      await waitForWatcher();
      await codexWrite(createdUri, "second\n", session);
      await waitForWatcher();

      const rootsAfterCreate = provider.getChildren();
      assert.strictEqual(rootsAfterCreate.length, 2);
      assert.deepStrictEqual(provider.getChildren(rootsAfterCreate[0]), []);
      const addedFiles = provider.getChildren(rootsAfterCreate[1]);
      assert.strictEqual(addedFiles.length, 1);
      const addedFile = addedFiles[0];
      assert.ok(addedFile instanceof FileChangeItem);
      assert.strictEqual(addedFile.kind, "added");
      assert.strictEqual(addedFile.description, "Added");
      assert.strictEqual(addedFile.command, undefined);
      assert.strictEqual(
        addedFile.collapsibleState,
        vscode.TreeItemCollapsibleState.None,
      );

      await codexWrite(createdUri, null, session);
      await waitForWatcher();

      assert.deepStrictEqual(provider.getChildren(rootsAfterCreate[0]), []);
      assert.strictEqual(session.agentSessions.getSessions().length, 1);
      const lifecycleFiles = provider.getChildren(rootsAfterCreate[1]);
      assert.deepStrictEqual(
        lifecycleFiles.map((item) =>
          item instanceof FileChangeItem ? item.kind : undefined,
        ),
        ["added", "deleted"],
      );
      assert.ok(
        lifecycleFiles.every(
          (item) =>
            item instanceof FileChangeItem &&
            item.contextValue === "cursorForgery.historyFile" &&
            item.command === undefined,
        ),
      );
    } finally {
      provider.dispose();
      session.dispose();
    }
  });

  test("removes a deleted existing file from the current turn", async () => {
    await vscode.workspace.fs.writeFile(deletedUri, Buffer.from("before\n"));
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    const provider = new ChangeTreeProvider(diffs);

    try {
      await session.start();
      await codexWrite(deletedUri, "after\n", session);
      await waitForWatcher();

      const rootsAfterModify = provider.getChildren();
      assert.strictEqual(rootsAfterModify.length, 2);
      assert.strictEqual(provider.getChildren(rootsAfterModify[0]).length, 1);

      await codexWrite(deletedUri, null, session);
      await waitForWatcher();

      assert.deepStrictEqual(provider.getChildren(rootsAfterModify[0]), []);
      const deletedHistory = provider
        .getChildren(rootsAfterModify[1])
        .filter(
          (item) =>
            item instanceof FileChangeItem &&
            item.uri.toString() === deletedUri.toString(),
        );
      assert.deepStrictEqual(
        deletedHistory.map((item) =>
          item instanceof FileChangeItem ? item.kind : undefined,
        ),
        ["modified", "deleted"],
      );
      const deletedFile = deletedHistory[1];
      assert.ok(deletedFile instanceof FileChangeItem);
      assert.strictEqual(deletedFile.description, "Deleted");
      assert.strictEqual(deletedFile.command, undefined);
    } finally {
      provider.dispose();
      session.dispose();
    }
  });

  test("keeps Timeline after end and reset while Diff Review remains usable", async function () {
    this.timeout(10_000);
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    const timeline = new SessionTimelineProvider(session.agentSessions);
    const baselineProvider = new BaselineContentProvider(store);
    const commands = new FileCommands(store, diffs, session, baselineProvider);
    let refreshes = 0;
    const subscription = timeline.onDidChangeTreeData(() => refreshes++);
    try {
      await session.start();
      assert.deepStrictEqual(timeline.getChildren(), []);
      await codexWrite(sampleUri, MODIFIED, session);
      await waitForWatcher();
      assert.ok(diffs.get(sampleUri));
      const firstId = session.agentSessions.getCurrentSession()?.id;
      assert.ok(firstId);
      const root = timeline.getChildren()[0];
      assert.ok(root instanceof AgentSessionItem);
      const fileEvents = timeline.getChildren(root).flatMap((item) => timeline.getChildren(item)).filter((item) =>
        item instanceof AgentEventItem && item.event.type === "file-modified" &&
        item.event.payload.uri === sampleUri.toString(),
      );
      assert.ok(fileEvents.length > 0);
      const item = fileEvents[0];
      assert.ok(item instanceof AgentEventItem);
      assert.strictEqual(item.event.source, "codex-hook");
      assert.strictEqual(item.event.confidence, "reported");
      assert.match(String(item.tooltip), /Codex hook/);
      await session.endAgentSession();
      assert.strictEqual(session.isActive(), true);
      assert.strictEqual(session.getState(), "ready");
      assert.strictEqual(session.agentSessions.getCurrentSession(), undefined);
      const ended = session.agentSessions.getSession(firstId);
      assert.ok(ended);
      assert.strictEqual(ended.events[ended.events.length - 1].type, "session-end");
      await commands.acceptFile(sampleUri);
      assert.strictEqual(await store.get(sampleUri), MODIFIED);
      assert.strictEqual(diffs.get(sampleUri), undefined);
      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(ORIGINAL));
      await waitForWatcher();
      assert.strictEqual(diffs.get(sampleUri), undefined);
      await commands.rejectFile(sampleUri);
      assert.strictEqual((await vscode.workspace.openTextDocument(sampleUri)).getText(), ORIGINAL);
      assert.strictEqual(diffs.get(sampleUri), undefined);
      assert.ok(diffs.hasAgentChanges());
      assert.deepStrictEqual(session.agentSessions.getSession(firstId), ended);
      await session.start();
      assert.strictEqual(session.agentSessions.getCurrentSession(), undefined);
      assert.strictEqual(timeline.getChildren().length, 1);
      assert.deepStrictEqual(session.agentSessions.getSession(firstId), ended);
      assert.strictEqual(diffs.hasAgentChanges(), false);
      assert.ok(refreshes >= 4);
      await session.start();
      assert.strictEqual(timeline.getChildren().length, 1);
    } finally {
      subscription.dispose();
      timeline.dispose();
      baselineProvider.dispose();
      session.dispose();
    }
  });

  test("does not attribute user saves to Codex", async () => {
    const store = new MemoryBaselineStore();
    const session = new ReviewSession(store, new DiffService(store));
    try {
      await session.start();
      await replaceAndSave(sampleUri, MODIFIED);
      await waitForWatcher();
      assert.deepStrictEqual(session.agentSessions.getSessions(), []);
      assert.strictEqual(session.diffs.hasAgentChanges(), false);
      assert.strictEqual(session.diffs.getFileCount(), 0);
    } finally {
      session.dispose();
    }
  });

  test("ignores unreported filesystem modifications, additions and deletions", async () => {
    const store = new MemoryBaselineStore();
    const session = new ReviewSession(store, new DiffService(store));
    try {
      await session.start();
      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
      await vscode.workspace.fs.writeFile(createdUri, Buffer.from("ordinary file\n"));
      await waitForWatcher();
      await vscode.workspace.fs.delete(createdUri);
      await waitForWatcher();
      assert.strictEqual(session.diffs.getFileCount(), 0);
      assert.strictEqual(session.diffs.hasAgentChanges(), false);
      assert.deepStrictEqual(session.agentSessions.getSessions(), []);
      assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
    } finally {
      session.dispose();
    }
  });

  test("excludes unrelated changes before a patch and invalidates review after another writer", async function () {
    this.timeout(10_000);
    const store = new MemoryBaselineStore();
    const session = new ReviewSession(store, new DiffService(store));
    const provider = new BaselineContentProvider(store);
    const commands = new FileCommands(store, session.diffs, session, provider);
    try {
      await session.start();
      const before = "user alpha\nbeta\ngamma\n";
      const after = "user alpha\nBETA\ngamma\n";
      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(before));
      await waitForWatcher();
      await codexWrite(sampleUri, after, session);
      await waitForWatcher();
      assert.strictEqual(await store.get(sampleUri), before);
      assert.strictEqual(session.diffs.get(sampleUri)?.hunks.length, 1);
      assert.strictEqual(session.diffs.get(sampleUri)?.hunks[0].baselineText, "beta\n");
      const later = `${after}another writer\n`;
      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(later));
      await waitForWatcher();
      assert.strictEqual(session.diffs.get(sampleUri), undefined);
      await commands.rejectFile(sampleUri);
      assert.strictEqual((await vscode.workspace.openTextDocument(sampleUri)).getText(), later);
      const history = session.diffs.getAllAgentChanges();
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].hunks[0].currentText, "BETA\n");
    } finally {
      provider.dispose();
      session.dispose();
    }
  });

  test("accumulates sequential confirmed patches and safely rejects only one hunk", async function () {
    this.timeout(10_000);
    await codexWrite(sampleUri, "ALPHA\nbeta\ngamma\n");
    await waitForWatcher();
    await codexWrite(sampleUri, "ALPHA\nbeta\nGAMMA\n");
    await waitForWatcher();
    const lenses = await getCodeLenses(sampleUri);
    assert.strictEqual(lenses.length, 6);
    const reject = lenses[2].command;
    assert.ok(reject?.arguments);
    await vscode.commands.executeCommand(reject.command, ...reject.arguments);
    assert.strictEqual((await vscode.workspace.openTextDocument(sampleUri)).getText(), "alpha\nbeta\nGAMMA\n");
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 3);
  });

  test("keeps binary, non-UTF-8 and directory changes out of Timeline", async function () {
    this.timeout(5_000);
    const binaryUri = vscode.Uri.joinPath(workspaceFolder.uri, "lens-binary.dat");
    const invalidUri = vscode.Uri.joinPath(workspaceFolder.uri, "lens-invalid.dat");
    const directoryUri = vscode.Uri.joinPath(workspaceFolder.uri, "lens-empty-directory");
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    try {
      await session.start();
      await vscode.workspace.fs.writeFile(binaryUri, Uint8Array.from([0, 1, 2]));
      await vscode.workspace.fs.writeFile(invalidUri, Uint8Array.from([255, 254]));
      await vscode.workspace.fs.createDirectory(directoryUri);
      await waitForWatcher();
      await vscode.workspace.fs.delete(binaryUri);
      await vscode.workspace.fs.delete(invalidUri);
      await vscode.workspace.fs.delete(directoryUri);
      await waitForWatcher();
      await session.endAgentSession();
      const excludedUris = new Set(
        [binaryUri, invalidUri, directoryUri].map((uri) => uri.toString()),
      );
      assert.deepStrictEqual(session.agentSessions.getSessions(), []);
      assert.deepStrictEqual(diffs.getAllAgentChanges().filter((change) =>
        excludedUris.has(change.uri),
      ), []);
    } finally {
      session.dispose();
      await deleteIfExists(binaryUri);
      await deleteIfExists(invalidUri);
      await deleteIfExists(directoryUri);
    }
  });

  test("accept updates the baseline without changing the current file", async () => {
    await codexWrite(sampleUri, MODIFIED);
    await waitForWatcher();
    const before = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      sampleUri,
    );
    const accept = before[1].command;
    assert.ok(accept?.arguments);

    await vscode.commands.executeCommand(accept.command, ...accept.arguments);

    const document = await vscode.workspace.openTextDocument(sampleUri);
    assert.strictEqual(document.getText(), MODIFIED);
    const after = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      sampleUri,
    );
    assert.strictEqual(after.length, 0);
  });

  test("Request Change still selects the hunk for the Codex integration", async () => {
    await codexWrite(sampleUri, MODIFIED);
    await waitForWatcher();
    const lens = (await getCodeLenses(sampleUri))[1];
    assert.ok(lens.command?.arguments);
    let selectedText: string | undefined;
    const command = vscode.commands.registerCommand("chatgpt.addToThread", () => {
      const editor = vscode.window.activeTextEditor;
      selectedText = editor?.document.getText(editor.selection);
    });
    const originalGetExtension = vscode.extensions.getExtension;
    try {
      vscode.extensions.getExtension = <T>(id: string) => originalGetExtension<T>(
        id === "openai.chatgpt" ? "local.agent-trail" : id,
      );
      await vscode.commands.executeCommand(
        "cursorForgery.requestHunkChange", ...lens.command.arguments,
      );
      assert.strictEqual(selectedText, "BETA\n");
    } finally {
      vscode.extensions.getExtension = originalGetExtension;
      command.dispose();
    }
  });

  test("distinguishes unsaved user edits from observed filesystem saves", async function () {
    this.timeout(5_000);
    await waitForWatcher();
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const session = new ReviewSession(store, diffs);
    try {
      await session.start();
      const document = await vscode.workspace.openTextDocument(sampleUri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(sampleUri, document.lineAt(1).range, "USER BETA");
      await vscode.workspace.applyEdit(edit);
      await waitForUserBaseline();
      assert.deepStrictEqual(session.agentSessions.getSessions(), []);
      assert.strictEqual(diffs.get(sampleUri), undefined);
      await document.save();
      await waitForWatcher();
      assert.strictEqual(diffs.get(sampleUri), undefined);
      assert.deepStrictEqual(session.agentSessions.getSessions(), []);
    } finally {
      session.dispose();
    }
  });

  test("does not review edits typed by the user", async () => {
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(sampleUri, document.lineAt(1).range, "USER BETA");

    await vscode.workspace.applyEdit(edit);
    await waitForUserBaseline();
    await document.save();
    await waitForWatcher();

    assert.strictEqual(document.getText(), "alpha\nUSER BETA\ngamma\n");
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
  });

  test("user editing a pending file takes ownership of its current state", async () => {
    await codexWrite(sampleUri, MODIFIED);
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 3);
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(sampleUri, document.positionAt(document.getText().length), "user line\n");

    await vscode.workspace.applyEdit(edit);
    await waitForNoCodeLenses(sampleUri);

    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
  });

  test("opens a native diff with baseline and current documents", async () => {
    await codexWrite(sampleUri, MODIFIED);
    await waitForWatcher();
    const lens = (await getCodeLenses(sampleUri))[0];
    assert.ok(lens.command?.arguments);

    await vscode.commands.executeCommand(
      "cursorForgery.openHunkDiff",
      ...lens.command.arguments,
    );

    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff);
    assert.strictEqual(input.original.scheme, "agent-review-baseline");
    assert.strictEqual(input.modified.toString(), sampleUri.toString());
  });

  test("reject file restores every hunk through a workspace edit", async () => {
    const twoHunks = "ALPHA\nbeta\nGAMMA\n";
    await codexWrite(sampleUri, twoHunks);
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 6);

    await vscode.commands.executeCommand("cursorForgery.rejectFile", sampleUri);

    const document = await vscode.workspace.openTextDocument(sampleUri);
    assert.strictEqual(document.getText(), ORIGINAL);
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
  });

  test("accept all advances baselines for multiple files", async () => {
    await codexWrite(sampleUri, MODIFIED);
    await codexWrite(secondUri, SECOND_MODIFIED);
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 3);
    assert.strictEqual((await getCodeLenses(secondUri)).length, 3);

    await vscode.commands.executeCommand("cursorForgery.acceptAll");

    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
    assert.strictEqual((await getCodeLenses(secondUri)).length, 0);
    assert.strictEqual((await vscode.workspace.openTextDocument(sampleUri)).getText(), MODIFIED);
    assert.strictEqual(
      (await vscode.workspace.openTextDocument(secondUri)).getText(),
      SECOND_MODIFIED,
    );
  });

  test("reject all restores multiple files", async () => {
    await codexWrite(sampleUri, MODIFIED);
    await codexWrite(secondUri, SECOND_MODIFIED);
    await waitForWatcher();

    const originalWarning = vscode.window.showWarningMessage;
    let confirmationMessage = "";
    vscode.window.showWarningMessage = async <T extends string | vscode.MessageItem>(
      message: string,
      optionsOrItem?: vscode.MessageOptions | T,
      ...items: T[]
    ): Promise<T | undefined> => {
      confirmationMessage = message;
      assert.ok(optionsOrItem && typeof optionsOrItem === "object" && "modal" in optionsOrItem);
      assert.strictEqual(optionsOrItem.modal, true);
      return items[0];
    };
    try {
      await vscode.commands.executeCommand("cursorForgery.rejectAll");
      assert.strictEqual(confirmationMessage, "Reject all pending changes in 2 files?");
    } finally {
      vscode.window.showWarningMessage = originalWarning;
    }

    assert.strictEqual(
      (await vscode.workspace.openTextDocument(sampleUri)).getText(),
      ORIGINAL,
    );
    assert.strictEqual(
      (await vscode.workspace.openTextDocument(secondUri)).getText(),
      SECOND_ORIGINAL,
    );
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
    assert.strictEqual((await getCodeLenses(secondUri)).length, 0);
  });
});

async function waitForWatcher(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function waitForUserBaseline(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function waitForNoCodeLenses(uri: vscode.Uri): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await getCodeLenses(uri)).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function getCodeLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  return vscode.commands.executeCommand<vscode.CodeLens[]>(
    "vscode.executeCodeLensProvider",
    uri,
  );
}

async function replaceAndSave(uri: vscode.Uri, content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    ),
    content,
  );
  await vscode.workspace.applyEdit(edit);
  await document.save();
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch (error) {
    if (
      !(error instanceof vscode.FileSystemError) ||
      error.code !== "FileNotFound"
    ) {
      throw error;
    }
  }
}
