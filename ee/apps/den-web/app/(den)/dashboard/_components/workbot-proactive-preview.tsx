import type { WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive";

/**
 * A sample heads-up as members see it in Slack, in the same words Den sends (den-api workbot-proactive/messages.ts).
 * Fictional meeting and company; updates with the lead time. Not interactive.
 */

export type ProactivePreviewKind = "meeting_prep" | "calendar_change" | "morning_brief";

export const PROACTIVE_PREVIEW_KINDS: { value: ProactivePreviewKind; label: string }[] = [
  { value: "meeting_prep", label: "Before a meeting" },
  { value: "calendar_change", label: "Calendar change" },
  { value: "morning_brief", label: "Morning brief" },
];

const MUTE_LABEL: Record<ProactivePreviewKind, string> = {
  meeting_prep: "Mute meeting prep",
  calendar_change: "Mute calendar changes",
  morning_brief: "Mute morning brief",
};

function Linked({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-sky-700">{children}</span>;
}

function Body({ kind, leadMinutes }: { kind: ProactivePreviewKind; leadMinutes: number }) {
  if (kind === "calendar_change") {
    return (
      <p>
        <Linked>Design review</Linked> moved to tomorrow at 3:00 PM (was 11:00 AM)
      </p>
    );
  }
  if (kind === "morning_brief") {
    return (
      <div className="grid gap-0.5">
        <p><span className="font-semibold">Your day:</span> 3 meetings, first at 9:30 AM</p>
        <p>• 9:30 AM <span className="text-sky-700">Team standup</span></p>
        <p>• 11:00 AM <span className="text-sky-700">Quarterly review</span> (needs prep)</p>
        <p>• 2:00 PM <span className="text-sky-700">Design review</span> (overlaps Hiring sync)</p>
      </div>
    );
  }
  const startsIn = leadMinutes >= 60 ? "in 1 hr" : `in ${leadMinutes} min`;
  return (
    <div className="grid gap-1">
      <p><Linked>Quarterly review</Linked> {startsIn}</p>
      <p className="text-[12px] text-gray-500">With 2 people from northwind.example and 1 other</p>
      <div className="grid gap-0.5">
        <p>They asked about renewal pricing last week and are waiting on the updated proposal.</p>
        <p>Last email: <span className="text-sky-700">Renewal questions</span> (Tuesday)</p>
        <p>• Send the updated proposal</p>
        <p className="text-sky-700">Agenda</p>
      </div>
    </div>
  );
}

/** When the sample arrives: a meeting at 2:00 PM minus the lead time, a change mid-morning, the brief at 8:02 AM. */
export function previewTime(kind: ProactivePreviewKind, leadMinutes: number) {
  if (kind === "calendar_change") return "10:12 AM";
  if (kind === "morning_brief") return "8:02 AM";
  const minutes = 14 * 60 - leadMinutes;
  const hour = Math.floor(minutes / 60);
  return `${hour > 12 ? hour - 12 : hour}:${String(minutes % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

const WHY: Record<ProactivePreviewKind, string> = {
  meeting_prep: "Because you have Quarterly review at 2:00 PM.",
  calendar_change: "Because someone else changed a meeting you have today or tomorrow.",
  morning_brief: "Because it's the start of your workday.",
};

export function WorkbotProactivePreview({
  kind,
  settings,
  name,
}: {
  kind: ProactivePreviewKind;
  settings: Pick<WorkbotProactiveSettings, "leadMinutes">;
  name: string;
}) {
  return (
    <div className="flex gap-3 rounded-xl bg-gray-50 px-4 py-3 text-[13px] leading-5 text-gray-900" data-testid="workbot-proactive-preview" data-kind={kind}>
      <img src="/openwork-mark.svg" alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-lg border border-gray-200 bg-white p-1.5" />
      <div className="grid min-w-0 gap-1.5">
        <p className="flex items-baseline gap-2">
          <span className="font-semibold">{name}</span>
          <span className="text-[12px] text-gray-500">{previewTime(kind, settings.leadMinutes)}</span>
        </p>
        <Body kind={kind} leadMinutes={settings.leadMinutes} />
        <p className="text-[12px] text-gray-500">{WHY[kind]}</p>
        <div className="flex flex-wrap gap-1.5 pt-0.5" aria-hidden="true">
          {[MUTE_LABEL[kind], "Snooze until tomorrow", "Turn off"].map((label) => (
            <span key={label} className="inline-flex h-7 items-center rounded-md border border-gray-200 bg-white px-2.5 text-[12px] font-medium text-gray-700">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
