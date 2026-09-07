import * as assert from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DiffService } from "../../diff/DiffService";
import { MemoryBaselineStore } from "../../session/MemoryBaselineStore";
import { ReviewSession } from "../../session/ReviewSession";
import { WorkspaceBaselineStore } from "../../session/WorkspaceBaselineStore";
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

suite("Agent Diff Review extension", () => {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder);
  const sampleUri = vscode.Uri.joinPath(workspaceFolder.uri, "sample.txt");
  const secondUri = vscode.Uri.joinPath(workspaceFolder.uri, "second.txt");
  const createdUri = vscode.Uri.joinPath(workspaceFolder.uri, "created.txt");
  const deletedUri = vscode.Uri.joinPath(workspaceFolder.uri, "deleted.txt");

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

  test("detects a saved change and exposes review actions", async () => {
    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
    await waitForWatcher();
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      sampleUri,
    );

    assert.strictEqual(lenses.length, 4);
    assert.deepStrictEqual(
      lenses.map((lens) => lens.command?.command),
      [
        "cursorForgery.openHunkDiff",
        "cursorForgery.acceptHunk",
        "cursorForgery.rejectHunk",
        "cursorForgery.requestHunkChange",
      ],
    );

    const reject = lenses[2].command;
    assert.ok(reject?.arguments);
    await vscode.commands.executeCommand(reject.command, ...reject.arguments);
    assert.strictEqual(document.getText(), ORIGINAL);
  });

  test("reset clears agent changes and captures the current files as a new baseline", async () => {
    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 4);

    await vscode.commands.executeCommand("cursorForgery.resetSession");

    assert.strictEqual(
      (await vscode.workspace.openTextDocument(sampleUri)).getText(),
      MODIFIED,
    );
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);

    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(ORIGINAL));
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 4);
  });

  test("separates pending and historical changes and opens their tree rows", async () => {
    const store = new MemoryBaselineStore();
    const diffs = new DiffService(store);
    const provider = new ChangeTreeProvider(diffs);

    try {
      await store.capture({ uris: [sampleUri, secondUri] });
      assert.deepStrictEqual(provider.getChildren(), []);

      await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
      await vscode.workspace.fs.writeFile(
        secondUri,
        Buffer.from(SECOND_MODIFIED),
      );
      await waitForWatcher();
      await diffs.recomputeAll();

      const roots = provider.getChildren();
      assert.strictEqual(roots.length, 2);
      assert.ok(roots[0] instanceof CurrentTurnItem);
      assert.strictEqual(roots[0].label, "Current Turn");
      assert.strictEqual(
        roots[0].collapsibleState,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      assert.ok(roots[1] instanceof AllAgentChangesItem);
      assert.strictEqual(roots[1].label, "All Agent Changes");
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
      const rejectedHistoryHunks = provider.getChildren(rejectedHistoryFile);
      assert.strictEqual(rejectedHistoryHunks.length, 1);
      assert.strictEqual(
        rejectedHistoryHunks[0].contextValue,
        "cursorForgery.historyHunk",
      );
      const historyCommand = rejectedHistoryHunks[0].command;
      assert.ok(historyCommand?.arguments);
      await vscode.commands.executeCommand(
        historyCommand.command,
        ...historyCommand.arguments,
      );
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
      await vscode.workspace.fs.writeFile(createdUri, Buffer.from("first\n"));
      await waitForWatcher();
      await vscode.workspace.fs.writeFile(createdUri, Buffer.from("second\n"));
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

      await vscode.workspace.fs.delete(createdUri);
      await waitForWatcher();

      assert.deepStrictEqual(provider.getChildren(rootsAfterCreate[0]), []);
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
      await vscode.workspace.fs.writeFile(deletedUri, Buffer.from("after\n"));
      await waitForWatcher();

      const rootsAfterModify = provider.getChildren();
      assert.strictEqual(rootsAfterModify.length, 2);
      assert.strictEqual(provider.getChildren(rootsAfterModify[0]).length, 1);

      await vscode.workspace.fs.delete(deletedUri);
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

  test("accept updates the baseline without changing the current file", async () => {
    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
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
    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 4);
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(sampleUri, document.positionAt(document.getText().length), "user line\n");

    await vscode.workspace.applyEdit(edit);
    await waitForNoCodeLenses(sampleUri);

    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
  });

  test("opens a native diff with baseline and current documents", async () => {
    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
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
    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(twoHunks));
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 8);

    await vscode.commands.executeCommand("cursorForgery.rejectFile", sampleUri);

    const document = await vscode.workspace.openTextDocument(sampleUri);
    assert.strictEqual(document.getText(), ORIGINAL);
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 0);
  });

  test("accept all advances baselines for multiple files", async () => {
    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
    await vscode.workspace.fs.writeFile(secondUri, Buffer.from(SECOND_MODIFIED));
    await waitForWatcher();
    assert.strictEqual((await getCodeLenses(sampleUri)).length, 4);
    assert.strictEqual((await getCodeLenses(secondUri)).length, 4);

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
    await vscode.workspace.fs.writeFile(sampleUri, Buffer.from(MODIFIED));
    await vscode.workspace.fs.writeFile(secondUri, Buffer.from(SECOND_MODIFIED));
    await waitForWatcher();

    await vscode.commands.executeCommand("cursorForgery.rejectAll");

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
