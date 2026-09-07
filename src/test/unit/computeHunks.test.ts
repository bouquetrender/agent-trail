import * as assert from "assert";
import { computeHunks, mergeAcceptedHunk } from "../../diff/computeHunks";

suite("computeHunks", () => {
  test("returns no hunks for identical text including empty and mixed line endings", () => {
    for (const text of ["", "one", "one\n", "one\r\ntwo\n", "文字\n".repeat(10000)]) {
      assert.deepStrictEqual(computeHunks("file:///sample.txt", text, text), []);
    }
  });

  test("creates independent hunks for separated line changes", () => {
    const baseline = "one\ntwo\nthree\nfour\n";
    const current = "ONE\ntwo\nthree\nFOUR\n";

    const hunks = computeHunks("file:///sample.txt", baseline, current);

    assert.strictEqual(hunks.length, 2);
    assert.deepStrictEqual(
      hunks.map((hunk) => ({
        oldStartLine: hunk.oldStartLine,
        newStartLine: hunk.newStartLine,
        baselineText: hunk.baselineText,
        currentText: hunk.currentText,
      })),
      [
        {
          oldStartLine: 0,
          newStartLine: 0,
          baselineText: "one\n",
          currentText: "ONE\n",
        },
        {
          oldStartLine: 3,
          newStartLine: 3,
          baselineText: "four\n",
          currentText: "FOUR\n",
        },
      ],
    );
  });

  test("tracks insertion and deletion offsets", () => {
    const insertion = computeHunks("file:///sample.txt", "a\nc\n", "a\nb\nc\n")[0];
    assert.strictEqual(insertion.baselineStartOffset, 2);
    assert.strictEqual(insertion.baselineEndOffset, 2);
    assert.strictEqual(insertion.currentStartOffset, 2);
    assert.strictEqual(insertion.currentEndOffset, 4);

    const deletion = computeHunks("file:///sample.txt", "a\nb\nc\n", "a\nc\n")[0];
    assert.strictEqual(deletion.baselineStartOffset, 2);
    assert.strictEqual(deletion.baselineEndOffset, 4);
    assert.strictEqual(deletion.currentStartOffset, 2);
    assert.strictEqual(deletion.currentEndOffset, 2);
  });

  test("accept merges only the selected hunk into baseline", () => {
    const baseline = "one\ntwo\nthree\nfour\n";
    const current = "ONE\ntwo\nthree\nFOUR\n";
    const [first] = computeHunks("file:///sample.txt", baseline, current);

    const acceptedBaseline = mergeAcceptedHunk(baseline, first);
    const remaining = computeHunks(
      "file:///sample.txt",
      acceptedBaseline,
      current,
    );

    assert.strictEqual(acceptedBaseline, "ONE\ntwo\nthree\nfour\n");
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].currentText, "FOUR\n");
  });

  test("hunk ids are stable content hashes rather than indexes", () => {
    const first = computeHunks("file:///sample.txt", "a\nb\n", "A\nb\n")[0];
    const second = computeHunks("file:///sample.txt", "a\nb\n", "A\nb\n")[0];

    assert.match(first.id, /^[a-f0-9]{20}$/);
    assert.strictEqual(first.id, second.id);
  });
});
