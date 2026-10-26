import { z } from "zod";
import { appendAgentInstructions, createInstructionSection } from "./agent-instruction-compose.js";
import {
  MEMORY_SECTION_ID,
  MemoryStore,
  buildMemoryInstructions,
  hasMemoryContent,
  loadMemoryOverview,
} from "../memory/index.js";

/**
 * OpenWork Memory Plugin (OpenCode v1)
 *
 * Native port of `kuitos/opencode-claude-memory`: it teaches the model about the
 * workspace's Claude Code compatible memory directory
 * (`<CLAUDE_CONFIG_DIR>/projects/<key>/memory/`) and gives it read tools for the
 * topic files. The `MEMORY.md` index is injected into the system prompt, so the
 * composer's context breakdown can attribute its tokens to memory instead of
 * folding them into "system and other".
 *
 * Read-only: recall and extraction need child sessions and a model, so they are
 * not part of the native port. Nothing here writes memory files; the prompt says
 * so, which keeps the model from promising to remember something.
 *
 * The engine's `directory` is the opened workspace, the same path the server
 * resolves for `GET /workspace/:id/memory`, so both sides agree on the folder.
 */

type MemoryContext = {
  directory?: string;
};

const listArgs = z.object({});

const readArgs = z.object({
  file: z.string().min(1).describe("Memory file name, e.g. `user_role` or `team/conventions`. `.md` is optional."),
});

const searchArgs = z.object({
  query: z.string().min(1).describe("Case-insensitive text to find in memory names, descriptions and bodies."),
});

function storeFor(directory: string): MemoryStore {
  return new MemoryStore(directory);
}

function describeFile(file: {
  filename: string;
  name: string;
  type: string;
  description: string;
  mtimeMs: number;
}): Record<string, unknown> {
  return {
    file: file.filename,
    name: file.name,
    type: file.type,
    description: file.description,
    updatedAt: new Date(file.mtimeMs).toISOString(),
  };
}

export const OpenWorkMemory = async (context?: MemoryContext) => {
  const directory = context?.directory ?? process.cwd();

  return {
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      const store = storeFor(directory);
      const [files, indexRaw] = await Promise.all([store.scan(), store.readIndex()]);
      // Nothing to read means nothing to teach: leave the prompt untouched so a
      // workspace that never used memory costs nothing.
      if (!hasMemoryContent({ fileCount: files.length, indexRaw })) return;
      const memory = buildMemoryInstructions({ memoryDir: store.memoryDir, indexRaw });
      appendAgentInstructions(output.system, createInstructionSection(MEMORY_SECTION_ID, memory.text));
    },
    tool: {
      memory_list: {
        description:
          "List the memory files saved for this workspace (the Claude Code compatible memory directory), newest first. Reading one of these files needs memory_read.",
        args: listArgs.shape,
        async execute() {
          const overview = await loadMemoryOverview(storeFor(directory));
          return JSON.stringify(
            {
              ok: true,
              memoryDir: overview.memoryDir,
              indexLoaded: overview.entrypoint.loaded,
              files: overview.files.map(describeFile),
            },
            null,
            2,
          );
        },
      },
      memory_read: {
        description:
          "Read one memory file by the name memory_list returned. Reading a memory is not proof it is still true: verify anything it claims about the current code or state.",
        args: readArgs.shape,
        async execute(rawArgs: unknown) {
          const args = readArgs.parse(rawArgs);
          const entry = await storeFor(directory).read(args.file);
          if (!entry) return JSON.stringify({ ok: false, error: `Memory file not found: ${args.file}` }, null, 2);
          return JSON.stringify({ ok: true, ...describeFile(entry), content: entry.body }, null, 2);
        },
      },
      memory_search: {
        description:
          "Search the workspace's memory files for a term (case-insensitive). Use narrow terms such as error messages, file paths or function names.",
        args: searchArgs.shape,
        async execute(rawArgs: unknown) {
          const args = searchArgs.parse(rawArgs);
          const matches = await storeFor(directory).search(args.query);
          return JSON.stringify({ ok: true, matches: matches.map(describeFile) }, null, 2);
        },
      },
    },
  };
};
