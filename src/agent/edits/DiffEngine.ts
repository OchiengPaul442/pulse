/**
 * Lightweight line-level diff engine.
 *
 * Produces unified-diff-style hunks from two strings.
 * Uses an LCS (longest common subsequence) approach with
 * common-prefix / common-suffix trimming for performance.
 */

/* ── Public types ──────────────────────────────────────── */

export interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiffResult {
  fileName: string;
  filePath: string;
  isNew: boolean;
  isDelete: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/* ── Constants ─────────────────────────────────────────── */

/** Files above this line count get a summary-only hunk. */
const MAX_DIFF_LINES = 1500;

/* ── Entry points ──────────────────────────────────────── */

/**
 * Build a full {@link FileDiffResult} for a single file change.
 *
 * Pass `null` for `oldContent` when the file is new and `null`
 * for `newContent` when the file is being deleted.
 */
export function computeFileDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
): FileDiffResult {
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const isNew = oldContent === null || oldContent === undefined;
  const isDelete = newContent === null || newContent === undefined;

  const hunks = computeLineDiff(oldContent ?? "", newContent ?? "");

  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === "add") additions++;
      if (l.type === "remove") deletions++;
    }
  }

  return { fileName, filePath, isNew, isDelete, hunks, additions, deletions };
}

/**
 * Compute line-level diff hunks between two strings.
 *
 * @param contextLines - Number of unchanged lines to include around
 *   each change for context (default 3).
 */
export function computeLineDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
): DiffHunk[] {
  if (oldText === newText) return [];

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return [summaryHunk(oldLines, newLines)];
  }

  const ops = diffOps(oldLines, newLines);
  return buildHunks(ops, contextLines);
}

/* ── Diff-op types (internal) ──────────────────────────── */

interface DiffOp {
  type: "equal" | "insert" | "delete";
  oldIdx?: number;
  newIdx?: number;
  value: string;
}

/* ── Core LCS algorithm ────────────────────────────────── */

function diffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const m = oldLines.length;
  const n = newLines.length;

  // ── Fast path: trim common prefix / suffix ──
  let prefixLen = 0;
  while (
    prefixLen < m &&
    prefixLen < n &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < m - prefixLen &&
    suffixLen < n - prefixLen &&
    oldLines[m - 1 - suffixLen] === newLines[n - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const ops: DiffOp[] = [];

  // Prefix – equal
  for (let i = 0; i < prefixLen; i++) {
    ops.push({ type: "equal", oldIdx: i, newIdx: i, value: oldLines[i] });
  }

  // Middle (the part that actually changed)
  const oldMid = oldLines.slice(prefixLen, m - suffixLen);
  const newMid = newLines.slice(prefixLen, n - suffixLen);

  if (oldMid.length > 0 || newMid.length > 0) {
    ops.push(...lcsDiff(oldMid, newMid, prefixLen, prefixLen));
  }

  // Suffix – equal
  for (let i = 0; i < suffixLen; i++) {
    const oi = m - suffixLen + i;
    const ni = n - suffixLen + i;
    ops.push({ type: "equal", oldIdx: oi, newIdx: ni, value: oldLines[oi] });
  }

  return ops;
}

/** Standard O(NM) LCS on the trimmed middle portion. */
function lcsDiff(
  a: string[],
  b: string[],
  oldOff: number,
  newOff: number,
): DiffOp[] {
  const m = a.length;
  const n = b.length;

  // Build LCS length table
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Uint32Array(n + 1);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Back-trace
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({
        type: "equal",
        oldIdx: oldOff + i - 1,
        newIdx: newOff + j - 1,
        value: a[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({
        type: "insert",
        newIdx: newOff + j - 1,
        value: b[j - 1],
      });
      j--;
    } else {
      ops.push({
        type: "delete",
        oldIdx: oldOff + i - 1,
        value: a[i - 1],
      });
      i--;
    }
  }

  return ops.reverse();
}

/* ── Hunk builder ──────────────────────────────────────── */

function buildHunks(ops: DiffOp[], ctx: number): DiffHunk[] {
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "equal") changeIdx.push(i);
  }
  if (changeIdx.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let start = 0;

  while (start < changeIdx.length) {
    // Merge adjacent changes that share context
    let end = start;
    while (end + 1 < changeIdx.length) {
      if (changeIdx[end + 1] - changeIdx[end] - 1 <= ctx * 2) {
        end++;
      } else {
        break;
      }
    }

    const lo = Math.max(0, changeIdx[start] - ctx);
    const hi = Math.min(ops.length - 1, changeIdx[end] + ctx);

    const lines: DiffLine[] = [];
    let oldStart = Infinity;
    let newStart = Infinity;
    let oldCount = 0;
    let newCount = 0;

    for (let k = lo; k <= hi; k++) {
      const op = ops[k];
      if (op.type === "equal") {
        const ol = op.oldIdx != null ? op.oldIdx + 1 : undefined;
        const nl = op.newIdx != null ? op.newIdx + 1 : undefined;
        lines.push({
          type: "context",
          content: op.value,
          oldLine: ol,
          newLine: nl,
        });
        if (ol != null) {
          oldStart = Math.min(oldStart, ol);
          oldCount++;
        }
        if (nl != null) {
          newStart = Math.min(newStart, nl);
          newCount++;
        }
      } else if (op.type === "delete") {
        const ol = op.oldIdx != null ? op.oldIdx + 1 : undefined;
        lines.push({ type: "remove", content: op.value, oldLine: ol });
        if (ol != null) {
          oldStart = Math.min(oldStart, ol);
          oldCount++;
        }
      } else {
        const nl = op.newIdx != null ? op.newIdx + 1 : undefined;
        lines.push({ type: "add", content: op.value, newLine: nl });
        if (nl != null) {
          newStart = Math.min(newStart, nl);
          newCount++;
        }
      }
    }

    if (oldStart === Infinity) oldStart = 1;
    if (newStart === Infinity) newStart = 1;

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
    start = end + 1;
  }

  return hunks;
}

/* ── Fallback for oversized files ──────────────────────── */

function summaryHunk(oldLines: string[], newLines: string[]): DiffHunk {
  return {
    oldStart: 1,
    oldCount: oldLines.length,
    newStart: 1,
    newCount: newLines.length,
    lines: [
      { type: "remove", content: `(${oldLines.length} lines)`, oldLine: 1 },
      { type: "add", content: `(${newLines.length} lines)`, newLine: 1 },
    ],
  };
}
