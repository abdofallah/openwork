import { createHash, randomUUID } from "node:crypto"
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, or } from "@openwork-ee/den-db/drizzle"
import {
  WorkbotProactiveMemberTable as Member,
  WorkbotProactiveNotificationTable as Notification,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { proactiveLedgerKey, type ProactiveKind } from "@openwork/automations/proactive"
import { db } from "../db.js"
import { automationAffectedRows, automationUpdateChangedRows } from "../automations/update-result.js"
import type { ProactivePreferenceChange } from "./policy.js"

/**
 * The only module that reads or writes Workbot's proactive tables: each member's state (choices, checkpoint,
 * lease) and the notification ledger that makes every heads-up at most once.
 */

export type ProactiveMemberRow = typeof Member.$inferSelect
export type NotificationOutcome = "pending" | "sent" | "quiet" | "capped" | "folded" | "failed"

const LEASE_MS = 10 * 60_000

export async function readProactiveMember(memberId: DenTypeId<"member">): Promise<ProactiveMemberRow | null> {
  return (await db.select().from(Member).where(eq(Member.memberId, memberId)).limit(1))[0] ?? null
}

/**
 * Starts checking these members (new rows are due now); existing rows are left alone. Times are always written from
 * here, never left to the database's `now()`, so the cap and leases never depend on the server's time zone.
 */
export async function ensureProactiveMembers(organizationId: DenTypeId<"organization">, memberIds: readonly DenTypeId<"member">[], now = new Date()) {
  if (!memberIds.length) return
  await db.insert(Member).ignore().values(memberIds.map((memberId) => ({ memberId, organizationId, nextCheckAt: now, createdAt: now, updatedAt: now })))
}

/** Saves a member's own choice. Turning on or resuming makes them due now, so the next tick checks at once. */
export async function saveProactivePreferences(
  organizationId: DenTypeId<"organization">,
  memberId: DenTypeId<"member">,
  change: ProactivePreferenceChange,
  now = new Date(),
) {
  const wake = change.optedIn === true || change.snoozedUntil === null
  const set = {
    ...(change.optedIn !== undefined ? { optedIn: change.optedIn } : {}),
    ...(change.mutedKinds !== undefined ? { mutedKinds: change.mutedKinds } : {}),
    ...(change.snoozedUntil !== undefined ? { snoozedUntil: change.snoozedUntil } : {}),
    ...(wake ? { nextCheckAt: now } : {}),
    updatedAt: now,
  }
  await db
    .insert(Member)
    .values({ memberId, organizationId, nextCheckAt: now, createdAt: now, ...set })
    .onDuplicateKeyUpdate({ set })
}

/** Claims up to `limit` due members for this instance. */
export async function claimDueProactiveMembers(limit: number, now: Date): Promise<ProactiveMemberRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(Member)
      .where(and(lte(Member.nextCheckAt, now), or(isNull(Member.leaseUntil), lte(Member.leaseUntil, now))))
      .orderBy(asc(Member.nextCheckAt))
      .limit(limit)
      .for("update", { skipLocked: true })
    if (!rows.length) return []
    const leaseOwner = randomUUID()
    const leaseUntil = new Date(now.getTime() + LEASE_MS)
    await tx.update(Member).set({ leaseOwner, leaseUntil }).where(inArray(Member.memberId, rows.map((row) => row.memberId)))
    return rows.map((row) => ({ ...row, leaseOwner, leaseUntil }))
  })
}

export type ProactiveSettle = Partial<Pick<ProactiveMemberRow, "checkpoint" | "timeZone" | "lastCheckedAt" | "failures">> & {
  nextCheckAt: Date
}

/** Releases a claimed member; false when another instance took the lease meanwhile. */
export async function settleProactiveMember(row: ProactiveMemberRow, changes: ProactiveSettle, now = new Date()) {
  const result = await db
    .update(Member)
    .set({ ...changes, leaseOwner: null, leaseUntil: null, updatedAt: now })
    .where(and(eq(Member.memberId, row.memberId), eq(Member.leaseOwner, row.leaseOwner ?? "")))
  return automationUpdateChangedRows(result)
}

/** True while this instance still holds the member's lease: checked right before anything is sent. */
export async function holdsProactiveLease(row: ProactiveMemberRow, now = new Date()) {
  const [current] = await db
    .select({ leaseOwner: Member.leaseOwner, leaseUntil: Member.leaseUntil })
    .from(Member)
    .where(eq(Member.memberId, row.memberId))
    .limit(1)
  return Boolean(current && current.leaseOwner === row.leaseOwner && current.leaseUntil && current.leaseUntil > now)
}

// ---- Ledger --------------------------------------------------------------------------------------------------------

export function notificationId(memberId: string, kind: ProactiveKind, dedupeKey: string) {
  return createHash("sha256").update(`${memberId}\u0000${proactiveLedgerKey(kind, dedupeKey)}`).digest("hex")
}

/** Which of these signals the member was already told about (or deliberately not), as ledger keys. */
export async function handledProactiveKeys(memberId: DenTypeId<"member">, signals: readonly { kind: ProactiveKind; key: string }[]) {
  const ids = new Map(signals.map((signal) => [notificationId(memberId, signal.kind, signal.key), proactiveLedgerKey(signal.kind, signal.key)]))
  if (!ids.size) return new Set<string>()
  const rows = await db.select({ id: Notification.id }).from(Notification).where(inArray(Notification.id, [...ids.keys()]))
  return new Set(rows.flatMap((row) => {
    const key = ids.get(row.id)
    return key ? [key] : []
  }))
}

/** Reserves one ledger row; only the caller whose insert wins may send. */
export async function reserveProactiveNotification(input: {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  kind: ProactiveKind
  key: string
  outcome?: NotificationOutcome
  now?: Date
}) {
  const id = notificationId(input.memberId, input.kind, input.key)
  const result = await db.insert(Notification).ignore().values({
    id,
    organizationId: input.organizationId,
    memberId: input.memberId,
    kind: input.kind,
    outcome: input.outcome ?? "pending",
    createdAt: input.now ?? new Date(),
  })
  return automationAffectedRows(result) > 0 ? id : null
}

export async function finishProactiveNotification(id: string, outcome: NotificationOutcome, message?: { channelId: string; messageTs: string }) {
  await db
    .update(Notification)
    .set({ outcome, ...(message ? { channelId: message.channelId, messageTs: message.messageTs } : {}) })
    .where(eq(Notification.id, id))
}

/** Messages actually sent to the member since `since` (the start of their local day): the daily cap. */
export async function proactiveSentSince(memberId: DenTypeId<"member">, since: Date) {
  const [row] = await db
    .select({ sent: count() })
    .from(Notification)
    .where(and(eq(Notification.memberId, memberId), eq(Notification.outcome, "sent"), gte(Notification.createdAt, since)))
  return row?.sent ?? 0
}

/** Ledger rows only matter while their events can still come up; keep a month. */
export async function pruneProactiveNotifications(before: Date) {
  await db.delete(Notification).where(lt(Notification.createdAt, before))
}
