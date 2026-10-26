/** @jsxImportSource react */
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { FEATURES, type FeatureKey } from "@openwork/features/registry";
import {
  DESKTOP_FEATURE_KEYS,
  type LocalFeatureKey,
} from "@/app/lib/local-feature-overrides";
import { useLocalFeatureSetting, useDenFeatureValue } from "@/app/lib/use-local-feature";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

/**
 * Settings > Features: every feature flag this build knows about, with a local
 * switch that outranks the Den value.
 *
 * OpenWork normally resolves features from Den (`GET /v1/features` signed out,
 * `GET /v1/org` signed in). That is the right default for a managed rollout and
 * stays the source of truth: a switch left on "Follow Den" shows exactly what
 * the deployment decided. A self-hosted install, or anyone without Den admin
 * access, can still turn a feature on or off here for this install only.
 */

/** Copy for the five desktop capabilities that are not in the registry. */
const DESKTOP_FEATURE_COPY: Record<(typeof DESKTOP_FEATURE_KEYS)[number], { label: string; description: string }> = {
  computerUse: {
    label: "Computer use",
    description: "Let the agent look at the screen and control apps on this computer.",
  },
  browserFloatingView: {
    label: "Floating browser view",
    description: "Show the built-in browser beside the chat while the agent browses.",
  },
  remoteComputers: {
    label: "Remote computers",
    description: "Run the agent on a cloud computer instead of this machine.",
  },
  usageLimitUpgrade: {
    label: "Usage limit upgrade",
    description: "Offer an upgrade path when a usage limit is reached.",
  },
  claudeHistoryImport: {
    label: "Claude history import",
    description: "Import conversations from the Claude desktop app.",
  },
};

type FeatureRowModel = {
  key: LocalFeatureKey;
  label: string;
  description: string;
  /** Deployment restriction, when the registry scopes the feature. */
  deployments: readonly string[] | null;
};

function registryRows(): FeatureRowModel[] {
  return (Object.keys(FEATURES) as FeatureKey[]).map((key) => {
    const definition = FEATURES[key];
    return {
      key,
      label: definition.label,
      description: definition.description,
      deployments: definition.deployments,
    };
  });
}

function desktopRows(): FeatureRowModel[] {
  return DESKTOP_FEATURE_KEYS.map((key) => ({
    key,
    label: DESKTOP_FEATURE_COPY[key].label,
    description: DESKTOP_FEATURE_COPY[key].description,
    deployments: null,
  }));
}

/**
 * Three-state control: Follow Den (no override), On, or Off. The switch shows
 * the effective value; the small label says where that value came from, so a
 * local choice is never mistaken for a deployment rollout.
 */
function FeatureRow(props: { row: FeatureRowModel }) {
  const denValue = useDenFeatureValue(props.row.key);
  const { override, effective, setOverride } = useLocalFeatureSetting(props.row.key, denValue);
  const source =
    override === "on"
      ? t("settings.features_source_on")
      : override === "off"
        ? t("settings.features_source_off")
        : denValue
          ? t("settings.features_source_den_on")
          : t("settings.features_source_den_off");

  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{props.row.label}</LayoutSectionItemTitle>
        <LayoutSectionItemHeaderActions>
          <span className="text-xs text-muted-foreground">{source}</span>
          <Switch
            checked={effective}
            onCheckedChange={(checked: boolean) => setOverride(checked ? "on" : "off")}
            aria-label={props.row.label}
          />
          {override ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOverride(null)}
              title={t("settings.features_reset")}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          ) : null}
        </LayoutSectionItemHeaderActions>
        <LayoutSectionItemDescription>{props.row.description}</LayoutSectionItemDescription>
      </LayoutSectionItemHeader>
      {props.row.deployments && props.row.deployments.length === 1 ? (
        <LayoutSectionItemFootnote>
          {t("settings.features_deployment_note", { deployment: props.row.deployments[0] })}
        </LayoutSectionItemFootnote>
      ) : null}
    </LayoutSectionItem>
  );
}

export function FeaturesView() {
  const registry = registryRows();
  const desktop = desktopRows();

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <p className="text-sm text-muted-foreground">{t("settings.features_intro")}</p>
        </LayoutSectionHeader>
      </LayoutSection>

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.features_group_product")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.features_group_product_hint")}</LayoutSectionDescription>
        </LayoutSectionHeader>
        {registry.map((row) => (
          <FeatureRow key={row.key} row={row} />
        ))}
      </LayoutSection>

      <Separator />

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.features_group_desktop")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.features_group_desktop_hint")}</LayoutSectionDescription>
        </LayoutSectionHeader>
        {desktop.map((row) => (
          <FeatureRow key={row.key} row={row} />
        ))}
      </LayoutSection>
    </LayoutStack>
  );
}
