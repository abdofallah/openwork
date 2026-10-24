import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_WORKBOT_PROACTIVE_SETTINGS, type WorkbotProactiveView } from "@openwork/types/den/workbot-proactive";
import { WorkbotProactivePanel } from "./workbot-proactive-section";
import { previewTime, type ProactivePreviewKind } from "./workbot-proactive-preview";

const ready: WorkbotProactiveView = { settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true }, slackReady: true, runnerReady: true };

function render(view: WorkbotProactiveView = ready, options: { canManage?: boolean; preview?: ProactivePreviewKind } = {}) {
  return renderToStaticMarkup(
    <WorkbotProactivePanel view={view} canManage={options.canManage ?? true} saving={false} onChange={() => undefined}
      connectorsHref="/dashboard/mcp-connections" name="Workbot" initialPreview={options.preview} />,
  );
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function switchFor(html: string, label: string) {
  return new RegExp(`<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? null;
}

test("every setting is one labelled row with its current value, and nothing explains the page", () => {
  const view = text(render());
  for (const label of ["Heads-ups in Slack", "Before meetings that need prep", "Calendar changes", "Morning brief", "Working hours", "Daily limit", "Members start", "Preview"]) {
    assert.ok(view.includes(label), label);
  }
  for (const value of ["15 min before", "Weekdays", "8 AM", "7 PM", "3 per person", "Opted in"]) assert.ok(view.includes(value), value);
  assert.match(switchFor(render(), "Heads-ups in Slack") ?? "", /aria-checked="true"/);
  assert.match(switchFor(render(), "Morning brief") ?? "", /aria-checked="false"/);
  assert.doesNotMatch(view, /Needs/, "no lock when everything is ready");
});

test("the preview speaks like the Slack message and follows the lead time", () => {
  const prep = text(render({ ...ready, settings: { ...ready.settings, leadMinutes: 30 } }));
  assert.match(prep, /Quarterly review in 30 min/);
  assert.match(prep, /Because you have Quarterly review at 2:00 PM\./);
  assert.match(prep, /Mute meeting prep Snooze until tomorrow Turn off/);
  assert.equal(previewTime("meeting_prep", 30), "1:30 PM");
  assert.equal(previewTime("meeting_prep", 60), "1:00 PM");
  assert.match(text(render(ready, { preview: "calendar_change" })), /Design review moved to tomorrow at 3:00 PM \(was 11:00 AM\).*Mute calendar changes/);
  assert.match(text(render(ready, { preview: "morning_brief" })), /Your day: 3 meetings, first at 9:30 AM.*Because it's the start of your workday\./);
});

test("without the Slack app the switch is locked with the reason and where to fix it", () => {
  const html = render({ ...ready, settings: DEFAULT_WORKBOT_PROACTIVE_SETTINGS, slackReady: false });
  assert.match(text(html), /Needs the Slack app\. Set it up in Connectors/);
  assert.match(html, /href="\/dashboard\/mcp-connections"/);
  assert.match(switchFor(html, "Heads-ups in Slack") ?? "", /disabled=""/);
});

test("without the headless runner, meeting prep reads Off and says who can fix it", () => {
  const html = render({ ...ready, runnerReady: false });
  assert.match(text(html), /Before meetings that need prep\s+Off/);
  assert.match(text(html), /Needs OpenWork's headless runner\. Ask your OpenWork operator to set it up\./);
});

test("read-only viewers see every value but can't change any", () => {
  const html = render(ready, { canManage: false });
  for (const label of ["Heads-ups in Slack", "Calendar changes", "Morning brief"]) assert.match(switchFor(html, label) ?? "", /disabled=""/, label);
  assert.ok(text(html).includes("15 min before"));
});
