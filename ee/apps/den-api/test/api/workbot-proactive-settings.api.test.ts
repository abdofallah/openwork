import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { DEFAULT_WORKBOT_PROACTIVE_SETTINGS } from "@openwork/types/den/workbot-proactive"
import { bootDen, field, summary } from "./harness.js"

// Heads-up settings: behind workbotProactive and Workbot on the deployment; read with View/Manage OpenWork Models,
// changed only with Manage. No runner, Slack or Google is contacted.
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:3020" } })
after(() => den.close())
const path = "/v1/org/workbot-settings/proactive"

test("off until the feature is on and Workbot is deployed; then defaults, saved per field, model kept", async () => {
  const workspace = await den.createOrg(await den.signUp("Proactive Owner"), "Proactive workspace")
  const owner = den.as(workspace.owner, workspace.orgId)

  const hidden = await owner("GET", path)
  assert.equal(hidden.status, 404, summary(hidden))
  assert.equal(field(hidden.body, "feature"), "workbotProactive")
  assert.equal((await den.setFeature(workspace.orgId, "workbotProactive", true)).status, 200)

  const previous = process.env.DEN_WORKBOT_URL
  delete process.env.DEN_WORKBOT_URL
  try {
    const withoutWorkbot = await owner("GET", path)
    assert.equal(withoutWorkbot.status, 404, summary(withoutWorkbot))
    assert.equal(field(withoutWorkbot.body, "feature"), "workbot")
  } finally {
    process.env.DEN_WORKBOT_URL = previous
  }

  const first = await owner("GET", path)
  assert.equal(first.status, 200, summary(first))
  assert.deepEqual(field(first.body, "settings"), DEFAULT_WORKBOT_PROACTIVE_SETTINGS)
  assert.equal(field(first.body, "slackReady"), false, "no Slack assistant is installed")
  assert.equal(field(first.body, "runnerReady"), false, "no headless runner is configured")

  const { db } = await import("../../src/db.js")
  await db.update(OrganizationTable).set({ metadata: { workbot: { model: "openai/gpt-6-luna" } } }).where(eq(OrganizationTable.id, workspace.orgId))

  const saved = await owner("PUT", path, { enabled: true, leadMinutes: 30, morningBrief: true, membersStart: "opted_out" })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "settings"), { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true, leadMinutes: 30, morningBrief: true, membersStart: "opted_out" })
  const [stored] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, workspace.orgId))
  assert.equal(field(stored?.metadata, "workbot", "model"), "openai/gpt-6-luna", "the default model is kept")

  for (const invalid of [{ leadMinutes: 7 }, { dailyCap: 50 }, { workingDays: "weekends" }, { unknown: true }]) {
    const refused = await owner("PUT", path, invalid)
    assert.equal(refused.status, 400, `${JSON.stringify(invalid)}: ${summary(refused)}`)
  }
  const backwards = await owner("PUT", path, { startHour: 18, endHour: 9 })
  assert.equal(backwards.status, 400, summary(backwards))
  assert.equal(field(backwards.body, "error"), "invalid_working_hours")
  assert.equal(field((await owner("GET", path)).body, "settings", "startHour"), 8, "a refused change saves nothing")
})

test("the ledger sends each heads-up at most once and leases keep two instances off one member", async () => {
  const workspace = await den.createOrg(await den.signUp("Ledger Owner"), "Proactive ledger")
  const repository = await import("../../src/workbot-proactive/repository.js")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  const organizationId = normalizeDenTypeId("organization", workspace.orgId)
  const memberId = normalizeDenTypeId("member", workspace.owner.memberId)
  const now = new Date()

  await repository.ensureProactiveMembers(organizationId, [memberId])
  await repository.ensureProactiveMembers(organizationId, [memberId])
  const [claimed, ...rest] = await repository.claimDueProactiveMembers(10, now)
  assert.ok(claimed && claimed.memberId === memberId)
  assert.equal(rest.filter((row) => row.memberId === memberId).length, 0)
  assert.equal((await repository.claimDueProactiveMembers(10, now)).filter((row) => row.memberId === memberId).length, 0, "a leased member is not claimed twice")
  assert.equal(await repository.holdsProactiveLease(claimed), true)

  const first = await repository.reserveProactiveNotification({ organizationId, memberId, kind: "meeting_prep", key: "evt1:1" })
  assert.ok(first)
  assert.equal(await repository.reserveProactiveNotification({ organizationId, memberId, kind: "meeting_prep", key: "evt1:1" }), null, "only one insert wins")
  await repository.finishProactiveNotification(first, "sent", { channelId: "D1", messageTs: "1.1" })
  await repository.reserveProactiveNotification({ organizationId, memberId, kind: "calendar_change", key: "evt2:x", outcome: "quiet" })
  const handled = await repository.handledProactiveKeys(memberId, [
    { kind: "meeting_prep", key: "evt1:1" },
    { kind: "calendar_change", key: "evt2:x" },
    { kind: "calendar_change", key: "evt3:y" },
  ])
  assert.deepEqual([...handled].sort(), ["calendar_change:evt2:x", "meeting_prep:evt1:1"])
  assert.equal(await repository.proactiveSentSince(memberId, new Date(now.getTime() - 60_000)), 1, "only sent messages count toward the cap")

  assert.equal(await repository.settleProactiveMember(claimed, { nextCheckAt: new Date(now.getTime() + 300_000), checkpoint: "{}", timeZone: "UTC" }), true)
  assert.equal(await repository.settleProactiveMember(claimed, { nextCheckAt: now }), false, "a released lease cannot settle again")
  await repository.saveProactivePreferences(organizationId, memberId, { optedIn: true }, now)
  const after = await repository.readProactiveMember(memberId)
  assert.equal(after?.optedIn, true)
  assert.equal(after?.checkpoint, "{}", "the checkpoint is stored (encrypted at rest) and read back")
  assert.equal(after?.nextCheckAt.getTime(), now.getTime(), "turning on makes the member due now")
})

test("members without Manage OpenWork Models can't change heads-ups; without either permission they can't read them", async () => {
  const workspace = await den.createOrg(await den.signUp("Proactive Admin"), "Proactive permissions")
  assert.equal((await den.setFeature(workspace.orgId, "workbotProactive", true)).status, 200)
  const member = await den.newMember(workspace.owner, workspace.orgId, "Plain member")
  const call = den.as(member, workspace.orgId)
  assert.equal((await call("GET", path)).status, 403)
  assert.equal((await call("PUT", path, { enabled: true })).status, 403)

  const owner = den.as(workspace.owner, workspace.orgId)
  const viewer = await den.newMember(workspace.owner, workspace.orgId, "Viewer")
  const teamId = await den.createTeam(workspace.owner, workspace.orgId, "Viewers", [viewer.memberId])
  assert.equal((await owner("POST", "/v1/permissions/sets", { teamId, permissions: [{ key: "inference.view", status: "allow" }] })).status, 201)
  const view = den.as(viewer, workspace.orgId)
  assert.equal((await view("GET", path)).status, 200)
  assert.equal((await view("PUT", path, { enabled: true })).status, 403)
  assert.equal(field((await owner("GET", path)).body, "settings", "enabled"), false)
})
