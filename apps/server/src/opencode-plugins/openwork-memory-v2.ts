/**
 * OpenWork Memory Plugin (OpenCode v2)
 *
 * V2 sibling of `openwork-memory.ts`: same read-only, Claude Code compatible
 * memory, wired to the V2 plugin API instead of v1's hooks object.
 *
 * - `session.hook("context")` pushes the memory segment onto `event.system`, the
 *   V2 equivalent of v1's `experimental.chat.system.transform`.
 * - `tool.transform` adds `memory_list` / `memory_read` / `memory_search` with
 *   `options: { codemode: false }`; without that V2 hides them behind the Code
 *   Mode `execute` tool.
 *
 * The engine's location directory is the opened workspace, the same path the
 * server resolves for `GET /workspace/:id/memory`, so both sides agree on the
 * folder. See `openwork-memory.ts` for the shared behaviour.
 */

import { MEMORY_SECTION_ID, MemoryStore, buildMemoryInstructions, hasMemoryContent, loadMemoryOverview } from "../memory/index.js";

type SystemPart = { type: "text"; text: string };
type ContextEvent = { readonly sessionID: string; system: SystemPart[] };
type Registration = { readonly dispose: () => Promise<void> };
type TextResult = { content: { type: "text"; text: string }[] };

type Tool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute(input: unknown, call: { sessionID: string; signal: AbortSignal }): Promise<TextResult>;
};

type MemoryV2Context = {
  readonly location: { readonly directory: string };
  readonly session: {
    readonly hook: {
      (name: "context", callback: (event: ContextEvent) => Promise<void> | void): Promise<Registration>;
    };
  };
  readonly tool: {
    readonly transform: (callback: (editor: { add(tool: Tool): void }) => void) => Promise<Registration>;
  };
};

function text(value: unknown): TextResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
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

const TOOLS: { name: string; description: string; input: Record<string, unknown> }[] = [
  {
    name: "memory_list",
    description:
      "List the memory files saved for this workspace (the Claude Code compatible memory directory), newest first. Reading one of these files needs memory_read.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_read",
    description:
      "Read one memory file by the name memory_list returned. Reading a memory is not proof it is still true: verify anything it claims about the current code or state.",
    input: {
      type: "object",
      properties: { file: { type: "string", description: "Memory file name, e.g. `user_role` or `team/conventions`. `.md` is optional." } },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description:
      "Search the workspace's memory files for a term (case-insensitive). Use narrow terms such as error messages, file paths or function names.",
    input: {
      type: "object",
      properties: { query: { type: "string", description: "Case-insensitive text to find in memory names, descriptions and bodies." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export async function registerMemory(context: MemoryV2Context): Promise<() => Promise<void>> {
  const directory = context.location.directory;
  const registrations: Registration[] = [];

  registrations.push(
    await context.session.hook("context", async (event) => {
      try {
        const store = new MemoryStore(directory);
        const [files, indexRaw] = await Promise.all([store.scan(), store.readIndex()]);
        // Nothing to read means nothing to teach; a workspace that never used
        // memory costs no tokens.
        if (!hasMemoryContent({ fileCount: files.length, indexRaw })) return;
        const memory = buildMemoryInstructions({ memoryDir: store.memoryDir, indexRaw });
        event.system.push({ type: "text", text: memory.text });
      } catch {
        // Memory must never fail a turn.
      }
    }),
  );

  registrations.push(
    await context.tool.transform((editor) => {
      for (const tool of TOOLS) {
        editor.add({
          ...tool,
          options: { codemode: false },
          async execute(input) {
            const args = input && typeof input === "object" ? input : {};
            const store = new MemoryStore(directory);
            if (tool.name === "memory_list") {
              const overview = await loadMemoryOverview(store);
              return text({
                ok: true,
                memoryDir: overview.memoryDir,
                indexLoaded: overview.entrypoint.loaded,
                files: overview.files.map(describeFile),
              });
            }
            if (tool.name === "memory_read") {
              const file = "file" in args && typeof args.file === "string" ? args.file : "";
              if (!file) return text({ ok: false, error: "memory_read needs a `file`." });
              const entry = await store.read(file);
              if (!entry) return text({ ok: false, error: `Memory file not found: ${file}` });
              return text({ ok: true, ...describeFile(entry), content: entry.body });
            }
            const query = "query" in args && typeof args.query === "string" ? args.query : "";
            if (!query) return text({ ok: false, error: "memory_search needs a `query`." });
            const matches = await store.search(query);
            return text({ ok: true, matches: matches.map(describeFile) });
          },
        });
      }
    }),
  );

  return async () => {
    for (const registration of registrations) {
      try {
        await registration.dispose();
      } catch {
        // The host tears the plugin scope down anyway.
      }
    }
  };
}

export { MEMORY_SECTION_ID };

export default {
  id: "openwork.memory",
  setup: (context: MemoryV2Context) => registerMemory(context),
};
