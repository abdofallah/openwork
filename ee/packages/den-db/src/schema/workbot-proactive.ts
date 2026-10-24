import { boolean, index, int, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedMediumTextColumn } from "../columns"

/**
 * Workbot's proactive heads-ups, one row per member Den checks. Holds the member's own choices (opt-in, muted kinds,
 * snooze) and what the last check saw, so a check never repeats itself. Leases let several Den instances share the
 * work without checking one member twice.
 */
export const WorkbotProactiveMemberTable = mysqlTable(
  "workbot_proactive_member",
  {
    memberId: denTypeIdColumn("member", "member_id").primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** Null follows the organization's default; true or false is the member's own choice. */
    optedIn: boolean("opted_in"),
    /** Kinds the member muted (`meeting_prep`, `calendar_change`, `morning_brief`). */
    mutedKinds: compatJsonColumn<string[]>("muted_kinds"),
    snoozedUntil: timestamp("snoozed_until", { fsp: 3 }),
    /** The last check's view of the calendar (event ids, times, titles). Member content, so encrypted. */
    checkpoint: encryptedMediumTextColumn("checkpoint"),
    /** The member's calendar time zone, from their last check. */
    timeZone: varchar("time_zone", { length: 64 }),
    lastCheckedAt: timestamp("last_checked_at", { fsp: 3 }),
    nextCheckAt: timestamp("next_check_at", { fsp: 3 }).notNull().defaultNow(),
    failures: int("failures").notNull().default(0),
    leaseOwner: varchar("lease_owner", { length: 64 }),
    leaseUntil: timestamp("lease_until", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("workbot_proactive_member_due").on(t.nextCheckAt),
    index("workbot_proactive_member_org").on(t.organizationId),
  ],
)

/**
 * One row per thing a member was (or was deliberately not) told: the ledger that makes every heads-up at most once.
 * The id is a hash of member, kind and dedupe key (event id plus its updated time), reserved before sending.
 * No content: the Slack message is kept by reference so a pressed button can update it.
 */
export const WorkbotProactiveNotificationTable = mysqlTable(
  "workbot_proactive_notification",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    memberId: denTypeIdColumn("member", "member_id").notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    /** `pending` until delivered; then `sent`, `quiet` (nothing worth saying), `capped`, `folded` or `failed`. */
    outcome: varchar("outcome", { length: 16 }).notNull().default("pending"),
    channelId: varchar("channel_id", { length: 64 }),
    messageTs: varchar("message_ts", { length: 64 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [index("workbot_proactive_notification_member").on(t.memberId, t.createdAt)],
)
