import { and, eq, inArray, isNotNull } from "@openwork-ee/den-db/drizzle"
import {
  OrganizationTable,
  SlackAssistantIdentityTable as Identity,
  SlackAssistantInstallationTable as Installation,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotProactiveSettings, type WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { headlessRunnerConfig } from "../headless-runner/client.js"
import { resolveSlackActor, type InstallationRow } from "../slack-assistant/repository.js"
import { workbotOrigin } from "../workbot/config.js"

/**
 * Who may get heads-ups, and where they go. Three switches, all required: the `workbotProactive` feature (with
 * member overrides), Workbot on this deployment (`DEN_WORKBOT_URL`, the same capability that gates Workbot), and
 * the organization's own Proactive switch. Delivery goes through the Slack assistant, under the same gates as a
 * reply: installed and on, and the member still connected and allowed to use it.
 */

export async function proactiveAllowed(organizationId: string, userId?: string) {
  if (workbotOrigin() === null) return false
  return organizationFeatureEnabled(organizationId, "workbotProactive", userId ? { userId } : {})
}

export async function readProactiveSettings(organizationId: DenTypeId<"organization">): Promise<WorkbotProactiveSettings> {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  return readWorkbotProactiveSettings(organization?.metadata)
}

export function proactiveRunnerReady(env: Record<string, string | undefined> = process.env) {
  return headlessRunnerConfig(env) !== null
}

async function readyInstallations(organizationId: DenTypeId<"organization">) {
  return db
    .select()
    .from(Installation)
    .where(and(eq(Installation.organizationId, organizationId), eq(Installation.enabled, true), isNotNull(Installation.botToken), isNotNull(Installation.teamId)))
}

/** The Slack assistant is installed and on for the organization: heads-ups have somewhere to go. */
export async function proactiveSlackReady(organizationId: DenTypeId<"organization">) {
  return (await readyInstallations(organizationId)).length > 0
}

export type ProactiveSlackTarget = {
  installation: InstallationRow & { botToken: string }
  slackUserId: string
  userId: string
  memberId: DenTypeId<"member">
  organizationId: DenTypeId<"organization">
}

/** Where a member's heads-ups go, or null when the Slack assistant would not answer them as themselves. */
export async function resolveProactiveSlackTarget(
  organizationId: DenTypeId<"organization">,
  memberId: DenTypeId<"member">,
): Promise<ProactiveSlackTarget | null> {
  const installations = await readyInstallations(organizationId)
  if (!installations.length) return null
  const identities = await db
    .select()
    .from(Identity)
    .where(and(eq(Identity.memberId, memberId), inArray(Identity.connectionId, installations.map((row) => row.connectionId))))
  for (const identity of identities) {
    const installation = installations.find((row) => row.connectionId === identity.connectionId)
    const botToken = installation?.botToken
    if (!installation || !botToken) continue
    const actor = await resolveSlackActor(installation, identity.slackUserId)
    if (actor && actor.memberId === memberId) {
      return { installation: { ...installation, botToken }, slackUserId: identity.slackUserId, userId: actor.userId, memberId, organizationId }
    }
  }
  return null
}

/** Members who linked Slack in organizations that turned heads-ups on: the ones worth checking. */
export async function listProactiveCandidates(): Promise<{ organizationId: DenTypeId<"organization">; memberIds: DenTypeId<"member">[] }[]> {
  if (workbotOrigin() === null) return []
  const installations = await db
    .select({ connectionId: Installation.connectionId, organizationId: Installation.organizationId })
    .from(Installation)
    .where(and(eq(Installation.enabled, true), isNotNull(Installation.botToken)))
  const byOrganization = new Map<DenTypeId<"organization">, DenTypeId<"externalMcpConnection">[]>()
  for (const row of installations) byOrganization.set(row.organizationId, [...(byOrganization.get(row.organizationId) ?? []), row.connectionId])
  const candidates: { organizationId: DenTypeId<"organization">; memberIds: DenTypeId<"member">[] }[] = []
  for (const [organizationId, connectionIds] of byOrganization) {
    if (!(await readProactiveSettings(organizationId)).enabled) continue
    const linked = await db.select({ memberId: Identity.memberId }).from(Identity).where(inArray(Identity.connectionId, connectionIds))
    candidates.push({ organizationId, memberIds: [...new Set(linked.map((row) => row.memberId))] })
  }
  return candidates
}
