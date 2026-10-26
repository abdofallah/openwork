import { MemoryStore, loadMemoryOverview } from "../memory/index.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";

interface RegisterWorkspaceMemoryRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

/**
 * GET /workspace/:id/memory: the Claude Code compatible memory the engine
 * injects for this workspace, as the composer's memory popup shows it.
 *
 * The engine's injected system text is not tagged on either engine, so the app
 * cannot tell memory apart from ordinary system text in a context response.
 * This route resolves the same directory the memory plugin resolves and reports
 * the index, the topic files, and the token cost of the injected segment.
 */
export function registerWorkspaceMemoryRoutes(options: RegisterWorkspaceMemoryRoutesOptions): void {
  const { routes, config, jsonResponse, resolveWorkspaceWithoutBootstrap } = options;

  addRoute(routes, "GET", "/workspace/:id/memory", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    return jsonResponse(await loadMemoryOverview(new MemoryStore(workspace.path)));
  });
}
