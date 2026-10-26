import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FileText } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { hasComposerMemory, type ComposerMemoryOverview } from "./composer-memory";
import { formatTokens } from "./context-usage";

export type ComposerMemorySource = {
  /** Identifies the workspace, so switching workspaces reloads the list. */
  queryKey: readonly unknown[];
  load: () => Promise<ComposerMemoryOverview>;
};

/** One row: the index the prompt carries, or a topic file the model can read on demand. */
function MemoryRow(props: {
  label: string;
  description?: string;
  tokens: number;
  state: string;
  inContext: boolean;
}) {
  return (
    <li
      className={`flex h-8 items-center gap-2 rounded-md px-2 text-sm ${props.inContext ? "text-foreground" : "text-muted-foreground"}`}
    >
      <FileText className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={props.description || props.label}>{props.label}</span>
      <span className="shrink-0 text-xs text-gray-9">{props.state}</span>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">≈{formatTokens(props.tokens)}</span>
    </li>
  );
}

/**
 * Memory indicator of the composer: which memory files this workspace has, and
 * which of them the prompt actually carries. A quiet pill beside the context
 * indicator (DESIGN.md T5); the list opens upwards on demand (P3). Nothing to
 * inspect, nothing shown, so a workspace that never used memory stays unchanged.
 *
 * The "in the prompt" rows add up to the same tokens the context breakdown's
 * "Memory" row counts, so the two views agree: the guidance and the `MEMORY.md`
 * index are in context and cost tokens; the topic files are read on demand and
 * cost nothing until the model asks for them.
 */
export function ComposerMemoryControl(props: { source: ComposerMemorySource }) {
  const query = useQuery({
    queryKey: props.source.queryKey,
    queryFn: props.source.load,
    staleTime: 0,
    retry: false,
  });
  const memory = query.data;
  if (!memory || !hasComposerMemory(memory)) return null;

  const summary = t("composer.memory_files", { count: memory.files.length });
  const indexState = memory.entrypoint.present
    ? t("composer.memory_index_loaded")
    : t("composer.memory_index_empty");
  // The rest of the injected segment: the prompt that explains how to use memory.
  // Reported so the in-prompt rows here sum to the breakdown's "Memory" row.
  const guidanceTokens = Math.max(0, memory.instructionsTokens - memory.entrypointTokens);

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        data-testid="composer-memory-trigger"
        aria-label={t("composer.memory_label_named", { summary })}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 px-1.5 text-sm text-muted-foreground @min-[480px]/composer:px-2.5 hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FileText className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          <span className="hidden @min-[480px]/composer:inline">{t("composer.context_row_memory")}</span>
          <span className="@min-[480px]/composer:hidden">{memory.files.length}</span>
        </span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        data-testid="composer-memory-list"
        className="max-h-[min(var(--available-height),20rem)] w-80 max-w-[calc(100vw-2rem)] gap-1 rounded-2xl p-1"
      >
        <p className="px-2 py-1 text-xs text-muted-foreground">{summary}</p>
        <ul className="flex flex-col">
          {guidanceTokens > 0 ? (
            <MemoryRow
              label={t("composer.memory_guidance")}
              tokens={guidanceTokens}
              state={t("composer.memory_index_loaded")}
              inContext
            />
          ) : null}
          <MemoryRow
            label={memory.entrypoint.name}
            tokens={memory.entrypointTokens}
            state={memory.entrypoint.truncated ? `${indexState} · ${t("composer.memory_index_truncated")}` : indexState}
            inContext={memory.entrypoint.loaded}
          />
          {memory.files.map((file) => (
            <MemoryRow
              key={file.filename}
              label={file.filename}
              description={file.description || undefined}
              tokens={file.tokens}
              state={t("composer.memory_file_on_demand")}
              inContext={false}
            />
          ))}
        </ul>
        <p className="px-2 py-1 text-xs text-muted-foreground">{t("composer.memory_footer")}</p>
      </PopoverContent>
    </Popover>
  );
}
