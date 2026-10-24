import { readWorkbotModel, withWorkbotModel, isWorkbotManagedLuna, workbotModelTestSchema, workbotSettingsInputSchema, workbotSettingsSchema } from "@openwork/types/den/workbot-settings"
import {
  mergeWorkbotProactiveSettings,
  readWorkbotProactiveSettings,
  withWorkbotProactiveSettings,
  workbotProactiveSettingsInputSchema,
  workbotProactiveViewSchema,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission, userSessionRoute } from "../../middleware/index.js"
import { proactiveRunnerReady, proactiveSlackReady, readProactiveSettings } from "../../workbot-proactive/access.js"
import { workbotOrigin } from "../../workbot/config.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import { testOrganizationWorkbotModel } from "../../workbot/model-test.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import {
  checkWorkbotModelChoice,
  workbotModelCatalog,
  readOrganizationDefaultModel,
  workbotSettingsView,
} from "../../workbot/model.js"
import { memberPermissionsForRequest, type OrgRouteVariables } from "./shared.js"

const workbotSettingsDocumentSchema = workbotSettingsSchema.meta({ ref: "WorkbotSettings" })
const workbotSettingsInputDocumentSchema = workbotSettingsInputSchema.meta({ ref: "WorkbotSettingsInput" })
const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.string() })
const unknownModelSchema = z.object({ error: z.literal("unknown_model"), message: z.string() }).meta({ ref: "WorkbotUnknownModelError" })
const runnerUnavailableSchema = z
  .object({ error: z.literal("workbot_runner_unavailable"), message: z.string() })
  .meta({ ref: "WorkbotRunnerUnavailableError" })

export const UNKNOWN_MODEL_MESSAGE = "Workbot can't use that model. Choose one from the list."
export const RUNNER_UNAVAILABLE_MESSAGE = "Workbot's models can't be checked right now. Try again in a minute."

const notFound = jsonResponse("The organization was not found, or Workbot is off.", featureDisabledSchema)

const requireWorkbotSettingsRead: ReturnType<typeof requireOrgPermission> = async (c, next) => {
  if ((await memberPermissionsForRequest(c))?.has("inference.manage")) return next()
  return requireOrgPermission("inference.view")(c, next)
}

/** Heads-ups need Workbot on this deployment, the same capability that gates Workbot itself. */
const requireWorkbotDeployed: ReturnType<typeof requireOrgPermission> = async (c, next) => {
  if (workbotOrigin() === null) return c.json({ error: "feature_disabled" as const, feature: "workbot" }, 404)
  return next()
}

const workbotProactiveViewDocumentSchema = workbotProactiveViewSchema.meta({ ref: "WorkbotProactiveSettings" })
const workbotProactiveInputDocumentSchema = workbotProactiveSettingsInputSchema.meta({ ref: "WorkbotProactiveSettingsInput" })
const invalidHoursSchema = z.object({ error: z.literal("invalid_working_hours"), message: z.string() }).meta({ ref: "WorkbotProactiveInvalidHoursError" })
export const INVALID_WORKING_HOURS_MESSAGE = "The workday must end after it starts."

async function proactiveView(organizationId: Parameters<typeof proactiveSlackReady>[0], settings: WorkbotProactiveSettings) {
  return { settings, slackReady: await proactiveSlackReady(organizationId), runnerReady: proactiveRunnerReady() }
}

/**
 * Manage › Workbot: the organization's default model for its cloud agents (Workbot, the Slack assistant, and cloud
 * Automations set to the cloud default). Admins choose it from their AI Gateway models.
 */
export function registerOrgWorkbotSettingsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/workbot-settings/proactive",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get Workbot's proactive heads-up settings",
      description:
        "Returns the organization's Proactive settings for Workbot (Manage › Workbot): whether heads-ups are on, which calendar heads-ups are enabled, working hours, the daily limit per member and whether members start opted in. Also says whether the Slack assistant is ready to deliver them and whether the headless runner meeting prep needs is configured. Requires the workbotProactive feature, Workbot on this deployment, and View OpenWork Models settings or Manage OpenWork Models.",
      responses: {
        200: jsonResponse("Proactive settings returned.", workbotProactiveViewDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks both View OpenWork Models settings and Manage OpenWork Models.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireWorkbotSettingsRead,
    async (c) => {
      c.header("Cache-Control", "no-store")
      const organizationId = c.get("organizationContext").organization.id
      return c.json(await proactiveView(organizationId, await readProactiveSettings(organizationId)))
    },
  )

  app.put(
    "/v1/org/workbot-settings/proactive",
    describeRoute({
      tags: ["Organizations"],
      summary: "Change Workbot's proactive heads-up settings",
      description:
        "Changes any subset of the organization's Proactive settings for Workbot. The next check uses them; members' own choices (muted, snoozed, turned off) are kept. Heads-ups only read members' calendars and email and never act for them. Requires the workbotProactive feature, Workbot on this deployment and Manage OpenWork Models.",
      responses: {
        200: jsonResponse("Proactive settings saved.", workbotProactiveViewDocumentSchema),
        400: jsonResponse("The request was invalid, or the workday would end before it starts.", z.union([invalidHoursSchema, invalidRequestSchema])),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the Manage OpenWork Models permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireOrgPermission("inference.manage"),
    jsonValidator(workbotProactiveInputDocumentSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const organizationId = c.get("organizationContext").organization.id
      const change = c.req.valid("json")
      const result: { settings: WorkbotProactiveSettings | null } = { settings: null }
      await updateOrganizationMetadata(organizationId, (current) => {
        result.settings = mergeWorkbotProactiveSettings(readWorkbotProactiveSettings(current), change)
        return result.settings ? withWorkbotProactiveSettings(current, result.settings) : current
      })
      if (!result.settings) return c.json({ error: "invalid_working_hours" as const, message: INVALID_WORKING_HOURS_MESSAGE }, 400)
      return c.json(await proactiveView(organizationId, result.settings))
    },
  )

  app.post(
    "/v1/org/workbot-settings/test-default-model",
    describeRoute({
      tags: ["Organizations"],
      summary: "Test Workbot's default model",
      description: "Runs one bounded synthetic completion on the server-resolved organization default with the signed-in member's AI Gateway access. No member content, tools, files, MCP access or conversation is used. May consume paid inference. Returns only status, a safe error code and requested/provider-reported model IDs. Requires a genuine user session, recent sign-in, Manage OpenWork Models. Limited durably to three checks per organization and three per member in a ten-minute inactivity-reset window. Never exposed to MCP.",
      ...{ "x-mcp": false },
      responses: {
        200: jsonResponse("Synthetic completion result; catalog availability alone never means answered.", workbotModelTestSchema.meta({ ref: "WorkbotModelTest" })),
        400: jsonResponse("Only an empty request body is accepted.", invalidRequestSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("A genuine recent user sign-in and Manage OpenWork Models are required.", forbiddenSchema),
        404: notFound,
        429: jsonResponse("The durable diagnostic request limit was reached.", z.object({ error: z.literal("rate_limited"), retryAfterSeconds: z.number() })),
      },
    }),
    orgMemberRoute(),
    userSessionRoute(),
    requireOrgPermission("inference.manage"),
    jsonValidator(z.strictObject({})),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      const windowMs = 10 * 60_000
      for (const key of [`workbot-model-test:org:${context.organization.id}`, `workbot-model-test:member:${context.currentMember.id}`]) {
        const retryAfterSeconds = await checkRateLimit(key, 3, windowMs, Date.now())
        if (retryAfterSeconds !== null) {
          c.header("Retry-After", String(retryAfterSeconds))
          return c.json({ error: "rate_limited", retryAfterSeconds }, 429)
        }
      }
      return c.json(await testOrganizationWorkbotModel(context.organization.id, context.currentMember.userId))
    },
  )

  app.get(
    "/v1/org/workbot-settings",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get Workbot settings",
      description:
        "Returns the organization's default model for Workbot, the Slack assistant and cloud Automations set to the cloud default (null means the caller's AI Gateway default), and the caller's credential-ready, supported Gateway assignments. defaultModel identifies that default and defaultReadiness reports whether it is available; an organization default never grants inference access. With workbotIncludedModels or workbotUsageRecovery, Workbot’s default is free Auto or paid Models Luna using this member’s entitlement; no custom provider is needed. Requires View OpenWork Models settings or Manage OpenWork Models.",
      responses: {
        200: jsonResponse("Workbot settings returned.", workbotSettingsDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks both View OpenWork Models settings and Manage OpenWork Models.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireWorkbotSettingsRead,
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      const actor = { organizationId: context.organization.id, userId: context.currentMember.userId }
      const chosen = await readOrganizationDefaultModel(actor.organizationId)
      // Gateway projections are live and actor-scoped; never put them in the deployment catalog cache.
      const catalog = await workbotModelCatalog(actor).catch(() => null)
      return c.json(workbotSettingsView(chosen, catalog))
    },
  )

  app.put(
    "/v1/org/workbot-settings",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set Workbot's default model",
      description:
        "Sets the organization's default model for Workbot, the Slack assistant and cloud Automations set to the cloud default, from their next message or run; null uses the AI Gateway default. Automations with their own model keep it. Only the caller's supported, credential-ready Gateway aliases are accepted. Each executing member still needs their own assignment and credentials. With workbotIncludedModels or workbotUsageRecovery, selecting the managed Luna starter keeps the shared saved choice null; other cloud agents retain their existing default policy. Requires the Manage OpenWork Models permission and a recent sign-in.",
      responses: {
        200: jsonResponse("Workbot settings saved.", workbotSettingsDocumentSchema),
        400: jsonResponse("The model is not one the runner serves, or the request was invalid.", z.union([unknownModelSchema, invalidRequestSchema])),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the Manage OpenWork Models permission or needs to sign in again.", forbiddenSchema),
        404: notFound,
        503: jsonResponse("The headless runner could not be reached to check the model.", runnerUnavailableSchema),
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("inference.manage"),
    jsonValidator(workbotSettingsInputDocumentSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      const organizationId = context.organization.id
      const actor = { organizationId, userId: context.currentMember.userId }
      const { model: requestedModel } = c.req.valid("json")
      const catalog = await workbotModelCatalog(actor).catch(() => null)
      // Selecting the managed starter means Default. Do not save a Workbot-only route as Slack/Automation policy.
      const model = isWorkbotManagedLuna(requestedModel) && requestedModel === catalog?.defaultModel ? null : requestedModel
      const choice = checkWorkbotModelChoice(model, catalog)
      if (choice === "runner_unavailable") return c.json({ error: "workbot_runner_unavailable" as const, message: RUNNER_UNAVAILABLE_MESSAGE }, 503)
      if (choice === "unknown_model") return c.json({ error: "unknown_model" as const, message: UNKNOWN_MODEL_MESSAGE }, 400)
      const metadata = await updateOrganizationMetadata(organizationId, (current) => withWorkbotModel(current, model))
      return c.json(workbotSettingsView(readWorkbotModel(metadata), catalog))
    },
  )
}
