/**
 * Native OpenWork port of `kuitos/opencode-claude-memory`, read-only.
 *
 * A workspace's Claude Code compatible memory directory, the system-prompt
 * segment the engine injects for it, and the summary the composer popup shows.
 * One module owns all three so the injected text and the reported token count
 * can never drift apart.
 *
 * Not ported (needs child sessions / a model): recall and extraction. The
 * native port never writes memory files.
 */

import type { MemoryType } from "./frontmatter.js";
import {
  buildMemoryInstructions,
  estimateCharTokens,
  hasMemoryContent,
  type MemoryEntrypointStatus,
} from "./instructions.js";
import { MemoryStore } from "./store.js";

export { MemoryStore, defaultClaudeConfigDir, memoryProjectKey } from "./store.js";
export { memoryProjectRoot } from "./paths.js";
export {
  AUTO_MEMORY_MARKER,
  MEMORY_SECTION_ID,
  buildMemoryInstructions,
  estimateMemoryTokens,
  hasMemoryContent,
  type MemoryInstructions,
  type MemoryEntrypointStatus,
} from "./instructions.js";
export type { MemoryEntry, MemoryHeader, MemoryFileStat } from "./scan.js";
export type { MemoryType } from "./frontmatter.js";

/** One memory file as the composer popup shows it. */
export type MemoryFileSummary = {
  /** Relative to the memory directory, `/`-separated, `.md` included. */
  filename: string;
  name: string;
  description: string;
  type: MemoryType;
  mtimeMs: number;
  byteSize: number;
  /** Token estimate for the whole file, characters / 4. */
  tokens: number;
};

export type MemoryOverview = {
  /** Absolute path of the memory directory the workspace maps to. */
  memoryDir: string;
  /** Absolute path of the Claude Code project folder holding it. */
  projectDir: string;
  /** The `MEMORY.md` index; its text is the only memory content in context. */
  entrypoint: MemoryEntrypointStatus;
  /** Topic files. Listed by the index; read on demand, so not in context. */
  files: MemoryFileSummary[];
  /** Tokens the injected memory segment costs; the composer's "Memory" row. */
  instructionsTokens: number;
  /** Token estimate of the `MEMORY.md` text inside `instructionsTokens`. */
  entrypointTokens: number;
};

/**
 * Reads everything the popup and the context breakdown need. Cheap: one
 * directory walk plus one index read. Bodies are never kept.
 */
export async function loadMemoryOverview(store: MemoryStore): Promise<MemoryOverview> {
  const [headers, indexRaw] = await Promise.all([store.scan(), store.readIndex()]);
  const instructions = buildMemoryInstructions({ memoryDir: store.memoryDir, indexRaw });
  // Empty memory is not injected, so it costs nothing and the composer row stays
  // hidden; reporting the static prompt here would claim context that is not sent.
  const injected = hasMemoryContent({ fileCount: headers.length, indexRaw });

  const files: MemoryFileSummary[] = headers.map((header) => ({
    filename: header.filename,
    name: header.name,
    description: header.description,
    type: header.type,
    mtimeMs: header.mtimeMs,
    byteSize: header.byteSize,
    tokens: estimateCharTokens(header.byteSize),
  }));

  return {
    memoryDir: store.memoryDir,
    projectDir: store.projectDir,
    entrypoint: { ...instructions.entrypoint, loaded: injected && instructions.entrypoint.present },
    files,
    instructionsTokens: injected ? instructions.tokens : 0,
    entrypointTokens: injected ? estimateCharTokens(instructions.entrypoint.byteCount) : 0,
  };
}
