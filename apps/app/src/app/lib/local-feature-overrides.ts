/**
 * Local feature overrides for the desktop app.
 *
 * OpenWork resolves feature flags from Den (`GET /v1/features` signed out,
 * `GET /v1/org` signed in). A self-hosted install or a developer without Den
 * access has no way to flip one. Settings > Features lets a person set a local
 * choice that outranks the Den value, so a feature Den left off can be turned on
 * (and one Den turned on can be turned off) for this install only.
 *
 * Storage is renderer localStorage, matching the other local preferences
 * (`showThinking`, theme). Three states per key:
 *
 *   unset      -> follow Den (the shipped default)
 *   "1"        -> force on
 *   "0"        -> force off
 *
 * The Den-served value stays the source of truth for what shipped; this module
 * only layers an explicit local decision on top.
 */

import { FEATURES, type FeatureKey } from "@openwork/features/registry";

/** Desktop-only capability switches read by `useDesktopFeature`. */
export const DESKTOP_FEATURE_KEYS = [
  "computerUse",
  "browserFloatingView",
  "remoteComputers",
  "usageLimitUpgrade",
  "claudeHistoryImport",
] as const;

export type DesktopFeatureKey = (typeof DESKTOP_FEATURE_KEYS)[number];

/** Everything the Features tab can toggle: registry features plus desktop switches. */
export type LocalFeatureKey = FeatureKey | DesktopFeatureKey;

const STORAGE_PREFIX = "openwork.features.local.";

/** Fired on `window` after a local override changes, so readers re-render. */
export const LOCAL_FEATURE_CHANGE_EVENT = "openwork:local-feature-change";

export type LocalFeatureOverride = "on" | "off" | null;

function storageKey(key: LocalFeatureKey): string {
  return `${STORAGE_PREFIX}${key}`;
}

function readStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Storage can throw in private modes or sandboxed frames; a missing store
    // just means no local overrides, not a broken app.
    return null;
  }
}

/** The local choice for one key, or null when it should follow Den. */
export function readLocalFeatureOverride(key: LocalFeatureKey): LocalFeatureOverride {
  const storage = readStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(key));
    if (raw === "1") return "on";
    if (raw === "0") return "off";
    return null;
  } catch {
    return null;
  }
}

/** Sets (or clears, with null) the local choice and notifies listeners. */
export function writeLocalFeatureOverride(key: LocalFeatureKey, value: LocalFeatureOverride): void {
  const storage = readStorage();
  try {
    if (value === null) {
      storage?.removeItem(storageKey(key));
    } else {
      storage?.setItem(storageKey(key), value === "on" ? "1" : "0");
    }
  } catch {
    // Persistence failed; still notify so the current session reflects the
    // intent rather than silently ignoring the click.
  }
  notifyLocalFeatureChange(key);
}

function notifyLocalFeatureChange(key: LocalFeatureKey): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  try {
    window.dispatchEvent(new CustomEvent(LOCAL_FEATURE_CHANGE_EVENT, { detail: { key } }));
  } catch {
    // CustomEvent unsupported (very old runtimes): readers keep their last value.
  }
}

/** Applies a local override on top of a Den-resolved value. */
export function applyLocalFeatureOverride(key: LocalFeatureKey, denValue: boolean): boolean {
  const override = readLocalFeatureOverride(key);
  if (override === "on") return true;
  if (override === "off") return false;
  return denValue;
}

/** Every key the Features tab lists, registry features first. */
export function localFeatureKeys(): LocalFeatureKey[] {
  return [...(Object.keys(FEATURES) as FeatureKey[]), ...DESKTOP_FEATURE_KEYS];
}
