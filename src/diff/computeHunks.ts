import { createHash } from "crypto";
import { diffLines } from "diff";
import type { DiffHunk } from "../model";

interface MutableHunk {
  oldStartLine: number;
  newStartLine: number;
  baselineStartOffset: number;
  currentStartOffset: number;
  baselineText: string;
  currentText: string;
}

export function computeHunks(
  uri: string,
  baseline: string,
  current: string,
): DiffHunk[] {
  if (baseline === current) {
    return [];
  }

  const hunks: DiffHunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldOffset = 0;
  let newOffset = 0;
  let pending: MutableHunk | undefined;

  const finishPending = (): void => {
    if (!pending) {
      return;
    }

    const identity = [
      uri,
      pending.oldStartLine,
      pending.newStartLine,
      pending.baselineText,
      pending.currentText,
    ].join("\u0000");

    hunks.push({
      id: createHash("sha256").update(identity).digest("hex").slice(0, 20),
      uri,
      oldStartLine: pending.oldStartLine,
      oldLineCount: countLines(pending.baselineText),
      newStartLine: pending.newStartLine,
      newLineCount: countLines(pending.currentText),
      baselineStartOffset: pending.baselineStartOffset,
      baselineEndOffset:
        pending.baselineStartOffset + pending.baselineText.length,
      currentStartOffset: pending.currentStartOffset,
      currentEndOffset: pending.currentStartOffset + pending.currentText.length,
      baselineText: pending.baselineText,
      currentText: pending.currentText,
    });
    pending = undefined;
  };

  for (const change of diffLines(baseline, current)) {
    if (!change.added && !change.removed) {
      finishPending();
      oldLine += change.count ?? countLines(change.value);
      newLine += change.count ?? countLines(change.value);
      oldOffset += change.value.length;
      newOffset += change.value.length;
      continue;
    }

    pending ??= {
      oldStartLine: oldLine,
      newStartLine: newLine,
      baselineStartOffset: oldOffset,
      currentStartOffset: newOffset,
      baselineText: "",
      currentText: "",
    };

    if (change.removed) {
      pending.baselineText += change.value;
      oldLine += change.count ?? countLines(change.value);
      oldOffset += change.value.length;
    } else {
      pending.currentText += change.value;
      newLine += change.count ?? countLines(change.value);
      newOffset += change.value.length;
    }
  }

  finishPending();
  return hunks;
}

export function mergeAcceptedHunk(baseline: string, hunk: DiffHunk): string {
  return (
    baseline.slice(0, hunk.baselineStartOffset) +
    hunk.currentText +
    baseline.slice(hunk.baselineEndOffset)
  );
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const newlineCount = value.match(/\n/g)?.length ?? 0;
  return value.endsWith("\n") ? newlineCount : newlineCount + 1;
}
