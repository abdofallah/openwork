/**
 * Read-only view of a workspace's Claude Code compatible memory directory.
 *
 * Ported from `kuitos/opencode-claude-memory` (`src/store/MemoryStore.ts`),
 * trimmed to the read surface: `list` / `read` / `search` / `readIndex`. The
 * native OpenWork port never creates, edits or deletes memory files.
 *
 * Directory: `<CLAUDE_CONFIG_DIR>/projects/<sanitizePath(canonicalGitRoot)>/memory/`.
 * `CLAUDE_CONFIG_DIR` defaults to `~/.claude`, the same default the OpenCode
 * engine uses, so both sides agree on which folder is "the" memory folder.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readIndexFile } from "./index-file.js";
import {
  ENTRYPOINT_NAME,
  MEMORY_DIR_NAME,
  MAX_MEMORY_FILE_BYTES,
  PROJECTS_DIR_NAME,
  memoryProjectRoot,
  resolveMemoryFilePath,
  sanitizePath,
} from "./paths.js";
import { type MemoryEntry, type MemoryHeader, readMemoryEntry, scanMemoryFiles } from "./scan.js";

export { ENTRYPOINT_NAME, MAX_MEMORY_FILE_BYTES };

/** `CLAUDE_CONFIG_DIR` or `~/.claude`, matching the OpenCode engine's default. */
export function defaultClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".claude");
}

/** The `projects/<key>` folder name a workspace maps to (Claude Code's own scheme). */
export function memoryProjectKey(workspacePath: string): string {
  return sanitizePath(memoryProjectRoot(workspacePath));
}

export class MemoryStore {
  readonly workspacePath: string;
  readonly claudeConfigDir: string;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly memoryDir: string;
  readonly entrypoint: string;

  constructor(workspacePath: string, claudeConfigDir: string = defaultClaudeConfigDir()) {
    this.workspacePath = resolve(workspacePath);
    this.claudeConfigDir = claudeConfigDir;
    this.projectRoot = memoryProjectRoot(this.workspacePath);
    this.projectDir = join(claudeConfigDir, PROJECTS_DIR_NAME, sanitizePath(this.projectRoot));
    this.memoryDir = join(this.projectDir, MEMORY_DIR_NAME);
    this.entrypoint = join(this.memoryDir, ENTRYPOINT_NAME);
  }

  /** Every memory file header (never the `MEMORY.md` index), newest first. */
  async scan(): Promise<MemoryHeader[]> {
    return scanMemoryFiles(this.memoryDir);
  }

  /** Every memory file with its body, newest first. */
  async list(): Promise<MemoryEntry[]> {
    const headers = await this.scan();
    const entries = await Promise.all(headers.map((header) => readMemoryEntry(this.memoryDir, header.filename)));
    return entries.filter((entry): entry is MemoryEntry => entry !== null);
  }

  /**
   * One memory file by its relative name (`user_role`, `team/conventions`,
   * `.md` optional). Path traversal, absolute paths, dotfiles and the reserved
   * `MEMORY` name are rejected.
   */
  async read(fileName: string): Promise<MemoryEntry | null> {
    const { relativePath } = resolveMemoryFilePath(this.memoryDir, fileName);
    return readMemoryEntry(this.memoryDir, relativePath);
  }

  /** Case-insensitive search over memory names, descriptions and bodies. */
  async search(query: string): Promise<MemoryEntry[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const entries = await this.list();
    return entries.filter((entry) =>
      entry.name.toLowerCase().includes(needle)
      || entry.description.toLowerCase().includes(needle)
      || entry.body.toLowerCase().includes(needle));
  }

  /** The raw `MEMORY.md` index, or "" when there is none. */
  async readIndex(): Promise<string> {
    return readIndexFile(this.entrypoint);
  }
}
