/**
 * The read-only memory system prompt, ported from
 * `kuitos/opencode-claude-memory` (`src/prompt/systemPrompt.ts` +
 * `src/prompt/sections.ts`).
 *
 * OpenWork's native port injects a read-only variant: it teaches the model when
 * and how to *read* the Claude Code compatible memory directory, never how to
 * write to it. Both the engine plugin (which injects the text) and the server
 * route (which reports how many tokens it costs) build it through
 * `buildMemoryInstructions`, so the two can never disagree.
 */

import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES } from "./paths.js";
import { type EntrypointTruncation, truncateEntrypoint } from "./index-file.js";

/**
 * First line of the system-prompt segment this plugin injects. The engine's
 * messages transform uses it to find (and, on ignore-memory turns, strip) the
 * plugin's own segment without guessing from headings.
 */
export const AUTO_MEMORY_MARKER = "<!-- openwork-claude-memory -->";

/** Instruction-section id, so a later transform can replace this section rather than stack a second copy. */
export const MEMORY_SECTION_ID = "memory";

// The two halves of the prompt are split so the constant text can be reused by
// tests that assert the marker survives rotation/compaction.
const WHEN_TO_ACCESS_READ_ONLY = [
  "## When to access memories",
  "- When memories seem relevant, or the user references prior-conversation work.",
  "- You MUST access memory when the user explicitly asks you to check or recall something.",
  "- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.",
  "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now and answer from that, not from the memory.",
].join("\n");

const TRUSTING_RECALL = [
  "## Before recommending from memory",
  "",
  "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
  "",
  "- If the memory names a file path: check the file exists.",
  "- If the memory names a function or flag: grep for it.",
  "- If the user is about to act on your recommendation (not just asking about history), verify first.",
  "",
  '"The memory says X exists" is not the same as "X exists now."',
  "",
  "A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.",
].join("\n");

function buildSearchingPastContextSection(memoryDir: string): string[] {
  const memSearch = `grep -rn "<search term>" ${memoryDir} --include="*.md"`;
  return [
    "## Searching past context",
    "",
    "When looking for past context:",
    "1. Search topic files in your memory directory, or use the `memory_search` tool:",
    "```",
    memSearch,
    "```",
    "Use narrow search terms (error messages, file paths, function names) rather than broad keywords.",
    "",
  ];
}

export type MemoryEntrypointStatus = {
  name: string;
  /** The memory directory's `MEMORY.md` exists and has content. */
  present: boolean;
  /** True when the index made it into the injected text. */
  loaded: boolean;
  lineCount: number;
  byteCount: number;
  truncated: boolean;
};

export type MemoryInstructions = {
  /** The exact text the engine receives, marker line included. */
  text: string;
  /** Token estimate of `text`, characters / 4 (the composer breakdown's own convention). */
  tokens: number;
  entrypoint: MemoryEntrypointStatus;
};

/** Characters / 4, matching the composer context breakdown's estimate. */
export function estimateCharTokens(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

/**
 * Whether the engine injects the memory segment at all. Empty memory costs
 * nothing: a workspace that never used memory gets no segment and no tokens.
 * The plugins and the reporting route both ask this, so the injected text and
 * the reported token count cannot disagree.
 */
export function hasMemoryContent(input: { fileCount: number; indexRaw: string }): boolean {
  return input.fileCount > 0 || input.indexRaw.trim().length > 0;
}

/** Token estimate of a block of text. */
export function estimateMemoryTokens(text: string): number {
  return estimateCharTokens(text.trim().length);
}

export type BuildMemoryInstructionsInput = {
  memoryDir: string;
  indexRaw: string;
};

/**
 * The read-only memory system prompt, with the truncated `MEMORY.md` index
 * appended. Pure: the caller reads the index and decides whether to inject.
 */
export function buildMemoryInstructions(input: BuildMemoryInstructionsInput): MemoryInstructions {
  const { memoryDir, indexRaw } = input;
  const truncation: EntrypointTruncation = truncateEntrypoint(indexRaw);
  const hasIndex = truncation.content.length > 0;

  const lines: string[] = [
    AUTO_MEMORY_MARKER,
    "# Auto Memory",
    "",
    `You have a persistent, file-based memory system at \`${memoryDir}\`, shared with Claude Code. In this session it is read-only: never create, edit or delete anything in that directory, even when the user asks you to remember or forget something — tell them memory is read-only here instead.`,
    "",
    WHEN_TO_ACCESS_READ_ONLY,
    "",
    TRUSTING_RECALL,
    "",
    ...buildSearchingPastContextSection(memoryDir),
  ];

  if (hasIndex) {
    lines.push(`## ${ENTRYPOINT_NAME}`, "", truncation.content);
  } else {
    lines.push(`## ${ENTRYPOINT_NAME}`, "", `${ENTRYPOINT_NAME} is currently empty.`);
  }

  const text = lines.join("\n");
  return {
    text,
    tokens: estimateMemoryTokens(text),
    entrypoint: {
      name: ENTRYPOINT_NAME,
      present: hasIndex,
      loaded: hasIndex,
      lineCount: truncation.lineCount,
      byteCount: truncation.byteCount,
      truncated: truncation.wasLineTruncated || truncation.wasByteTruncated,
    },
  };
}

export { MAX_ENTRYPOINT_LINES };
