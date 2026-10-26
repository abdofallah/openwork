import type { OpenworkWorkspaceMemory, OpenworkWorkspaceMemoryFile } from "@/app/lib/openwork-server";

/**
 * The workspace's Claude Code compatible memory, as the OpenWork server reports
 * it for `GET /workspace/:id/memory`.
 *
 * One distinction drives both the popup and the context breakdown: the
 * `MEMORY.md` index is injected into the prompt (it is in context), while the
 * topic files are only listed and read on demand (they are not). So the memory
 * row counts `instructionsTokens` — the segment that already contains the
 * index — and never the topic files.
 */

export type ComposerMemoryOverview = OpenworkWorkspaceMemory;

/** One topic file of the workspace's memory, as the popup lists it. */
export type ComposerMemoryFile = OpenworkWorkspaceMemoryFile;

/** Something to inspect: the index or at least one topic file. */
export function hasComposerMemory(overview: ComposerMemoryOverview): boolean {
  return overview.entrypoint.present || overview.files.length > 0;
}

/** Tokens memory costs the context window: the injected segment, index included. */
export function memoryContextTokens(overview: ComposerMemoryOverview): number {
  return Math.max(0, overview.instructionsTokens);
}
