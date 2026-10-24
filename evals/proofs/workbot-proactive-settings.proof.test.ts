import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotProactiveViewSchema } from "@openwork/types/den/workbot-proactive";
import { workbotProactiveWorld } from "../worlds/workbot-proactive.ts";

const test = spec.world(workbotProactiveWorld, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

test("an owner sets up Workbot heads-ups in Manage › Workbot, and a member without model permissions can't", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
  const settings = async () => workbotProactiveViewSchema.parse((await ownerProbe.api(world.den.admin, "/v1/org/workbot-settings/proactive")).body);

  await step("before: heads-ups are off, and the switch says the Slack app comes first", async () => {
    await owner.see({ role: "switch", label: "Heads-ups in Slack" }, { timeoutMs: 90_000 });
    await owner.see({ text: "Needs the Slack app." });
    await owner.see({ text: "15 min before" });
    const view = await settings();
    expect(view).toMatchObject({ slackReady: false, settings: { enabled: false, meetingPrep: true, leadMinutes: 15, dailyCap: 3, membersStart: "opted_in" } });
    evidence.recordAssertionEvidence(
      "Off by default; the organization switch is locked until the Slack app is installed",
      `enabled=${view.settings.enabled}; slackReady=${view.slackReady}; meeting prep ${view.settings.leadMinutes} min before; ${view.settings.dailyCap} a day; members ${view.settings.membersStart}`,
      !view.settings.enabled && !view.slackReady,
    );
    await owner.screenshot();
  });

  await step("the owner chooses 30 minutes before meetings and turns on the morning brief; the preview follows", async () => {
    await owner.click({ role: "button", label: "Before meetings that need prep" });
    await owner.click({ role: "option", label: "30 min before" });
    await owner.see({ text: "Quarterly review in 30 min" }, { timeoutMs: 30_000 });
    await owner.click({ role: "switch", label: "Morning brief" });
    await owner.click({ role: "radio", label: "Morning brief" });
    await owner.see({ text: "Because it's the start of your workday." });
    await owner.screenshot();
  });

  await step("after: the choices are saved for the whole organization and survive a reload", async () => {
    await owner.reload();
    await owner.see({ text: "30 min before" }, { timeoutMs: 60_000 });
    const view = await settings();
    expect(view.settings).toMatchObject({ enabled: false, meetingPrep: true, leadMinutes: 30, morningBrief: true, calendarChanges: true });
    evidence.recordAssertionEvidence(
      "Saved organization settings",
      `meeting prep ${view.settings.leadMinutes} min before; morning brief ${view.settings.morningBrief ? "on" : "off"}; calendar changes ${view.settings.calendarChanges ? "on" : "off"}; heads-ups still ${view.settings.enabled ? "on" : "off"} without Slack`,
      view.settings.leadMinutes === 30 && view.settings.morningBrief,
    );
    await owner.screenshot();
  });

  await step("a member without OpenWork Models permissions can neither read nor change heads-ups", async () => {
    const member = user.on(world.member), memberProbe = probe.on(world.member);
    await member.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    const read = await memberProbe.api(world.den.members.member, "/v1/org/workbot-settings/proactive");
    expect(read.response.status).toBe(403);
    await member.navigate(`${world.den.ref.webUrl}/dashboard/workbot-settings`);
    await memberProbe.eventually(() => memberProbe.dom('[data-testid="admin-access-state"][data-access-state="locked"], [data-testid="member-dashboard"]'), { within: 60_000, until: (value) => value.elements.length > 0, label: "the member's Workbot settings route is denied" });
    await member.notSee({ role: "switch", label: "Heads-ups in Slack" });
    evidence.recordAssertionEvidence("A plain member is refused", `GET /v1/org/workbot-settings/proactive → ${read.response.status}; no Proactive controls on the page`, read.response.status === 403);
    await member.screenshot();
  });
});
