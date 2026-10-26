import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useResolvedFeature } from "@/app/lib/use-local-feature"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"

const FEATURE_STALE_MS = 5 * 60_000

/**
 * Whether `composerContextIndicators` is on for the current deployment or organization. Signed in, it follows the active organization (`GET /v1/org`
 * features); signed out, the deployment switch (`GET /v1/features`).
 * Missing flags default off; cached flag data survives a temporary outage.
 *
 * A local choice from Settings > Features outranks the Den value, so an install
 * without Den access can still turn the indicators on (and off).
 */
export function useComposerContextIndicatorsFeature(): boolean {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
  const organization = useOrgFeature("composerContextIndicators")
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => deploymentClient.getDeploymentFeatures(),
    enabled: !context.ready && denAuth.status === "signed_out",
    staleTime: FEATURE_STALE_MS,
    retry: false,
    select: (features) => features.composerContextIndicators === true,
  })
  const denValue = context.ready ? organization : denAuth.status === "signed_out" && deployment.data === true
  return useResolvedFeature("composerContextIndicators", denValue)
}
