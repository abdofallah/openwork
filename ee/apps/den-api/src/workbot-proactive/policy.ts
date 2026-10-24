import {
  nextWorkingStart,
  proactiveKindSchema,
  zonedDayStart,
  type ProactiveKind,
  type ProactivePolicy,
} from "@openwork/automations/proactive"
import type { WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import type { ControlAction, HomeState } from "./messages.js"

/**
 * Pure rules shared by the check, the buttons and the Home tab: the organization's settings as a restraint policy,
 * a member's own choices, and what each button changes. No database, Slack or Google.
 */

/** A member's stored choices, as the proactive tables keep them. */
export type ProactiveMemberChoices = {
  optedIn: boolean | null
  mutedKinds: string[] | null
  snoozedUntil: Date | null
}

export type ProactivePreferenceChange = {
  optedIn?: boolean | null
  mutedKinds?: ProactiveKind[]
  snoozedUntil?: Date | null
}

export function proactivePolicy(settings: WorkbotProactiveSettings): ProactivePolicy {
  return { workingDays: settings.workingDays, startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap }
}

export function enabledKinds(settings: WorkbotProactiveSettings): Set<ProactiveKind> {
  const kinds = new Set<ProactiveKind>()
  if (settings.meetingPrep) kinds.add("meeting_prep")
  if (settings.calendarChanges) kinds.add("calendar_change")
  if (settings.morningBrief) kinds.add("morning_brief")
  return kinds
}

export function mutedKindsOf(row: Pick<ProactiveMemberChoices, "mutedKinds"> | null | undefined): Set<ProactiveKind> {
  const muted = new Set<ProactiveKind>()
  for (const value of row?.mutedKinds ?? []) {
    const parsed = proactiveKindSchema.safeParse(value)
    if (parsed.success) muted.add(parsed.data)
  }
  return muted
}

/** The member's own choice wins; without one, the organization's starting choice. */
export function memberOptedIn(row: Pick<ProactiveMemberChoices, "optedIn"> | null | undefined, settings: WorkbotProactiveSettings) {
  return row?.optedIn ?? settings.membersStart === "opted_in"
}

/** What a press changes. Snooze lasts until the next working morning in the member's time zone. */
export function preferenceChange(
  action: ControlAction,
  kind: ProactiveKind,
  row: Pick<ProactiveMemberChoices, "mutedKinds"> | null,
  settings: WorkbotProactiveSettings,
  now: number,
  timeZone: string,
): { change: ProactivePreferenceChange; snoozedUntil: number | null } {
  const muted = mutedKindsOf(row)
  if (action === "mute" || action === "unmute") {
    if (action === "mute") muted.add(kind)
    else muted.delete(kind)
    return { change: { mutedKinds: [...muted] }, snoozedUntil: null }
  }
  if (action === "snooze") {
    const until = nextWorkingStart(proactivePolicy(settings), zonedDayStart(now, timeZone, 1), timeZone)
    return { change: { snoozedUntil: new Date(until) }, snoozedUntil: until }
  }
  if (action === "resume") return { change: { snoozedUntil: null }, snoozedUntil: null }
  if (action === "off") return { change: { optedIn: false }, snoozedUntil: null }
  return { change: { optedIn: true, snoozedUntil: null }, snoozedUntil: null }
}

/** The member's Heads-ups state for the Home tab. */
export function homeStateFor(
  row: (ProactiveMemberChoices & { checkpoint: string | null; failures: number }) | null,
  settings: WorkbotProactiveSettings,
  now: number,
  connectUrl: string,
): HomeState {
  if (!memberOptedIn(row, settings)) return { state: "off" }
  // The last check could not read a calendar and none was ever read: say how to fix it.
  if (row && row.checkpoint === null && row.failures > 0) return { state: "needs_calendar", connectUrl }
  const muted = mutedKindsOf(row)
  const until = row?.snoozedUntil?.getTime() ?? 0
  return until > now ? { state: "snoozed", until, muted } : { state: "on", muted }
}
