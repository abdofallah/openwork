import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { createDenClient, readDenSettings } from "@/app/lib/den";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature";
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations";
import {
  applyLocalFeatureOverride,
  LOCAL_FEATURE_CHANGE_EVENT,
  readLocalFeatureOverride,
  writeLocalFeatureOverride,
  type LocalFeatureKey,
  type LocalFeatureOverride,
} from "@/app/lib/local-feature-overrides";

/**
 * Subscribes to local feature-override changes. `useSyncExternalStore` keeps
 * every reader (the composer buttons, the Features tab) in step the moment a
 * switch is flipped, without a reload or prop drilling.
 */
function useLocalFeatureRevision(): number {
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (typeof window === "undefined") return () => {};
    window.addEventListener(LOCAL_FEATURE_CHANGE_EVENT, onStoreChange);
    // Cross-tab edits (two windows of the same build) arrive as storage events.
    window.addEventListener("storage", onStoreChange);
    return () => {
      window.removeEventListener(LOCAL_FEATURE_CHANGE_EVENT, onStoreChange);
      window.removeEventListener("storage", onStoreChange);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => localFeatureRevision(),
    () => 0,
  );
}

/**
 * A change counter derived from the stored values. It only needs to change
 * identity when something actually changed, so readers re-run.
 */
let cachedRevision = 0;
const revisionSources = new Map<string, string>();

function localFeatureRevision(): number {
  if (typeof window === "undefined" || !window.localStorage) return cachedRevision;
  const next = new Map<string, string>();
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith("openwork.features.local.")) continue;
      next.set(key, window.localStorage.getItem(key) ?? "");
    }
  } catch {
    return cachedRevision;
  }
  if (next.size !== revisionSources.size) {
    revisionSources.clear();
    for (const [key, value] of next) revisionSources.set(key, value);
    cachedRevision += 1;
    return cachedRevision;
  }
  for (const [key, value] of next) {
    if (revisionSources.get(key) !== value) {
      revisionSources.set(key, value);
      cachedRevision += 1;
      return cachedRevision;
    }
  }
  return cachedRevision;
}

/** Layered feature value: the local choice wins, otherwise the Den value. */
export function useResolvedFeature(key: LocalFeatureKey, denValue: boolean): boolean {
  useLocalFeatureRevision();
  return applyLocalFeatureOverride(key, denValue);
}

/**
 * The Features tab control for one key: the local choice, the effective value
 * (local over Den), and a way to set or clear the local choice. `denValue` is
 * what Den resolved, so the row can say honestly when nothing is overridden.
 */
export function useLocalFeatureSetting(key: LocalFeatureKey, denValue: boolean): {
  override: LocalFeatureOverride;
  effective: boolean;
  setOverride: (value: LocalFeatureOverride) => void;
} {
  const { override, setOverride } = useLocalFeatureOverride(key);
  return {
    override,
    effective: applyLocalFeatureOverride(key, denValue),
    setOverride,
  };
}

/**
 * The Den-resolved value for any feature key, for the Features tab. Uses the
 * same TanStack query key as the feature hooks, so it shares their cache and
 * never adds a request. Unknown keys, a signed-out install with no deployment
 * value, or an unreachable Den all read as off.
 */
export function useDenFeatureValue(key: LocalFeatureKey): boolean {
  const denAuth = useDenAuth();
  const context = useAutomationsDenContext();
  const baseUrl = readDenSettings().baseUrl;
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl]);
  const organization = useOrgFeature(key);
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => deploymentClient.getDeploymentFeatures(),
    enabled: !context.ready && denAuth.status === "signed_out",
    staleTime: 30_000,
    retry: false,
    select: (features) => features[key] === true,
  });
  if (context.ready) return organization;
  return denAuth.status === "signed_out" && !deployment.isError && deployment.data === true;
}

/** Reads and writes one local override for the Features tab. */
export function useLocalFeatureOverride(key: LocalFeatureKey): {
  override: LocalFeatureOverride;
  setOverride: (value: LocalFeatureOverride) => void;
} {
  useLocalFeatureRevision();
  const override = readLocalFeatureOverride(key);
  const setOverride = useCallback(
    (value: LocalFeatureOverride) => {
      writeLocalFeatureOverride(key, value);
    },
    [key],
  );
  return { override, setOverride };
}
