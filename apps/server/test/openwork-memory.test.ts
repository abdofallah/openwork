import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTO_MEMORY_MARKER,
  MemoryStore,
  buildMemoryInstructions,
  hasMemoryContent,
  loadMemoryOverview,
  memoryProjectKey,
} from "../src/memory/index.js";

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test.after(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A workspace inside a git repository, plus the memory folder it maps to. */
async function workspace(configDir: string): Promise<{ workspacePath: string; memoryDir: string }> {
  const workspacePath = await tempDir("ow-memory-ws-");
  await mkdir(join(workspacePath, ".git"), { recursive: true });
  return {
    workspacePath,
    memoryDir: join(configDir, "projects", memoryProjectKey(workspacePath), "memory"),
  };
}

async function writeMemory(memoryDir: string, files: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(files)) {
    const target = join(memoryDir, ...name.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, body, "utf-8");
  }
}

test("a workspace with no memory is not injected and costs nothing", async () => {
  const configDir = await tempDir("ow-memory-config-");
  const { workspacePath } = await workspace(configDir);
  const store = new MemoryStore(workspacePath, configDir);

  const overview = await loadMemoryOverview(store);
  assert.deepEqual(overview.files, []);
  assert.equal(overview.entrypoint.present, false);
  assert.equal(overview.entrypoint.loaded, false);
  assert.equal(overview.instructionsTokens, 0);
  assert.equal(overview.entrypointTokens, 0);
  assert.equal(hasMemoryContent({ fileCount: 0, indexRaw: "" }), false);
});

test("the index is injected while the topic files are only listed", async () => {
  const configDir = await tempDir("ow-memory-config-");
  const { workspacePath, memoryDir } = await workspace(configDir);
  const role = "---\nname: role\ndescription: Who I am\ntype: user\n---\nI am a developer.\n";
  await writeMemory(memoryDir, {
    "MEMORY.md": "# Memory\n\nSee user_role.md.\n",
    "user_role.md": role,
    "team/conventions.md": "Use tabs.\n",
  });

  const overview = await loadMemoryOverview(new MemoryStore(workspacePath, configDir));
  assert.equal(overview.entrypoint.name, "MEMORY.md");
  assert.equal(overview.entrypoint.present, true);
  assert.equal(overview.entrypoint.loaded, true);
  assert.ok(overview.instructionsTokens > 0);
  assert.ok(overview.entrypointTokens > 0);
  // The index never appears among the topic files.
  assert.deepEqual(overview.files.map((file) => file.filename).sort(), ["team/conventions.md", "user_role.md"]);

  const roleFile = overview.files.find((file) => file.filename === "user_role.md");
  assert.ok(roleFile);
  assert.equal(roleFile.name, "role");
  assert.equal(roleFile.description, "Who I am");
  assert.equal(roleFile.type, "user");
  assert.equal(roleFile.tokens, Math.ceil(Buffer.byteLength(role, "utf-8") / 4));
});

test("topic files alone are enough to inject the segment", async () => {
  const configDir = await tempDir("ow-memory-config-");
  const { workspacePath, memoryDir } = await workspace(configDir);
  await writeMemory(memoryDir, { "notes.md": "Remember this.\n" });

  const overview = await loadMemoryOverview(new MemoryStore(workspacePath, configDir));
  assert.equal(overview.entrypoint.present, false);
  assert.equal(overview.entrypoint.loaded, false);
  assert.equal(overview.files.length, 1);
  assert.ok(overview.instructionsTokens > 0);
});

test("an empty index with no topic files costs nothing", async () => {
  const configDir = await tempDir("ow-memory-config-");
  const { workspacePath, memoryDir } = await workspace(configDir);
  await writeMemory(memoryDir, { "MEMORY.md": "\n   \n" });

  const overview = await loadMemoryOverview(new MemoryStore(workspacePath, configDir));
  assert.equal(overview.instructionsTokens, 0);
  assert.equal(overview.entrypoint.present, false);
});

test("the injected text carries the marker and says memory is read-only", async () => {
  const instructions = buildMemoryInstructions({ memoryDir: "/tmp/memory", indexRaw: "# Memory\n" });
  assert.ok(instructions.text.startsWith(AUTO_MEMORY_MARKER));
  assert.match(instructions.text, /read-only/);
  assert.match(instructions.text, /# Memory/);
  assert.equal(instructions.tokens, Math.ceil(instructions.text.trim().length / 4));
});

test("reading a file cannot escape the memory directory", async () => {
  const configDir = await tempDir("ow-memory-config-");
  const { workspacePath } = await workspace(configDir);
  const store = new MemoryStore(workspacePath, configDir);
  await assert.rejects(() => store.read("../outside"));
  await assert.rejects(() => store.read("MEMORY"));
  await assert.rejects(() => store.read("/etc/passwd"));
});
