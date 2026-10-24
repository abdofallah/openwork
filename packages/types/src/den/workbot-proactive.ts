import { z } from "zod"

/**
 * Organization settings for Workbot's proactive heads-ups (Den › Manage › Workbot › Proactive), behind the
 * `workbotProactive` feature. Kept in the organization's metadata under `workbot.proactive`, next to Workbot's
 * default model. Missing fields read as the defaults below, so an organization that never saved anything is off.
 */

export const WORKBOT_PROACTIVE_LEAD_MINUTES = [5, 10, 15, 30, 60] as const
export const WORKBOT_PROACTIVE_DAILY_CAPS = [1, 2, 3, 5, 10] as const

const leadMinutesSchema = z.number().int().refine((value) => WORKBOT_PROACTIVE_LEAD_MINUTES.some((allowed) => allowed === value), {
  message: "Choose 5, 10, 15, 30 or 60 minutes.",
})

const workbotProactiveFieldsSchema = z.object({
  /** Heads-ups in Slack, for the whole organization. */
  enabled: z.boolean(),
  /** Before meetings with people from outside the company or an agenda doc. */
  meetingPrep: z.boolean(),
  leadMinutes: leadMinutesSchema,
  /** Meetings today or tomorrow that someone else added, moved or cancelled. */
  calendarChanges: z.boolean(),
  /** Today's meetings, overlaps and what needs prep, at the start of the workday. */
  morningBrief: z.boolean(),
  workingDays: z.enum(["weekdays", "everyday"]),
  /** Whole hours in each member's calendar time zone; the day runs from startHour to endHour. */
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  /** Messages per member per day. */
  dailyCap: z.number().int().min(1).max(10),
  /** `opted_in`: members get heads-ups and can turn them off. `opted_out`: members turn them on in Slack. */
  membersStart: z.enum(["opted_in", "opted_out"]),
})

const hoursInOrder = (value: { startHour: number; endHour: number }) => value.endHour > value.startHour
const hoursMessage = { message: "The workday must end after it starts.", path: ["endHour"] }

export const workbotProactiveSettingsSchema = workbotProactiveFieldsSchema.refine(hoursInOrder, hoursMessage)
export type WorkbotProactiveSettings = z.infer<typeof workbotProactiveSettingsSchema>

export const DEFAULT_WORKBOT_PROACTIVE_SETTINGS: WorkbotProactiveSettings = {
  enabled: false,
  meetingPrep: true,
  leadMinutes: 15,
  calendarChanges: true,
  morningBrief: false,
  workingDays: "weekdays",
  startHour: 8,
  endHour: 19,
  dailyCap: 3,
  membersStart: "opted_in",
}

/** `PUT /v1/org/workbot-settings/proactive`: any subset of fields; the result must still be valid. */
export const workbotProactiveSettingsInputSchema = workbotProactiveFieldsSchema.partial().strict()
export type WorkbotProactiveSettingsInput = z.infer<typeof workbotProactiveSettingsInputSchema>

/** What the admin page shows: the settings and what each one depends on. */
export const workbotProactiveViewSchema = z.object({
  settings: workbotProactiveSettingsSchema,
  /** The Slack assistant is installed and on, so heads-ups have somewhere to go. */
  slackReady: z.boolean(),
  /** The deployment's headless runner is configured; meeting prep needs it. */
  runnerReady: z.boolean(),
})
export type WorkbotProactiveView = z.infer<typeof workbotProactiveViewSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (isRecord(metadata)) return metadata
  if (typeof metadata !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The saved settings, field by field: an unreadable field falls back to its default, never the whole set. */
export function readWorkbotProactiveSettings(metadata: unknown): WorkbotProactiveSettings {
  const workbot = metadataRecord(metadata).workbot
  const stored = isRecord(workbot) && isRecord(workbot.proactive) ? workbot.proactive : {}
  const merged: Record<string, unknown> = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS }
  for (const [key, schema] of Object.entries(workbotProactiveFieldsSchema.shape)) {
    if (schema.safeParse(stored[key]).success) merged[key] = stored[key]
  }
  const fields = workbotProactiveFieldsSchema.safeParse(merged)
  if (!fields.success) return { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS }
  if (hoursInOrder(fields.data)) return fields.data
  const { startHour, endHour } = DEFAULT_WORKBOT_PROACTIVE_SETTINGS
  return { ...fields.data, startHour, endHour }
}

/** Applies a change; null when the result is invalid (for example a workday that ends before it starts). */
export function mergeWorkbotProactiveSettings(current: WorkbotProactiveSettings, change: WorkbotProactiveSettingsInput): WorkbotProactiveSettings | null {
  const parsed = workbotProactiveSettingsSchema.safeParse({ ...current, ...change })
  return parsed.success ? parsed.data : null
}

/** Metadata with the settings saved; everything else, including `workbot.model`, is kept. */
export function withWorkbotProactiveSettings(metadata: Record<string, unknown>, settings: WorkbotProactiveSettings): Record<string, unknown> {
  const current = metadata.workbot
  return { ...metadata, workbot: { ...(isRecord(current) ? current : {}), proactive: settings } }
}
