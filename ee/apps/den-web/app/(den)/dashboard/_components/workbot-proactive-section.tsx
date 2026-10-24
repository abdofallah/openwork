"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useId, useState } from "react";
import {
  WORKBOT_PROACTIVE_DAILY_CAPS,
  WORKBOT_PROACTIVE_LEAD_MINUTES,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenSwitch } from "../../_components/ui/switch";
import { useSaveWorkbotProactive, useWorkbotProactive } from "./workbot-proactive-data";
import { PROACTIVE_PREVIEW_KINDS, WorkbotProactivePreview, type ProactivePreviewKind } from "./workbot-proactive-preview";

/**
 * Manage › Workbot › Proactive: Workbot messages members in Slack on its own, only when something needs their
 * attention. One switch for the organization, which heads-ups are on, when and how often, and a preview.
 */

const SELECT_CLASS = "h-9 text-[13px]";

function hourLabel(hour: number) {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

function leadLabel(minutes: number) {
  return minutes === 60 ? "1 hour before" : `${minutes} min before`;
}

function Row({ label, labelId, note, children, testId }: { label: string; labelId?: string; note?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <div className="px-6 py-3" data-testid={testId}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <span id={labelId} className="text-[13px] font-medium text-gray-900">{label}</span>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
      {note ? (
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-gray-500">
          <Lock size={12} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
          <span>{note}</span>
        </p>
      ) : null}
    </div>
  );
}

export function WorkbotProactivePanel({
  view,
  canManage,
  saving,
  onChange,
  connectorsHref,
  name,
  initialPreview = "meeting_prep",
}: {
  view: WorkbotProactiveView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
  connectorsHref: string;
  name: string;
  initialPreview?: ProactivePreviewKind;
}) {
  const ids = { meetings: useId(), days: useId(), cap: useId(), members: useId() };
  const [preview, setPreview] = useState<ProactivePreviewKind>(initialPreview);
  const { settings, slackReady, runnerReady } = view;
  const locked = !canManage || saving;

  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-panel">
      <Row
        label="Heads-ups in Slack"
        testId="workbot-proactive-enabled"
        note={slackReady ? null : (
          <>
            Needs the Slack app.{" "}
            <Link href={connectorsHref} className="rounded text-gray-700 underline underline-offset-2 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
              Set it up in Connectors
            </Link>
          </>
        )}
      >
        <DenSwitch
          aria-label="Heads-ups in Slack"
          checked={settings.enabled}
          disabled={locked || (!slackReady && !settings.enabled)}
          onChange={(enabled) => onChange({ enabled })}
        />
      </Row>

      <Row
        label="Before meetings that need prep"
        labelId={ids.meetings}
        testId="workbot-proactive-meeting-prep"
        note={runnerReady ? null : "Needs OpenWork's headless runner. Ask your OpenWork operator to set it up."}
      >
        <div className="w-44">
          <DenSelect
            aria-labelledby={ids.meetings}
            className={SELECT_CLASS}
            menuWidth="trigger"
            value={settings.meetingPrep && runnerReady ? String(settings.leadMinutes) : "off"}
            disabled={locked || !runnerReady}
            onChange={(event) => {
              const minutes = WORKBOT_PROACTIVE_LEAD_MINUTES.find((value) => String(value) === event.target.value);
              onChange(minutes ? { meetingPrep: true, leadMinutes: minutes } : { meetingPrep: false });
            }}
          >
            <option value="off">Off</option>
            {WORKBOT_PROACTIVE_LEAD_MINUTES.map((minutes) => (
              <option key={minutes} value={String(minutes)}>{leadLabel(minutes)}</option>
            ))}
          </DenSelect>
        </div>
      </Row>

      <Row label="Calendar changes" testId="workbot-proactive-calendar-changes">
        <DenSwitch aria-label="Calendar changes" checked={settings.calendarChanges} disabled={locked} onChange={(calendarChanges) => onChange({ calendarChanges })} />
      </Row>

      <Row label="Morning brief" testId="workbot-proactive-morning-brief">
        <DenSwitch aria-label="Morning brief" checked={settings.morningBrief} disabled={locked} onChange={(morningBrief) => onChange({ morningBrief })} />
      </Row>

      <Row label="Working hours" labelId={ids.days} testId="workbot-proactive-hours">
        <div className="w-32">
          <DenSelect aria-label="Working days" className={SELECT_CLASS} menuWidth="trigger" value={settings.workingDays} disabled={locked}
            onChange={(event) => onChange({ workingDays: event.target.value === "everyday" ? "everyday" : "weekdays" })}>
            <option value="weekdays">Weekdays</option>
            <option value="everyday">Every day</option>
          </DenSelect>
        </div>
        <div className="w-24">
          <DenSelect aria-label="Start of the workday" className={SELECT_CLASS} menuWidth="trigger" value={String(settings.startHour)} disabled={locked}
            onChange={(event) => onChange({ startHour: Number(event.target.value) })}>
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={String(hour)} disabled={hour >= settings.endHour}>{hourLabel(hour)}</option>
            ))}
          </DenSelect>
        </div>
        <span className="text-[13px] text-gray-500">to</span>
        <div className="w-24">
          <DenSelect aria-label="End of the workday" className={SELECT_CLASS} menuWidth="trigger" value={String(settings.endHour)} disabled={locked}
            onChange={(event) => onChange({ endHour: Number(event.target.value) })}>
            {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => (
              <option key={hour} value={String(hour)} disabled={hour <= settings.startHour}>{hourLabel(hour)}</option>
            ))}
          </DenSelect>
        </div>
      </Row>

      <Row label="Daily limit" labelId={ids.cap} testId="workbot-proactive-cap">
        <div className="w-36">
          <DenSelect aria-labelledby={ids.cap} className={SELECT_CLASS} menuWidth="trigger" value={String(settings.dailyCap)} disabled={locked}
            onChange={(event) => {
              const cap = WORKBOT_PROACTIVE_DAILY_CAPS.find((value) => String(value) === event.target.value);
              if (cap) onChange({ dailyCap: cap });
            }}>
            {WORKBOT_PROACTIVE_DAILY_CAPS.map((cap) => (
              <option key={cap} value={String(cap)}>{`${cap} per person`}</option>
            ))}
          </DenSelect>
        </div>
      </Row>

      <Row label="Members start" labelId={ids.members} testId="workbot-proactive-members">
        <div className="w-36">
          <DenSelect aria-labelledby={ids.members} className={SELECT_CLASS} menuWidth="trigger" value={settings.membersStart} disabled={locked}
            onChange={(event) => onChange({ membersStart: event.target.value === "opted_out" ? "opted_out" : "opted_in" })}>
            <option value="opted_in">Opted in</option>
            <option value="opted_out">Must opt in</option>
          </DenSelect>
        </div>
      </Row>

      <div className="grid gap-3 px-6 py-4" data-testid="workbot-proactive-preview-row">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[13px] font-medium text-gray-900">
            <img src="/integrations/slack.svg" alt="" className="h-4 w-4" />
            Preview
          </span>
          <DenSegmented aria-label="Preview message" options={PROACTIVE_PREVIEW_KINDS} value={preview} onChange={setPreview}
            optionTestId={(kind) => `workbot-proactive-preview-${kind}`} />
        </div>
        <WorkbotProactivePreview kind={preview} settings={settings} name={name} />
      </div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-skeleton">
      {["w-36", "w-48", "w-28", "w-28", "w-32", "w-24", "w-28"].map((width, index) => (
        <div key={index} className="flex min-h-[61px] items-center justify-between gap-3 px-6 py-3">
          <DenSkeleton className={`h-4 ${width}`} />
          <DenSkeleton className="h-9 w-36" />
        </div>
      ))}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function WorkbotProactiveSection({ orgId, canManage, connectorsHref, name }: { orgId: string; canManage: boolean; connectorsHref: string; name: string }) {
  const query = useWorkbotProactive(orgId, Boolean(orgId));
  const save = useSaveWorkbotProactive(orgId);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-section="workbot-proactive">
      <h2 id={headingId} className="px-1 text-[13px] font-medium text-gray-500">Proactive</h2>
      {query.isError ? (
        <DenNotice
          tone="error"
          message={errorMessage(query.error, "Couldn't load heads-up settings.")}
          action={(
            <DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
              Try again
            </DenButton>
          )}
        />
      ) : query.data ? (
        <WorkbotProactivePanel
          view={query.data}
          canManage={canManage}
          saving={save.isPending}
          connectorsHref={connectorsHref}
          name={name}
          onChange={(change) => save.mutate(change)}
        />
      ) : (
        <PanelSkeleton />
      )}
      {save.isError ? (
        <p role="alert" className="px-1 text-[13px] text-red-700">{errorMessage(save.error, "Couldn't save. Try again.")}</p>
      ) : null}
    </section>
  );
}
