/**
 * The one data model for a memory file (read-only).
 *
 * Ported from `kuitos/opencode-claude-memory` (`src/store/scan.ts`). Defaults
 * (name from the file name, type "user") are decided here and nowhere else, so
 * every consumer — the injected instructions, the read tools, and the composer
 * popup — sees the same values.
 */

import { type Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { type MemoryType, parseFrontmatter, parseFrontmatterHeader, parseMemoryType } from "./frontmatter.js";
import { ENTRYPOINT_NAME, MAX_MEMORY_FILES } from "./paths.js";

/** Absolute path and byte size of one memory file, as resolved on disk. */
export type MemoryFileStat = {
  /** Relative to the memory directory, always `/`-separated, e.g. "user_role.md" or "team/conventions.md". */
  filename: string;
  /** Absolute path on disk. */
  filePath: string;
  mtimeMs: number;
  byteSize: number;
};

export type MemoryHeader = MemoryFileStat & {
  name: string;
  description: string;
  type: MemoryType;
  hasFrontmatter: boolean;
};

export type MemoryEntry = MemoryHeader & {
  /** Content without frontmatter. */
  body: string;
  /** The whole file, frontmatter included. */
  raw: string;
};

export function toPosixRelative(relativePath: string): string {
  return sep === "/" ? relativePath : relativePath.split(sep).join("/");
}

export function nameFromFilename(filename: string): string {
  return basename(filename).replace(/\.md$/, "");
}

/** Identity used to avoid surfacing the same memory twice in one conversation. */
export function surfaceKey(header: Pick<MemoryHeader, "name" | "type">): string {
  return `${header.name}|${header.type}`;
}

function headerFrom(
  file: MemoryFileStat,
  parsed: { frontmatter: { name?: string; description?: string; type?: string }; hasFrontmatter: boolean },
): MemoryHeader {
  return {
    ...file,
    name: parsed.frontmatter.name ?? nameFromFilename(file.filename),
    description: parsed.frontmatter.description ?? "",
    type: parseMemoryType(parsed.frontmatter.type) ?? "user",
    hasFrontmatter: parsed.hasFrontmatter,
  };
}

export async function readMemoryHeader(memoryDir: string, filename: string): Promise<MemoryHeader | null> {
  const filePath = join(memoryDir, ...filename.split("/"));
  try {
    const [raw, stats] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    const file: MemoryFileStat = { filename, filePath, mtimeMs: stats.mtimeMs, byteSize: stats.size };
    return headerFrom(file, parseFrontmatterHeader(raw));
  } catch {
    return null;
  }
}

export async function readMemoryEntry(memoryDir: string, filename: string): Promise<MemoryEntry | null> {
  const filePath = join(memoryDir, ...filename.split("/"));
  try {
    const [raw, stats] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    const file: MemoryFileStat = { filename, filePath, mtimeMs: stats.mtimeMs, byteSize: stats.size };
    const parsed = parseFrontmatter(raw);
    return { ...headerFrom(file, parsed), body: parsed.body, raw };
  } catch {
    return null;
  }
}

/** Reads a memory body through the same parser the scanner uses. */
export async function readMemoryBody(filePath: string): Promise<string> {
  try {
    return parseFrontmatter(await readFile(filePath, "utf-8")).body;
  } catch {
    return "";
  }
}

export type ScanOptions = {
  recursive?: boolean;
};

/**
 * Own directory walk instead of a recursive readdir: symbolic links (files or
 * directories) are never followed, so a link planted in the memory directory
 * cannot pull outside files into the manifest.
 */
async function listMarkdownFiles(memoryDir: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (recursive) await walk(join(dir, name), relative);
      } else if (entry.isFile() && name.endsWith(".md") && name !== ENTRYPOINT_NAME) {
        out.push(relative);
      }
    }
  };
  await walk(memoryDir, "");
  return out;
}

/**
 * Port of Claude Code's `scanMemoryFiles()`: recursive scan of the memory
 * directory, header-only parsing, sorted by mtime desc and capped at
 * MAX_MEMORY_FILES.
 */
export async function scanMemoryFiles(memoryDir: string, options: ScanOptions = {}): Promise<MemoryHeader[]> {
  const headers: MemoryHeader[] = [];
  for (const entry of await listMarkdownFiles(memoryDir, options.recursive ?? true)) {
    const header = await readMemoryHeader(memoryDir, entry);
    if (header) headers.push(header);
  }
  return headers.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_MEMORY_FILES);
}

/**
 * Port of Claude Code's `formatMemoryManifest()`:
 * `- [type] filename (ISO timestamp): description` per line.
 */
export function formatMemoryManifest(memories: readonly MemoryHeader[]): string {
  return memories
    .map((memory) => {
      const ts = new Date(memory.mtimeMs).toISOString();
      return memory.description
        ? `- [${memory.type}] ${memory.filename} (${ts}): ${memory.description}`
        : `- [${memory.type}] ${memory.filename} (${ts})`;
    })
    .join("\n");
}
