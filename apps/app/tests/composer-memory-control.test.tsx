import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ComposerMemoryControl } = await import("../src/react-app/domains/session/surface/composer/composer-memory-control");
type Overview = import("../src/app/lib/openwork-server").OpenworkWorkspaceMemory;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const overview = (extra: Partial<Overview> = {}): Overview => ({
  memoryDir: "/home/me/.claude/projects/-work-demo/memory",
  projectDir: "/work/demo",
  entrypoint: { name: "MEMORY.md", present: true, loaded: true, lineCount: 3, byteCount: 400, truncated: false },
  files: [],
  instructionsTokens: 100,
  entrypointTokens: 100,
  ...extra,
});

async function render(memory: Overview) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(ComposerMemoryControl, {
      source: { queryKey: ["workspace-memory", "ws_1"], load: async () => memory },
    })));
  });
  // Let the query settle before the assertions read the trigger.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("shows nothing when the workspace has no memory", async () => {
  const view = await render(overview({
    entrypoint: { name: "MEMORY.md", present: false, loaded: false, lineCount: 0, byteCount: 0, truncated: false },
    files: [],
    instructionsTokens: 0,
    entrypointTokens: 0,
  }));
  expect(view.host.querySelector("[data-testid=composer-memory-trigger]")).toBeNull();
  await view.unmount();
});

test("lists the index as in the prompt and the topic files as on demand", async () => {
  const view = await render(overview({
    instructionsTokens: 400,
    entrypointTokens: 100,
    files: [
      { filename: "user_role.md", name: "role", description: "Who I am", type: "user", mtimeMs: 1, byteSize: 340, tokens: 85 },
      { filename: "team/conventions.md", name: "conventions", description: "", type: "project", mtimeMs: 2, byteSize: 120, tokens: 30 },
    ],
  }));
  const trigger = view.host.querySelector("[data-testid=composer-memory-trigger]");
  expect(trigger?.getAttribute("aria-label")).toBe("Memory: 2 memory files");
  await act(async () => { (trigger as HTMLElement | undefined)?.click(); });
  const list = document.querySelector("[data-testid=composer-memory-list]");
  expect(list).not.toBeNull();
  const rows = [...(list?.querySelectorAll("li") ?? [])];
  expect(rows.map((row) => row.querySelector(".truncate")?.textContent)).toEqual([
    "Memory guidance", "MEMORY.md", "user_role.md", "team/conventions.md",
  ]);
  expect(rows.map((row) => row.textContent)).toEqual([
    "Memory guidancein the prompt≈300",
    "MEMORY.mdin the prompt≈100",
    "user_role.mdon demand≈85",
    "team/conventions.mdon demand≈30",
  ]);
  // The "in the prompt" rows add up to the tokens the tooltip's Memory row counts.
  const inPrompt = rows
    .filter((row) => row.textContent?.includes("in the prompt"))
    .reduce((sum, row) => sum + Number(row.textContent?.split("≈")[1] ?? 0), 0);
  expect(inPrompt).toBe(400);
  await view.unmount();
});

test("with no index, the guidance row carries the whole injected segment", async () => {
  const view = await render(overview({
    entrypoint: { name: "MEMORY.md", present: false, loaded: false, lineCount: 0, byteCount: 0, truncated: false },
    entrypointTokens: 0,
    instructionsTokens: 250,
    files: [{ filename: "notes.md", name: "notes", description: "", type: "project", mtimeMs: 1, byteSize: 40, tokens: 10 }],
  }));
  const trigger = view.host.querySelector("[data-testid=composer-memory-trigger]");
  await act(async () => { (trigger as HTMLElement | undefined)?.click(); });
  const rows = [...(document.querySelector("[data-testid=composer-memory-list]")?.querySelectorAll("li") ?? [])];
  expect(rows.map((row) => row.textContent)).toEqual([
    "Memory guidancein the prompt≈250",
    "MEMORY.mdempty≈0",
    "notes.mdon demand≈10",
  ]);
  await view.unmount();
});
