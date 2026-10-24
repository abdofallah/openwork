"use client";

import {
  workbotProactiveViewSchema,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const proactivePath = "/v1/org/workbot-settings/proactive";

export function workbotProactiveQueryKey(orgId: string): string[] {
  return ["org-workbot-proactive", orgId];
}

/** Manage › Workbot › Proactive: the organization's heads-up settings and what they depend on. */
export function useWorkbotProactive(orgId: string, enabled = true) {
  return useQuery({
    queryKey: workbotProactiveQueryKey(orgId),
    enabled,
    retry: false,
    queryFn: async ({ signal }): Promise<WorkbotProactiveView> => {
      const { response, payload } = await requestJson(
        proactivePath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load heads-up settings (${response.status}).`));
      const parsed = workbotProactiveViewSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Heads-up settings returned an unexpected response.");
      return parsed.data;
    },
  });
}

/** Saves one change at a time. The page shows it at once and puts it back if the save fails. */
export function useSaveWorkbotProactive(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  const key = workbotProactiveQueryKey(orgId);

  return useMutation({
    mutationKey: [...key, "save"],
    retry: false,
    mutationFn: async (change: WorkbotProactiveSettingsInput): Promise<WorkbotProactiveView | null> => {
      const result: { saved: WorkbotProactiveView | null } = { saved: null };
      await runReauthableAction("save-workbot-proactive", async () => {
        const { response, payload } = await requestJson(
          proactivePath,
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(change) },
          15000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save heads-up settings (${response.status}).`);
        const parsed = workbotProactiveViewSchema.safeParse(payload);
        result.saved = parsed.success ? parsed.data : null;
      });
      return result.saved;
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<WorkbotProactiveView>(key);
      if (previous) queryClient.setQueryData<WorkbotProactiveView>(key, { ...previous, settings: { ...previous.settings, ...change } });
      return { previous };
    },
    onError: (_error, _change, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData(key, saved);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
