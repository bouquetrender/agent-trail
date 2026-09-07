import * as assert from "assert";
import { AgentChangeHistory } from "../../diff/AgentChangeHistory";
import { computeHunks } from "../../diff/computeHunks";

suite("AgentChangeHistory", () => {
  test("refreshes sorted snapshots after writes without changing earlier snapshots", () => {
    const history = new AgentChangeHistory();
    const uri = "file:///sample.txt";
    assert.strictEqual(history.hasChanges(), false);
    assert.deepStrictEqual(history.getAll(), []);

    history.record({ uri, hunks: computeHunks(uri, "before\n", "after\n") });
    const first = history.getAll();
    assert.strictEqual(history.hasChanges(), true);
    assert.strictEqual(history.getAll(), first);

    history.record({ uri, hunks: computeHunks(uri, "before\n", "latest\n") });
    assert.strictEqual(history.getAll()[0].hunks[0].currentText, "latest\n");
    assert.strictEqual(first[0].hunks[0].currentText, "after\n");

    history.recordWholeFile(uri, "deleted");
    history.recordWholeFile(uri, "added");
    history.recordWholeFile("file:///a.txt", "added");
    assert.deepStrictEqual(
      history.getAll().map((change) => [change.uri, change.kind]),
      [
        ["file:///a.txt", "added"],
        [uri, "modified"],
        [uri, "added"],
        [uri, "deleted"],
      ],
    );

    history.clear();
    assert.strictEqual(history.hasChanges(), false);
    assert.deepStrictEqual(history.getAll(), []);
    history.recordWholeFile(uri, "added");
    assert.strictEqual(history.hasChanges(), true);
    assert.strictEqual(history.getAll().length, 1);
  });

  test("replaces the hunk at the same line and retains other locations", () => {
    const uri = "file:///sample.txt";
    const baseline = "one\ntwo\nthree\nfour\n";
    const firstSnapshot = {
      uri,
      hunks: computeHunks(uri, baseline, "ONE\ntwo\nthree\nfour\n"),
    };
    const secondSnapshot = {
      uri,
      hunks: computeHunks(uri, baseline, "LATEST\ntwo\nthree\nFOUR\n"),
    };
    const history = new AgentChangeHistory();

    history.record(firstSnapshot);
    history.record(secondSnapshot);

    const [fileDiff] = history.getAll();
    assert.strictEqual(fileDiff.hunks.length, 2);
    assert.deepStrictEqual(
      fileDiff.hunks.map((hunk) => hunk.currentText),
      ["LATEST\n", "FOUR\n"],
    );
    assert.strictEqual(
      history.getHunk(uri, firstSnapshot.hunks[0].id),
      undefined,
    );
    assert.strictEqual(
      history.getHunk(uri, secondSnapshot.hunks[0].id)?.currentText,
      "LATEST\n",
    );
  });

  test("retains recorded changes until the session is cleared", () => {
    const uri = "file:///sample.txt";
    const history = new AgentChangeHistory();
    history.record({
      uri,
      hunks: computeHunks(uri, "before\n", "after\n"),
    });

    assert.strictEqual(history.getAll().length, 1);
    history.clear();
    assert.deepStrictEqual(history.getAll(), []);
  });

  test("records added and deleted files as whole-file history", () => {
    const uri = "file:///created.txt";
    const history = new AgentChangeHistory();

    history.recordWholeFile(uri, "added");
    history.recordWholeFile(uri, "deleted");

    assert.deepStrictEqual(
      history.getAll().map((change) => ({
        uri: change.uri,
        kind: change.kind,
        hunkCount: change.hunks.length,
      })),
      [
        { uri, kind: "added", hunkCount: 0 },
        { uri, kind: "deleted", hunkCount: 0 },
      ],
    );
  });
});
