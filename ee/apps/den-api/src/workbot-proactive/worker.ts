import { meetingPrepReplySchema } from "@openwork/automations/proactive"
import { appLogger } from "../observability/logger.js"
import { readMemberGoogleCalendar } from "../routes/org/google-workspace.js"
import { slackTurnModel } from "../slack-assistant/headless.js"
import { slackClient } from "../slack-assistant/protocol.js"
import { listProactiveCandidates, proactiveAllowed, readProactiveSettings, resolveProactiveSlackTarget, type ProactiveSlackTarget } from "./access.js"
import { defaultReadOnlyCheckDeps, runReadOnlyCheck } from "./check.js"
import { checkProactiveMember, type ProactiveCheckDeps } from "./check-member.js"
import type { SlackMessage } from "./messages.js"
import {
  claimDueProactiveMembers,
  ensureProactiveMembers,
  finishProactiveNotification,
  handledProactiveKeys,
  holdsProactiveLease,
  proactiveSentSince,
  pruneProactiveNotifications,
  reserveProactiveNotification,
  settleProactiveMember,
} from "./repository.js"

/**
 * Workbot's proactive heads-ups loop: a schedule wakes a check for one member (check-member.ts), the check reads
 * their calendar and either sends one Slack message or stays quiet. Wake sources stay explicit: this loop, and later
 * a calendar push that sets the member's `next_check_at` to now. Nothing lets a model schedule its own wake-up.
 */

const TICK_MS = 15_000
const MAX_CONCURRENT_CHECKS = 4
const DISCOVERY_MS = 10 * 60_000
const LEDGER_RETENTION_MS = 30 * 24 * 3_600_000

/** Opens the member's DM with the app and posts there. */
export async function postProactiveDm(target: ProactiveSlackTarget, message: SlackMessage) {
  const slack = slackClient(target.installation.botToken)
  const opened = await slack("conversations.open", { users: target.slackUserId })
  const channel = typeof opened.channel === "object" && opened.channel !== null && "id" in opened.channel && typeof opened.channel.id === "string" ? opened.channel.id : null
  if (!channel) throw new Error("slack_dm_unavailable")
  const posted = await slack("chat.postMessage", { channel, text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false })
  return { channelId: channel, messageTs: typeof posted.ts === "string" ? posted.ts : "" }
}

export const defaultProactiveCheckDeps: ProactiveCheckDeps = {
  now: Date.now,
  allowed: proactiveAllowed,
  settings: readProactiveSettings,
  target: resolveProactiveSlackTarget,
  calendar: readMemberGoogleCalendar,
  handled: handledProactiveKeys,
  reserve: reserveProactiveNotification,
  finish: finishProactiveNotification,
  sentSince: proactiveSentSince,
  holdsLease: (row) => holdsProactiveLease(row),
  settle: (row, changes) => settleProactiveMember(row, changes),
  model: (target) => slackTurnModel(target.installation, { userId: target.userId }).catch(() => null),
  check: (input) =>
    runReadOnlyCheck(
      { actor: { userId: input.target.userId, organizationId: input.target.organizationId }, model: input.model, prompt: input.prompt, key: input.key, schema: meetingPrepReplySchema },
      defaultReadOnlyCheckDeps(),
    ),
  post: postProactiveDm,
}

/** Adds rows for members who linked Slack in organizations that turned heads-ups on. */
export async function discoverProactiveMembers() {
  for (const candidate of await listProactiveCandidates()) await ensureProactiveMembers(candidate.organizationId, candidate.memberIds)
}

export function startWorkbotProactiveWorker(deps: ProactiveCheckDeps = defaultProactiveCheckDeps) {
  // Heads-ups are delivered by the Slack assistant, so its worker switch also stops them.
  if (process.env.DEN_SLACK_ASSISTANT_WORKER_ENABLED === "false") return async () => {}
  let stopped = false
  let running = 0
  let claiming = false
  let lastDiscovery = 0
  const tick = async () => {
    if (stopped || claiming) return
    claiming = true
    try {
      const now = deps.now()
      if (now - lastDiscovery >= DISCOVERY_MS) {
        lastDiscovery = now
        await discoverProactiveMembers()
        await pruneProactiveNotifications(new Date(now - LEDGER_RETENTION_MS))
      }
      const capacity = MAX_CONCURRENT_CHECKS - running
      if (capacity <= 0) return
      for (const row of await claimDueProactiveMembers(capacity, new Date(now))) {
        running += 1
        void checkProactiveMember(row, deps)
          .catch(async () => {
            appLogger.warn("workbot_proactive_check_failed", { member_id: row.memberId })
            await deps.settle(row, { nextCheckAt: new Date(deps.now() + 15 * 60_000), failures: row.failures + 1 }).catch(() => false)
          })
          .finally(() => {
            running -= 1
          })
      }
    } catch {
      appLogger.warn("workbot_proactive_queue_unavailable", {})
    } finally {
      claiming = false
    }
  }
  const timer = setInterval(() => void tick(), TICK_MS)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
  }
}
