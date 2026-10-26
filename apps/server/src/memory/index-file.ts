/**
 * `MEMORY.md` reading (read-only).
 *
 * Ported from `kuitos/opencode-claude-memory` (`src/store/indexFile.ts`).
 * `MEMORY.md` is shared with Claude Code and may be hand-organised (headings,
 * blank-line groups, comments); OpenWork's native port only reads it, so the
 * line-level upsert/remove helpers are intentionally not ported.
 */

import { readFile } from "node:fs/promises";
import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from "./paths.js";

/**
 * Only markdown list items of the form `- [Title](file.md) ...` count as index
 * pointers. The label is matched lazily so titles containing brackets
 * (`[Use [Bun]](x.md)`) resolve to the first `](target)` that looks like a file
 * reference; the target may not contain whitespace or parens.
 */
export const POINTER_RE = /^\s*[-*]\s+\[(.*?)\]\(([^()\s]+)\)/;

export async function readIndexFile(entrypoint: string): Promise<string> {
  try {
    return await readFile(entrypoint, "utf-8");
  } catch {
    return "";
  }
}

export function pointerTarget(line: string): string | undefined {
  const match = POINTER_RE.exec(line);
  return match?.[2];
}

/** The first pointer line for `fileName` without its indentation and trailing whitespace, or undefined. */
export function findIndexPointerLine(raw: string, fileName: string): string | undefined {
  return raw
    .split(/\r?\n/)
    .find((line) => pointerTarget(line) === fileName)
    ?.trim();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export type EntrypointTruncation = {
  content: string;
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
};

/**
 * Port of Claude Code's `truncateEntrypointContent()` from `memdir.ts`. Uses
 * `.length` (char count, same as Claude Code) for byte measurement.
 */
export function truncateEntrypoint(raw: string): EntrypointTruncation {
  const trimmed = raw.trim();
  if (!trimmed) return { content: "", lineCount: 0, byteCount: 0, wasLineTruncated: false, wasByteTruncated: false };

  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`;

  return {
    content: `${truncated}\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}
