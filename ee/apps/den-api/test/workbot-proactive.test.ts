import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  meetingPrepReplySchema,
  planCalendarDeliveries,
  projectGoogleCalendarEvents,
  proactiveLedgerKey,
  PROACTIVE_ROUTINE_MARKER,
  type CalendarDelivery,
} from "@openwork/automations/proactive"
import {
  DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
  mergeWorkbotProactiveSettings,
  readWorkbotProactiveSettings,
  withWorkbotProactiveSettings,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { HeadlessRunnerDeps } from "../src/headless-runner/client.js"
import type { ProactiveSlackTarget } from "../src/workbot-proactive/access.js"
import type { ProactiveCheckDeps } from "../src/workbot-proactive/check-member.js"
import type { ReadOnlyCheckResult } from "../src/workbot-proactive/check.js"
import type { SlackMessage } from "../src/workbot-proactive/messages.js"
import type { ProactiveMemberRow, ProactiveSettle } from "../src/workbot-proactive/repository.js"

// No database, Slack, Google or model is contacted: every boundary is injected or faked below.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/workbot_proactive_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-workbot-proactive-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-workbot-proactive-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { checkProactiveMember } = await import("../src/workbot-proactive/check-member.js")
const { runReadOnlyCheck } = await import("../src/workbot-proactive/check.js")
const { createHeadlessRunnerClient } = await import("../src/headless-runner/client.js")
const messages = await import("../src/workbot-proactive/messages.js")
const policy = await import("../src/workbot-proactive/policy.js")

const TZ = "America/New_York"
// Tuesday 2026-10-20, 13:45 in New York.
const NOW = Date.parse("2026-10-20T17:45:00Z")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const settingsOn: WorkbotProactiveSettings = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true }

type RawEvent = Record<string, unknown>
function meeting(overrides: RawEvent = {}): RawEvent {
  return {
    id: "evt1",
    status: "confirmed",
    summary: "Quarterly review",
    htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
    created: "2026-10-01T12:00:00Z",
    updated: "2026-10-01T12:00:00.000Z",
    start: { dateTime: "2026-10-20T14:00:00-04:00" },
    end: { dateTime: "2026-10-20T14:30:00-04:00" },
    organizer: { email: "lead@northwind.example", displayName: "Northwind lead" },
    attendees: [
      { email: "me@contoso.example", self: true, responseStatus: "accepted" },
      { email: "lead@northwind.example", displayName: "Northwind lead" },
      { email: "teammate@contoso.example" },
    ],
    ...overrides,
  }
}
const internal = { attendees: [{ email: "me@contoso.example", self: true }, { email: "teammate@contoso.example" }] }

function memberRow(overrides: Partial<ProactiveMemberRow> = {}): ProactiveMemberRow {
  return {
    memberId,
    organizationId,
    optedIn: null,
    mutedKinds: null,
    snoozedUntil: null,
    checkpoint: null,
    timeZone: null,
    lastCheckedAt: null,
    nextCheckAt: new Date(NOW),
    failures: 0,
    leaseOwner: "lease-1",
    leaseUntil: new Date(NOW + 600_000),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  }
}

const target: ProactiveSlackTarget = {
  installation: {
    connectionId: createDenTypeId("externalMcpConnection"),
    organizationId,
    enabled: true,
    signingSecret: "secret",
    teamId: "T1",
    appId: "A1",
    botUserId: "UBOT",
    botToken: "xoxb-test",
    channelIds: null,
    shadowMode: false,
    dailyLimit: 100,
    model: null,
    progressUpdates: false,
    createdAt: new Date(NOW),
  },
  slackUserId: "U123",
  userId: "user_test",
  memberId,
  organizationId,
}

const prepReply = JSON.stringify({
  summary: "They asked about renewal pricing last week.",
  lastThread: { subject: "Renewal questions", when: "Tuesday", url: "https://mail.google.com/mail/u/0/#inbox/abc" },
  openItems: ["Send the updated proposal"],
  links: [{ label: "Agenda", url: "https://docs.google.com/document/d/agenda" }, { label: "Sketchy", url: "https://evil.example/x" }],
})

type Reply = string | ReadOnlyCheckResult<never>
type HarnessState = {
  clock: number
  events: RawEvent[]
  row: ProactiveMemberRow
  ledger: Map<string, string>
  posts: SlackMessage[]
  checks: { prompt: string; key: string }[]
  calendarReads: number
  settles: ProactiveSettle[]
}

/** An in-memory member, ledger and Slack; `events` and `clock` change between runs. */
function harness(input: { settings?: Partial<WorkbotProactiveSettings>; row?: Partial<ProactiveMemberRow>; reply?: Reply; sentToday?: number; allowed?: boolean[] }) {
  const state: HarnessState = {
    clock: NOW,
    events: [meeting()],
    row: memberRow(input.row),
    ledger: new Map(),
    posts: [],
    checks: [],
    calendarReads: 0,
    settles: [],
  }
  let allowedCalls = 0
  const deps: ProactiveCheckDeps = {
    now: () => state.clock,
    allowed: async () => input.allowed?.[allowedCalls++] ?? true,
    settings: async () => ({ ...settingsOn, ...input.settings }),
    target: async () => target,
    calendar: async () => {
      state.calendarReads += 1
      return { kind: "ok", json: { timeZone: TZ, items: state.events } }
    },
    handled: async (_member, signals) => new Set(signals.map((s) => proactiveLedgerKey(s.kind, s.key)).filter((key) => state.ledger.has(key))),
    reserve: async (entry) => {
      const key = proactiveLedgerKey(entry.kind, entry.key)
      if (state.ledger.has(key)) return null
      state.ledger.set(key, entry.outcome ?? "pending")
      return key
    },
    finish: async (id, outcome) => {
      state.ledger.set(id, outcome)
    },
    sentSince: async () => (input.sentToday ?? 0) + [...state.ledger.values()].filter((outcome) => outcome === "sent").length,
    holdsLease: async () => true,
    settle: async (_row, changes) => {
      state.settles.push(changes)
      state.row = { ...state.row, ...changes, leaseOwner: "lease-1" }
      return true
    },
    model: async () => "openai/gpt-6-luna",
    check: async (call) => {
      state.checks.push({ prompt: call.prompt, key: call.key })
      const reply = input.reply ?? prepReply
      if (typeof reply !== "string") return reply
      const { parseProactiveReply } = await import("@openwork/automations/proactive")
      return parseProactiveReply(reply, meetingPrepReplySchema)
    },
    post: async (_target, message) => {
      state.posts.push(message)
      return { channelId: "D1", messageTs: `1.${state.posts.length}` }
    },
  }
  return { state, deps, run: () => checkProactiveMember(state.row, deps) }
}

function textOf(message: SlackMessage | undefined) {
  return JSON.stringify(message?.blocks ?? [])
}

describe("checking one member", () => {
  test("a meeting with outsiders 15 minutes away gets one prep message, from a hidden read-only check", async () => {
    const h = harness({})
    assert.deepEqual(await h.run(), { status: "checked", sent: 1, quiet: 0, capped: 0, failed: 0 })
    assert.equal(h.state.checks.length, 1)
    assert.ok(h.state.checks[0]?.prompt.startsWith(PROACTIVE_ROUTINE_MARKER))
    const posted = textOf(h.state.posts[0])
    assert.match(posted, /Quarterly review/)
    assert.match(posted, /in 15 min/)
    assert.match(posted, /Because you have Quarterly review at 2:00 PM\./)
    assert.match(posted, /<https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\/abc\|Renewal questions>/)
    assert.doesNotMatch(posted, /evil\.example/)
    assert.match(posted, /Mute meeting prep/)
    assert.equal(h.state.settles.at(-1)?.timeZone, TZ)
    assert.ok(h.state.settles.at(-1)?.checkpoint)

    // Five minutes later the same meeting is never checked or sent again.
    h.state.clock += 5 * 60_000
    assert.deepEqual(await h.run(), { status: "checked", sent: 0, quiet: 0, capped: 0, failed: 0 })
    assert.equal(h.state.checks.length, 1)
    assert.equal(h.state.posts.length, 1)
  })

  test("NO_REPLY sends nothing, and the meeting is not asked about again", async () => {
    const h = harness({ reply: "NO_REPLY" })
    assert.deepEqual(await h.run(), { status: "checked", sent: 0, quiet: 1, capped: 0, failed: 0 })
    assert.equal(h.state.posts.length, 0)
    h.state.clock += 5 * 60_000
    await h.run()
    assert.equal(h.state.checks.length, 1)
  })

  test("a runner outage or an unreadable answer is silence too", async () => {
    const replies: Reply[] = [{ kind: "unavailable", code: "runner_unreachable" }, "Sure! Here's a summary of everything."]
    for (const reply of replies) {
      const h = harness({ reply })
      const outcome = await h.run()
      assert.equal(h.state.posts.length, 0)
      assert.deepEqual(outcome, { status: "checked", sent: 0, quiet: 0, capped: 0, failed: 1 })
    }
  })

  test("the first check records the calendar quietly; then a move by someone else is one message", async () => {
    const h = harness({})
    h.state.events = [meeting({ ...internal, id: "sync", start: { dateTime: "2026-10-21T14:00:00-04:00" }, end: { dateTime: "2026-10-21T14:30:00-04:00" } })]
    await h.run()
    assert.equal(h.state.posts.length, 0)
    h.state.clock += 5 * 60_000
    h.state.events = [meeting({ ...internal, id: "sync", updated: "2026-10-20T17:48:00Z", start: { dateTime: "2026-10-21T15:00:00-04:00" }, end: { dateTime: "2026-10-21T15:30:00-04:00" } })]
    assert.deepEqual(await h.run(), { status: "checked", sent: 1, quiet: 0, capped: 0, failed: 0 })
    const posted = textOf(h.state.posts[0])
    assert.match(posted, /moved to tomorrow at 3:00 PM \(was 2:00 PM\)/)
    assert.match(posted, /Because someone else changed a meeting you have today or tomorrow\./)
    assert.match(posted, /Mute calendar changes/)
    assert.equal(h.state.checks.length, 0, "changes need no model")
  })

  test("past the daily limit nothing is sent and nothing is retried later", async () => {
    const h = harness({ sentToday: 3 })
    assert.deepEqual(await h.run(), { status: "checked", sent: 0, quiet: 0, capped: 1, failed: 0 })
    assert.equal(h.state.checks.length, 0)
    assert.equal(h.state.ledger.get(proactiveLedgerKey("meeting_prep", `evt1:${Date.parse("2026-10-20T18:00:00Z")}`)), "capped")
  })

  test("outside working hours it does not even read the calendar", async () => {
    const h = harness({ row: { timeZone: TZ } })
    h.state.clock = Date.parse("2026-10-21T00:30:00Z") // 20:30 in New York
    assert.deepEqual(await h.run(), { status: "skipped", reason: "outside_hours" })
    assert.equal(h.state.calendarReads, 0)
    assert.equal(h.state.settles.at(-1)?.nextCheckAt.toISOString(), "2026-10-21T12:00:00.000Z")
  })

  test("members who turned it off, snoozed, or muted the kind are not checked", async () => {
    const off = harness({ row: { optedIn: false } })
    assert.deepEqual(await off.run(), { status: "skipped", reason: "opted_out" })
    const mustOptIn = harness({ settings: { membersStart: "opted_out" } })
    assert.deepEqual(await mustOptIn.run(), { status: "skipped", reason: "opted_out" })
    const snoozed = harness({ row: { snoozedUntil: new Date(NOW + 3_600_000) } })
    assert.deepEqual(await snoozed.run(), { status: "skipped", reason: "snoozed" })
    for (const h of [off, mustOptIn, snoozed]) assert.equal(h.state.calendarReads, 0)
    const muted = harness({ row: { mutedKinds: ["meeting_prep"] } })
    await muted.run()
    assert.equal(muted.state.checks.length, 0)
    assert.equal(muted.state.posts.length, 0)
  })

  test("a kill switch between deciding and posting wins", async () => {
    const h = harness({ allowed: [true, false] })
    assert.deepEqual(await h.run(), { status: "checked", sent: 0, quiet: 0, capped: 0, failed: 1 })
    assert.equal(h.state.posts.length, 0)
  })

  test("with the organization switch off nothing is read", async () => {
    const h = harness({ settings: { enabled: false } })
    assert.deepEqual(await h.run(), { status: "skipped", reason: "off" })
    assert.equal(h.state.calendarReads, 0)
  })
})

describe("the read-only check on the runner", () => {
  function fakeRunner(answer: string) {
    const calls: { method: string; path: string; body: unknown }[] = []
    const minted: { readOnly?: boolean }[] = []
    const deps: HeadlessRunnerDeps = {
      config: { url: "http://127.0.0.1:9", token: "t".repeat(40) },
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        calls.push({ method: init?.method ?? "GET", path: url.pathname, body })
        const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
        if (init?.method === "POST" && url.pathname === "/v1/sessions") return json(201, { id: "hs_check12345" })
        if (init?.method === "POST" && url.pathname.endsWith("/turns")) return json(202, { state: "accepted" })
        if (init?.method === "DELETE") return new Response(null, { status: 204 })
        const messageId = url.searchParams.get("messageId") ?? ""
        return json(200, {
          turns: [{ messageId, status: "completed", error: null }],
          messages: [
            { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "execute_capability", input: {} }] },
            { role: "tool", callId: "c1", name: "execute_capability", isError: false },
            { role: "assistant", text: answer, toolCalls: [] },
          ],
          finalAssistantText: answer,
        })
      },
      mintToken: async (request) => {
        minted.push({ readOnly: request.readOnly })
        return { token: "mcp-token" }
      },
      maxTokenTtlMs: 3_600_000,
    }
    const checkDeps = { client: createHeadlessRunnerClient(deps), sleep: async () => {}, now: Date.now, pollMs: 0, deadlineMs: 5_000 }
    return { calls, minted, checkDeps }
  }

  const input = { actor: { userId: "user_test", organizationId }, model: "openai/gpt-6-luna", prompt: `${PROACTIVE_ROUTINE_MARKER} Meeting prep.`, key: "k1", schema: meetingPrepReplySchema }

  test("runs in a fresh session with no owner or memory, read-only, and deletes it afterwards", async () => {
    const runner = fakeRunner("NO_REPLY")
    assert.deepEqual(await runReadOnlyCheck(input, runner.checkDeps), { kind: "quiet" })
    const created = runner.calls.find((call) => call.path === "/v1/sessions")
    assert.ok(created && typeof created.body === "object" && created.body !== null)
    assert.equal("owner" in created.body, false)
    assert.equal("memoryScope" in created.body, false)
    assert.equal("memoryOf" in created.body, false)
    assert.match(JSON.stringify(created.body), /Silence is the default/)
    const turn = runner.calls.find((call) => call.path.endsWith("/turns"))
    assert.match(JSON.stringify(turn?.body), /"readOnly":true/)
    assert.deepEqual(runner.minted, [{ readOnly: true }])
    assert.equal(runner.calls.at(-1)?.method, "DELETE")
  })

  test("a JSON answer after tool steps is the notification", async () => {
    const runner = fakeRunner(prepReply)
    const result = await runReadOnlyCheck(input, runner.checkDeps)
    assert.equal(result.kind, "notify")
  })
})

describe("what members see and control", () => {
  const events = projectGoogleCalendarEvents({ timeZone: TZ, items: [meeting({ summary: "Plan <!channel> launch" })] }).events
  const [prep] = planCalendarDeliveries(events.map((event) => ({ kind: "meeting_prep", dedupeKey: `${event.id}:1`, event })), { briefEnabled: false })

  test("untrusted text can't ping a channel or inject links", () => {
    assert.ok(prep?.kind === "meeting_prep")
    const message = messages.meetingPrepMessage(prep, { summary: "Ask @here about <https://evil.example|pricing>" }, NOW, TZ)
    const text = textOf(message)
    assert.doesNotMatch(text, /<!channel>/)
    assert.doesNotMatch(text, /<https:\/\/evil/)
    assert.match(text, /@\u200bhere/)
  })

  test("a pressed button says what happened and offers Undo; Undo brings the buttons back", () => {
    assert.deepEqual(messages.parseControlAction("workbot_proactive:snooze", "meeting_prep"), { action: "snooze", kind: "meeting_prep" })
    assert.equal(messages.parseControlAction("workbot_proactive:delete_everything", "meeting_prep"), null)
    assert.equal(messages.parseControlAction("workbot_proactive:mute", "not_a_kind"), null)
    const original: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }, messages.controlsBlock("meeting_prep")]
    const muted = messages.withControlState(original, "meeting_prep", { status: "Muted meeting prep.", undo: "unmute" })
    assert.match(JSON.stringify(muted), /Muted meeting prep\./)
    assert.match(JSON.stringify(muted), /"action_id":"workbot_proactive:unmute"/)
    assert.doesNotMatch(JSON.stringify(muted), /Snooze until tomorrow/)
    const restored = messages.withControlState(muted, "meeting_prep", null)
    assert.deepEqual(restored, original)
  })

  test("snooze lasts until the next working morning; off and on are the member's own choice", () => {
    const friday = Date.parse("2026-10-23T15:00:00Z")
    const snooze = policy.preferenceChange("snooze", "meeting_prep", null, settingsOn, friday, TZ)
    assert.equal(snooze.change.snoozedUntil?.toISOString(), "2026-10-26T12:00:00.000Z")
    assert.equal(messages.controlStatus("snooze", "meeting_prep", snooze.snoozedUntil, friday, TZ), "Snoozed until Mon at 8:00 AM.")
    assert.deepEqual(policy.preferenceChange("mute", "calendar_change", { mutedKinds: ["meeting_prep"] }, settingsOn, NOW, TZ).change, { mutedKinds: ["meeting_prep", "calendar_change"] })
    assert.deepEqual(policy.preferenceChange("on", "meeting_prep", null, settingsOn, NOW, TZ).change, { optedIn: true, snoozedUntil: null })
    assert.equal(policy.memberOptedIn({ optedIn: null }, { ...settingsOn, membersStart: "opted_out" }), false)
  })

  test("the Home tab answers what heads-ups a member gets", () => {
    const home = messages.homeProactiveBlocks({ ...settingsOn, morningBrief: true }, { state: "on", muted: new Set(["calendar_change"]) }, NOW, TZ)
    const text = JSON.stringify(home)
    assert.match(text, /\*On\.\* I message you here only when something needs your attention/)
    assert.match(text, /15 min before a meeting with people outside your company/)
    assert.match(text, /adds, moves or cancels a meeting you have today or tomorrow \(muted\)/)
    assert.match(text, /At the start of your workday/)
    assert.match(text, /Weekdays, 8 AM to 7 PM in your calendar's time zone\. At most 3 a day\./)
    assert.match(text, /Unmute calendar changes/)
    const needsCalendar = policy.homeStateFor({ optedIn: null, mutedKinds: null, snoozedUntil: null, checkpoint: null, failures: 2 }, settingsOn, NOW, "http://unit.test/dashboard/your-connections")
    assert.equal(needsCalendar.state, "needs_calendar")
  })

  test("a brief is one message with the day's meetings and overnight changes", () => {
    const morning = Date.parse("2026-10-20T12:10:00Z")
    const day = projectGoogleCalendarEvents({ timeZone: TZ, items: [meeting({ start: { dateTime: "2026-10-20T10:00:00-04:00" }, end: { dateTime: "2026-10-20T11:00:00-04:00" } })] }).events
    const delivery: CalendarDelivery = { kind: "morning_brief", keys: ["brief:2026-10-20"], brief: { day: "2026-10-20", meetings: day, overlaps: [], needsPrep: day.map((m) => m.id) }, changes: [], changeKeys: [] }
    const message = messages.morningBriefMessage(delivery, morning, TZ)
    assert.match(textOf(message), /\*Your day:\* 1 meeting, first at 10:00 AM/)
    assert.match(textOf(message), /needs prep/)
    assert.match(textOf(message), /Because it's the start of your workday\./)
  })
})

describe("organization settings", () => {
  test("missing or broken fields read as defaults, field by field, and invalid hours are refused", () => {
    assert.deepEqual(readWorkbotProactiveSettings(null), DEFAULT_WORKBOT_PROACTIVE_SETTINGS)
    const stored = { workbot: { model: "kept", proactive: { enabled: true, leadMinutes: 7, dailyCap: 5, startHour: 20, endHour: 9 } } }
    const read = readWorkbotProactiveSettings(stored)
    assert.equal(read.enabled, true)
    assert.equal(read.leadMinutes, 15, "7 is not a choice")
    assert.equal(read.dailyCap, 5)
    assert.deepEqual([read.startHour, read.endHour], [8, 19])
    assert.equal(mergeWorkbotProactiveSettings(read, { startHour: 18, endHour: 9 }), null)
    const saved = withWorkbotProactiveSettings(stored, { ...read, morningBrief: true })
    assert.deepEqual(saved.workbot, { model: "kept", proactive: { ...read, morningBrief: true } })
  })
})
