import {
  CALENDAR_PROACTIVE_DEFAULTS,
  detectCalendarSignals,
  isValidTimeZone,
  meetingPrepPrompt,
  nextCalendarCheck,
  nextWorkingStart,
  parseCalendarCheckpoint,
  planCalendarDeliveries,
  projectGoogleCalendarEvents,
  proactiveLedgerKey,
  selectProactiveDeliveries,
  withinWorkingHours,
  zonedDayStart,
  type CalendarDelivery,
  type MeetingPrepReply,
  type ProactiveKind,
} from "@openwork/automations/proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import { appLogger } from "../observability/logger.js"
import type { MemberCalendarRead } from "../routes/org/google-workspace.js"
import type { ProactiveSlackTarget } from "./access.js"
import type { ReadOnlyCheckResult } from "./check.js"
import { calendarChangeMessage, meetingPrepMessage, morningBriefMessage, type SlackMessage } from "./messages.js"
import { enabledKinds, memberOptedIn, mutedKindsOf, proactivePolicy } from "./policy.js"
import type { NotificationOutcome, ProactiveMemberRow, ProactiveSettle } from "./repository.js"

/**
 * One proactive check for one claimed member: gates, one read-only calendar read, detection and policy, then one
 * Slack message per delivery or silence. Every dependency is injected (worker.ts wires the real ones), so the whole
 * decision is testable without a database, Slack, Google or a model.
 */

const HOUR_MS = 3_600_000
/** Meeting-prep model checks per member per wake; the rest wait for the next wake, still inside their window. */
const MAX_PREP_CHECKS = 2

type Ledger = { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; kind: ProactiveKind; key: string; outcome?: NotificationOutcome }

export type ProactiveCheckDeps = {
  now: () => number
  allowed: (organizationId: string, userId: string) => Promise<boolean>
  settings: (organizationId: DenTypeId<"organization">) => Promise<WorkbotProactiveSettings>
  target: (organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) => Promise<ProactiveSlackTarget | null>
  calendar: (input: { organizationId: DenTypeId<"organization">; orgMembershipId: DenTypeId<"member">; timeMin: string; timeMax: string }) => Promise<MemberCalendarRead>
  handled: (memberId: DenTypeId<"member">, signals: readonly { kind: ProactiveKind; key: string }[]) => Promise<Set<string>>
  reserve: (input: Ledger) => Promise<string | null>
  finish: (id: string, outcome: NotificationOutcome, message?: { channelId: string; messageTs: string }) => Promise<void>
  sentSince: (memberId: DenTypeId<"member">, since: Date) => Promise<number>
  holdsLease: (row: ProactiveMemberRow) => Promise<boolean>
  settle: (row: ProactiveMemberRow, changes: ProactiveSettle) => Promise<boolean>
  model: (target: ProactiveSlackTarget) => Promise<string | null>
  check: (input: { target: ProactiveSlackTarget; model: string; prompt: string; key: string }) => Promise<ReadOnlyCheckResult<MeetingPrepReply>>
  post: (target: ProactiveSlackTarget, message: SlackMessage) => Promise<{ channelId: string; messageTs: string }>
}

type SkipReason = "off" | "no_slack" | "not_allowed" | "opted_out" | "snoozed" | "outside_hours" | "no_calendar"

export type ProactiveCheckOutcome =
  | { status: "skipped"; reason: SkipReason }
  | { status: "checked"; sent: number; quiet: number; capped: number; failed: number }

function iso(at: number) {
  return new Date(at).toISOString()
}

/** One check for one claimed member. Always settles the member (next check time, checkpoint) before returning. */
export async function checkProactiveMember(row: ProactiveMemberRow, deps: ProactiveCheckDeps): Promise<ProactiveCheckOutcome> {
  const now = deps.now()
  const skip = async (reason: SkipReason, nextCheckAt: number, changes: Partial<ProactiveSettle> = {}): Promise<ProactiveCheckOutcome> => {
    await deps.settle(row, { ...changes, nextCheckAt: new Date(nextCheckAt) })
    return { status: "skipped", reason }
  }
  const settings = await deps.settings(row.organizationId)
  if (!settings.enabled) return skip("off", now + HOUR_MS)
  const target = await deps.target(row.organizationId, row.memberId)
  if (!target) return skip("no_slack", now + HOUR_MS)
  if (!(await deps.allowed(row.organizationId, target.userId))) return skip("not_allowed", now + HOUR_MS)
  if (!memberOptedIn(row, settings)) return skip("opted_out", now + 6 * HOUR_MS)
  if (row.snoozedUntil && row.snoozedUntil.getTime() > now) return skip("snoozed", row.snoozedUntil.getTime())

  const policy = proactivePolicy(settings)
  const storedZone = isValidTimeZone(row.timeZone) ? row.timeZone : null
  if (storedZone && !withinWorkingHours(policy, now, storedZone)) return skip("outside_hours", nextWorkingStart(policy, now, storedZone))

  // Observe: one read-only calendar read, as the member.
  const read = await deps.calendar({
    organizationId: row.organizationId,
    orgMembershipId: row.memberId,
    timeMin: iso(now - 15 * 60_000),
    timeMax: iso(now + CALENDAR_PROACTIVE_DEFAULTS.horizonMs + 2 * HOUR_MS),
  })
  if (read.kind !== "ok") {
    appLogger.info("workbot_proactive_calendar_unavailable", { member_id: row.memberId, reason: read.kind })
    return skip("no_calendar", now + Math.min(6, row.failures + 1) * HOUR_MS, { failures: row.failures + 1 })
  }
  const projected = projectGoogleCalendarEvents(read.json)
  const timeZone = isValidTimeZone(projected.timeZone) ? projected.timeZone : storedZone ?? "UTC"
  const detected = detectCalendarSignals({
    events: projected.events,
    previous: parseCalendarCheckpoint(row.checkpoint),
    now,
    timeZone,
    leadMinutes: settings.leadMinutes,
    policy,
  })
  const done = async (outcome: ProactiveCheckOutcome) => {
    await deps.settle(row, {
      checkpoint: JSON.stringify(detected.checkpoint),
      timeZone,
      lastCheckedAt: new Date(now),
      failures: 0,
      nextCheckAt: new Date(nextCalendarCheck({ now: deps.now(), events: projected.events, leadMinutes: settings.leadMinutes, policy, timeZone, pollMs: CALENDAR_PROACTIVE_DEFAULTS.pollMs })),
    })
    return outcome
  }
  // The first check of someone new learns their time zone; outside their hours it only records the calendar.
  if (!withinWorkingHours(policy, now, timeZone)) return done({ status: "skipped", reason: "outside_hours" })

  // Policy: enabled and muted kinds, what was already handled, then the daily cap.
  const enabled = enabledKinds(settings)
  const muted = mutedKindsOf(row)
  const planned = planCalendarDeliveries(detected.signals, { briefEnabled: enabled.has("morning_brief") && !muted.has("morning_brief") })
  const signalKeys: { kind: ProactiveKind; key: string }[] = []
  for (const delivery of planned) {
    for (const key of delivery.keys) signalKeys.push({ kind: delivery.kind, key })
    if (delivery.kind === "morning_brief") for (const key of delivery.changeKeys) signalKeys.push({ kind: "calendar_change", key })
  }
  const handled = await deps.handled(row.memberId, signalKeys)
  const { candidates } = selectProactiveDeliveries({ deliveries: planned, enabled, muted, handled })

  const tally = { sent: 0, quiet: 0, capped: 0, failed: 0 }
  let sentToday = await deps.sentSince(row.memberId, new Date(zonedDayStart(now, timeZone)))
  let prepChecks = 0
  const reserve = (kind: ProactiveKind, key: string, outcome?: NotificationOutcome) =>
    deps.reserve({ organizationId: row.organizationId, memberId: row.memberId, kind, key, ...(outcome ? { outcome } : {}) })

  for (const delivery of candidates) {
    if (delivery.kind === "meeting_prep" && prepChecks >= MAX_PREP_CHECKS) continue
    if (sentToday >= settings.dailyCap) {
      for (const key of delivery.keys) await reserve(delivery.kind, key, "capped")
      tally.capped += 1
      continue
    }
    const [mainKey, ...restKeys] = delivery.keys
    if (!mainKey) continue
    const id = await reserve(delivery.kind, mainKey)
    if (!id) continue
    // Changes carried by the same message are recorded with it, so none is ever repeated on its own.
    for (const key of restKeys) await reserve(delivery.kind, key, "folded")

    const message = await compose(delivery, { target, deps, timeZone, handled, changesAllowed: enabled.has("calendar_change") && !muted.has("calendar_change"), reserve, onPrepCheck: () => { prepChecks += 1 } })
    if (message.kind !== "message") {
      await deps.finish(id, message.kind)
      tally[message.kind] += 1
      continue
    }
    // Right before sending: still this instance's member, and the feature still on (a kill switch wins).
    if (!(await deps.holdsLease(row)) || !(await deps.allowed(row.organizationId, target.userId))) {
      await deps.finish(id, "failed")
      tally.failed += 1
      break
    }
    try {
      await deps.finish(id, "sent", await deps.post(target, message.message))
      sentToday += 1
      tally.sent += 1
    } catch (error) {
      appLogger.warn("workbot_proactive_post_failed", { member_id: row.memberId, kind: delivery.kind, code: error instanceof Error ? error.message.slice(0, 64) : "post_failed" })
      await deps.finish(id, "failed")
      tally.failed += 1
    }
  }
  appLogger.info("workbot_proactive_checked", { member_id: row.memberId, signals: detected.signals.length, ...tally })
  return done({ status: "checked", ...tally })
}

type ComposeResult = { kind: "message"; message: SlackMessage } | { kind: "quiet" | "failed" }

async function compose(
  delivery: CalendarDelivery,
  context: {
    target: ProactiveSlackTarget
    deps: ProactiveCheckDeps
    timeZone: string
    handled: ReadonlySet<string>
    changesAllowed: boolean
    reserve: (kind: ProactiveKind, key: string, outcome?: NotificationOutcome) => Promise<string | null>
    onPrepCheck: () => void
  },
): Promise<ComposeResult> {
  const { deps, timeZone } = context
  if (delivery.kind === "calendar_change") return { kind: "message", message: calendarChangeMessage(delivery, deps.now(), timeZone) }
  if (delivery.kind === "morning_brief") {
    const changes: typeof delivery.changes = []
    if (context.changesAllowed) {
      for (const [index, change] of delivery.changes.entries()) {
        const key = delivery.changeKeys[index]
        if (!key || context.handled.has(proactiveLedgerKey("calendar_change", key))) continue
        if (await context.reserve("calendar_change", key, "folded")) changes.push(change)
      }
    }
    return { kind: "message", message: morningBriefMessage({ ...delivery, changes }, deps.now(), timeZone) }
  }
  // Meeting prep: a read-only model turn decides whether there is anything worth saying.
  const model = await deps.model(context.target)
  if (!model) return { kind: "failed" }
  context.onPrepCheck()
  const key = delivery.keys[0] ?? delivery.event.id
  const result = await deps.check({ target: context.target, model, prompt: meetingPrepPrompt(delivery.event, deps.now(), timeZone), key: `${context.target.memberId}:${key}` })
  if (result.kind === "notify") return { kind: "message", message: meetingPrepMessage(delivery, result.value, deps.now(), timeZone) }
  if (result.kind === "unavailable") appLogger.info("workbot_proactive_check_unavailable", { member_id: context.target.memberId, code: result.code })
  if (result.kind === "invalid") appLogger.info("workbot_proactive_check_unparsed", { member_id: context.target.memberId })
  return { kind: result.kind === "quiet" ? "quiet" : "failed" }
}

