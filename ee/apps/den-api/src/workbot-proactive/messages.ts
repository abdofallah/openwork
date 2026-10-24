import {
  calendarWhyLine,
  describeAttendees,
  describeCalendarChange,
  formatClock,
  formatStartsIn,
  formatWhen,
  safeProactiveLink,
  type CalendarChange,
  type CalendarDelivery,
  type MeetingPrepReply,
  type ProactiveKind,
} from "@openwork/automations/proactive"
import type { WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import { slackSafeText } from "../slack-assistant/desktop-handoff-messages.js"

/**
 * What a member sees in Slack: the heads-ups, the buttons under them and the Home tab section. Pure: no Slack calls.
 * Short, scannable and human: no mention of checks, routines or bots. Every message says why it came.
 */

export type SlackBlock = Record<string, unknown>
export type SlackMessage = { text: string; blocks: SlackBlock[] }

export const PROACTIVE_ACTION_PREFIX = "workbot_proactive:"
export const CONTROLS_BLOCK_ID = "workbot_proactive_controls"
export const STATUS_BLOCK_ID = "workbot_proactive_status"

export const KIND_NAME: Record<ProactiveKind, string> = {
  meeting_prep: "meeting prep",
  calendar_change: "calendar changes",
  morning_brief: "morning brief",
}

const MAX_CHANGES = 6
const MAX_BRIEF_MEETINGS = 8

/** Untrusted text, safe inside mrkdwn. */
function safe(text: string) {
  return slackSafeText(text)
}

/** A link with a label; only the person's own Google links are linked, anything else stays plain text. */
function link(url: string | null | undefined, label: string) {
  const href = safeProactiveLink(url)
  const text = safe(label).replaceAll("|", "/")
  return href ? `<${href}|${text}>` : text
}

function mrkdwn(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } }
}

function context(text: string, blockId?: string): SlackBlock {
  return { type: "context", ...(blockId ? { block_id: blockId } : {}), elements: [{ type: "mrkdwn", text }] }
}

function button(text: string, action: string, value: string, style?: "primary"): SlackBlock {
  return {
    type: "button",
    action_id: `${PROACTIVE_ACTION_PREFIX}${action}`,
    text: { type: "plain_text", text },
    value,
    ...(style ? { style } : {}),
  }
}

/** Mute this kind, snooze, turn off: one tap each, under every heads-up. */
export function controlsBlock(kind: ProactiveKind): SlackBlock {
  return {
    type: "actions",
    block_id: CONTROLS_BLOCK_ID,
    elements: [
      button(`Mute ${KIND_NAME[kind]}`, "mute", kind),
      button("Snooze until tomorrow", "snooze", kind),
      button("Turn off", "off", kind),
    ],
  }
}

function finish(blocks: SlackBlock[], delivery: CalendarDelivery, now: number, timeZone: string): SlackBlock[] {
  return [...blocks, context(safe(calendarWhyLine(delivery, now, timeZone))), controlsBlock(delivery.kind)]
}

export function meetingPrepMessage(
  delivery: Extract<CalendarDelivery, { kind: "meeting_prep" }>,
  reply: MeetingPrepReply,
  now: number,
  timeZone: string,
): SlackMessage {
  const event = delivery.event
  const startsIn = event.start !== null ? ` ${formatStartsIn(event.start, now)}` : ""
  const blocks: SlackBlock[] = [mrkdwn(`*${link(event.url, event.title)}*${startsIn}`)]
  const people = describeAttendees(event.others)
  if (people) blocks.push(context(`With ${safe(people)}`))

  const lines = [safe(reply.summary)]
  if (reply.lastThread) {
    const when = reply.lastThread.when ? ` (${safe(reply.lastThread.when)})` : ""
    lines.push(`Last email: ${link(reply.lastThread.url, reply.lastThread.subject)}${when}`)
  }
  for (const item of reply.openItems ?? []) lines.push(`• ${safe(item)}`)
  const links = new Map<string, string>()
  for (const entry of [...(reply.links ?? []), ...event.agendaLinks.map((agenda) => ({ label: agenda.title, url: agenda.url }))]) {
    const href = safeProactiveLink(entry.url)
    if (href && !links.has(href) && links.size < 3) links.set(href, entry.label)
  }
  if (links.size) lines.push([...links].map(([href, label]) => link(href, label)).join("   "))
  blocks.push(mrkdwn(lines.join("\n")))

  return { text: `${event.title}${startsIn}: ${reply.summary}`, blocks: finish(blocks, delivery, now, timeZone) }
}

function changeLine(change: CalendarChange, now: number, timeZone: string) {
  const described = describeCalendarChange(change, now, timeZone)
  return `*${link(change.event.url, described.title)}* ${safe(described.text)}`
}

function changeLines(changes: CalendarChange[], now: number, timeZone: string) {
  const lines = changes.slice(0, MAX_CHANGES).map((change) => `• ${changeLine(change, now, timeZone)}`)
  if (changes.length > MAX_CHANGES) lines.push(`• and ${changes.length - MAX_CHANGES} more`)
  return lines.join("\n")
}

export function calendarChangeMessage(delivery: Extract<CalendarDelivery, { kind: "calendar_change" }>, now: number, timeZone: string): SlackMessage {
  const [only] = delivery.changes
  if (delivery.changes.length === 1 && only) {
    const described = describeCalendarChange(only, now, timeZone)
    return { text: `${described.title} ${described.text}`, blocks: finish([mrkdwn(changeLine(only, now, timeZone))], delivery, now, timeZone) }
  }
  return {
    text: `Your calendar changed: ${delivery.changes.length} meetings`,
    blocks: finish([mrkdwn(`*Your calendar changed*\n${changeLines(delivery.changes, now, timeZone)}`)], delivery, now, timeZone),
  }
}

export function morningBriefMessage(delivery: Extract<CalendarDelivery, { kind: "morning_brief" }>, now: number, timeZone: string): SlackMessage {
  const { meetings, overlaps, needsPrep } = delivery.brief
  const titles = new Map(meetings.map((meeting) => [meeting.id, meeting.title]))
  const overlapWith = new Map<string, string>()
  for (const [a, b] of overlaps) {
    if (!overlapWith.has(a)) overlapWith.set(a, titles.get(b) ?? "another meeting")
    if (!overlapWith.has(b)) overlapWith.set(b, titles.get(a) ?? "another meeting")
  }
  const first = meetings[0]
  const count = meetings.length === 1 ? "1 meeting" : `${meetings.length} meetings`
  const header = `*Your day:* ${count}${first && first.start !== null ? `, first at ${formatClock(first.start, timeZone)}` : ""}`
  const lines = meetings.slice(0, MAX_BRIEF_MEETINGS).map((meeting) => {
    const notes = [
      needsPrep.includes(meeting.id) ? "needs prep" : null,
      overlapWith.has(meeting.id) ? `overlaps ${safe(overlapWith.get(meeting.id) ?? "")}` : null,
    ].filter((note) => note !== null)
    const time = meeting.start !== null ? formatClock(meeting.start, timeZone) : ""
    return `• ${time}  ${link(meeting.url, meeting.title)}${notes.length ? ` (${notes.join(", ")})` : ""}`
  })
  if (meetings.length > MAX_BRIEF_MEETINGS) lines.push(`• and ${meetings.length - MAX_BRIEF_MEETINGS} more`)
  const blocks = [mrkdwn(`${header}\n${lines.join("\n")}`)]
  if (delivery.changes.length) blocks.push(mrkdwn(`*Since yesterday*\n${changeLines(delivery.changes, now, timeZone)}`))
  return { text: `Your day: ${count}`, blocks: finish(blocks, delivery, now, timeZone) }
}

// ---- Buttons ------------------------------------------------------------------------------------------------------

export type ControlAction = "mute" | "unmute" | "snooze" | "resume" | "off" | "on"
const CONTROL_ACTIONS: readonly ControlAction[] = ["mute", "unmute", "snooze", "resume", "off", "on"]
const KINDS: readonly ProactiveKind[] = ["meeting_prep", "calendar_change", "morning_brief"]

export function parseControlAction(actionId: string, value: string | undefined): { action: ControlAction; kind: ProactiveKind } | null {
  if (!actionId.startsWith(PROACTIVE_ACTION_PREFIX)) return null
  const action = CONTROL_ACTIONS.find((entry) => entry === actionId.slice(PROACTIVE_ACTION_PREFIX.length))
  const kind = KINDS.find((entry) => entry === value)
  return action && kind ? { action, kind } : null
}

export function undoOf(action: ControlAction): ControlAction | null {
  if (action === "mute") return "unmute"
  if (action === "snooze") return "resume"
  if (action === "off") return "on"
  return null
}

/** What a pressed button says it did; the button's verb, done ("Mute" → "Muted"). */
export function controlStatus(action: ControlAction, kind: ProactiveKind, snoozedUntil: number | null, now: number, timeZone: string) {
  if (action === "mute") return `Muted ${KIND_NAME[kind]}.`
  if (action === "snooze") return snoozedUntil ? `Snoozed until ${formatWhen(snoozedUntil, now, timeZone)}.` : "Snoozed until tomorrow."
  if (action === "off") return "Turned off heads-ups. You can turn them back on in the Home tab."
  return null
}

/**
 * The message after a button press: the buttons give way to what happened and an Undo; Undo brings the buttons back.
 * Everything else in the message is kept as it was.
 */
export function withControlState(blocks: readonly unknown[], kind: ProactiveKind, state: { status: string; undo: ControlAction } | null): unknown[] {
  const kept = blocks.filter((block) => {
    if (typeof block !== "object" || block === null || !("block_id" in block)) return true
    return block.block_id !== CONTROLS_BLOCK_ID && block.block_id !== STATUS_BLOCK_ID
  })
  if (!state) return [...kept, controlsBlock(kind)]
  return [
    ...kept,
    context(safe(state.status), STATUS_BLOCK_ID),
    { type: "actions", block_id: CONTROLS_BLOCK_ID, elements: [button("Undo", state.undo, kind)] },
  ]
}

// ---- Home tab: "what will you notify me about?" ----------------------------------------------------------------------

function hour(value: number) {
  const h = value % 24
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`
}

export function workingHoursLine(settings: Pick<WorkbotProactiveSettings, "workingDays" | "startHour" | "endHour" | "dailyCap">) {
  const days = settings.workingDays === "weekdays" ? "Weekdays" : "Every day"
  const cap = settings.dailyCap === 1 ? "At most 1 a day" : `At most ${settings.dailyCap} a day`
  return `${days}, ${hour(settings.startHour)} to ${hour(settings.endHour)} in your calendar's time zone. ${cap}.`
}

export type HomeState =
  | { state: "on"; muted: Set<ProactiveKind> }
  | { state: "snoozed"; until: number; muted: Set<ProactiveKind> }
  | { state: "off" }
  | { state: "needs_calendar"; connectUrl: string }

/** The kinds the organization turned on, in the words the member sees. */
export function proactiveKindLines(settings: WorkbotProactiveSettings): { kind: ProactiveKind; text: string }[] {
  const lead = settings.leadMinutes === 60 ? "1 hour" : `${settings.leadMinutes} min`
  const lines: ({ kind: ProactiveKind; text: string } | null)[] = [
    settings.meetingPrep ? { kind: "meeting_prep", text: `${lead} before a meeting with people outside your company, when I find something useful` } : null,
    settings.calendarChanges ? { kind: "calendar_change", text: "When someone adds, moves or cancels a meeting you have today or tomorrow" } : null,
    settings.morningBrief ? { kind: "morning_brief", text: "At the start of your workday, with today's meetings" } : null,
  ]
  return lines.filter((line) => line !== null)
}

export function homeProactiveBlocks(settings: WorkbotProactiveSettings, home: HomeState, now: number, timeZone: string): SlackBlock[] {
  const header: SlackBlock = { type: "header", text: { type: "plain_text", text: "Heads-ups" } }
  if (home.state === "needs_calendar") {
    return [
      { type: "divider" },
      header,
      {
        ...mrkdwn("Connect Google Calendar in OpenWork to get a heads-up before meetings and when your calendar changes."),
        accessory: { type: "button", action_id: `${PROACTIVE_ACTION_PREFIX}connect`, text: { type: "plain_text", text: "Connect Google Calendar" }, url: home.connectUrl },
      },
    ]
  }
  const status = home.state === "on" ? "On" : home.state === "snoozed" ? `Snoozed until ${formatWhen(home.until, now, timeZone)}` : "Off"
  const toggle = home.state === "on" ? button("Turn off", "off", "meeting_prep")
    : home.state === "snoozed" ? button("Resume", "resume", "meeting_prep", "primary")
    : button("Turn on", "on", "meeting_prep", "primary")
  const muted = home.state === "off" ? new Set<ProactiveKind>() : home.muted
  const kinds = proactiveKindLines(settings)
  const lines = kinds.map((line) => `• ${line.text}${muted.has(line.kind) ? " (muted)" : ""}`)
  const blocks: SlackBlock[] = [
    { type: "divider" },
    header,
    { ...mrkdwn(`*${status}.* I message you here only when something needs your attention:\n${lines.join("\n")}`), accessory: toggle },
    context(`${workingHoursLine(settings)} I only read your calendar and email; I never send or change anything for you.`),
  ]
  const unmute = kinds.filter((line) => muted.has(line.kind)).map((line) => button(`Unmute ${KIND_NAME[line.kind]}`, "unmute", line.kind))
  if (unmute.length) blocks.push({ type: "actions", block_id: CONTROLS_BLOCK_ID, elements: unmute })
  return blocks
}
