import type { Seed } from "@openwork/env";
import { healthFixture } from "./den-service-readiness.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * Den with Workbot deployed here (DEN_WORKBOT_URL), a configured headless runner (the readiness fixture: it answers
 * health checks and nothing else) and `workbotProactive` rolled out to one organization. No Slack app, calendar or
 * model: the admin settings and their locks are real, and nothing is ever sent.
 */
export async function workbotProactiveWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const runner = stack.use(await healthFixture());
    const den = await seed.den({
      org: {
        name: "Heads-up settings",
        admin: { name: "Workspace Owner" },
        members: { member: { name: "Workspace Member" } },
      },
      env: {
        DEN_WORKBOT_URL: "http://localhost:3020",
        DEN_HEADLESS_RUNNER_URL: runner.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
        // Heads-ups are delivered by the Slack assistant's worker; nothing here should try to deliver.
        DEN_SLACK_ASSISTANT_WORKER_ENABLED: "false",
      },
    });
    await enableOrganizationCapabilities(seed, den.admin, { workbotProactive: true });
    const viewport = { width: 1280, height: 1400, deviceScaleFactor: 1 };
    const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard", headless: true, viewport });
    return { den, owner, member, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
