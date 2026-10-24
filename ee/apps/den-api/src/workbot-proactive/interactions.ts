import { isValidTimeZone } from "@openwork/automations/proactive"
import { z } from "zod"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { slackClient, type SlackCall } from "../slack-assistant/protocol.js"
import { resolveSlackActor, type InstallationRow } from "../slack-assistant/repository.js"
import { proactiveAllowed, readProactiveSettings } from "./access.js"
import { controlStatus, homeProactiveBlocks, parseControlAction, PROACTIVE_ACTION_PREFIX, undoOf, withControlState, type SlackBlock } from "./messages.js"
import { homeStateFor, preferenceChange } from "./policy.js"
import { readProactiveMember, saveProactivePreferences } from "./repository.js"

/**
 * The member's own controls, from Slack: the buttons under each heads-up and the Home tab's Heads-ups section.
 * Each press records the choice for the member who pressed it (resolved from Slack's signed payload, never from the
 * button's value), then updates what they see. With the feature off, buttons answer quietly and change nothing.
 */

/** The Home tab's Heads-ups section for one Slack user; empty when heads-ups don't apply to them. */
export async function proactiveHomeSection(installation: InstallationRow, slackUserId: string, now = Date.now()): Promise<SlackBlock[]> {
  const actor = await resolveSlackActor(installation, slackUserId)
  if (!actor || !(await proactiveAllowed(actor.organizationId, actor.userId))) return []
  const settings = await readProactiveSettings(actor.organizationId)
  if (!settings.enabled) return []
  const row = await readProactiveMember(actor.memberId)
  const timeZone = row && isValidTimeZone(row.timeZone) ? row.timeZone : "UTC"
  const connectUrl = new URL("/dashboard/your-connections", env.betterAuthUrl).toString()
  return homeProactiveBlocks(settings, homeStateFor(row, settings, now, connectUrl), now, timeZone)
}

const interactionSchema = z.object({
  user: z.object({ id: z.string() }),
  container: z.object({ type: z.string(), channel_id: z.string().optional(), message_ts: z.string().optional() }).optional(),
  message: z.object({ text: z.string().optional(), blocks: z.array(z.unknown()).optional() }).optional(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).optional(),
})

export type ProactiveInteractionDeps = {
  slack: (token: string) => SlackCall
  now: () => number
  publishHome: (slack: SlackCall, installation: InstallationRow, slackUserId: string) => Promise<void>
}

/**
 * Handles a Heads-ups button press. Returns false when the payload is not ours, so other handlers can look at it.
 * Slack expects an answer within three seconds: the choice is saved before answering, the message update is not
 * awaited.
 */
export async function handleProactiveInteraction(installation: InstallationRow, payload: unknown, deps: ProactiveInteractionDeps): Promise<boolean> {
  const parsed = interactionSchema.safeParse(payload)
  if (!parsed.success) return false
  const pressed = parsed.data.actions?.find((item) => item.action_id.startsWith(PROACTIVE_ACTION_PREFIX))
  if (!pressed) return false
  const control = parseControlAction(pressed.action_id, pressed.value)
  // A link button (Connect Google Calendar) still reports its press; nothing to record.
  if (!control) return true
  const actor = await resolveSlackActor(installation, parsed.data.user.id)
  if (!actor || !installation.botToken || !(await proactiveAllowed(actor.organizationId, actor.userId))) return true

  const now = deps.now()
  const [settings, row] = await Promise.all([readProactiveSettings(actor.organizationId), readProactiveMember(actor.memberId)])
  const timeZone = row && isValidTimeZone(row.timeZone) ? row.timeZone : "UTC"
  const { change, snoozedUntil } = preferenceChange(control.action, control.kind, row, settings, now, timeZone)
  await saveProactivePreferences(actor.organizationId, actor.memberId, change, new Date(now))
  appLogger.info("workbot_proactive_control", { member_id: actor.memberId, action: control.action, kind: control.kind })

  const slack = deps.slack(installation.botToken)
  const container = parsed.data.container
  if (container?.type === "message" && container.channel_id && container.message_ts && parsed.data.message?.blocks) {
    const undo = undoOf(control.action)
    const status = controlStatus(control.action, control.kind, snoozedUntil, now, timeZone)
    void slack("chat.update", {
      channel: container.channel_id,
      ts: container.message_ts,
      text: parsed.data.message.text ?? "",
      blocks: withControlState(parsed.data.message.blocks, control.kind, undo && status ? { status, undo } : null),
    }).catch(() => appLogger.warn("workbot_proactive_message_update_failed", { member_id: actor.memberId }))
  } else {
    void deps.publishHome(slack, installation, parsed.data.user.id).catch(() => appLogger.warn("workbot_proactive_home_update_failed", { member_id: actor.memberId }))
  }
  return true
}

export function defaultProactiveInteractionDeps(publishHome: ProactiveInteractionDeps["publishHome"]): ProactiveInteractionDeps {
  return { slack: slackClient, now: Date.now, publishHome }
}
