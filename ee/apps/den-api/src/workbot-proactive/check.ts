import { createHash } from "node:crypto"
import type { z } from "zod"
import { parseProactiveReply, PROACTIVE_CHECK_INSTRUCTIONS, type ProactiveReply } from "@openwork/automations/proactive"
import {
  ACTIVE_TURN_STATUSES,
  createHeadlessRunnerClient,
  defaultHeadlessRunnerDeps,
  type HeadlessRunnerActor,
  type HeadlessRunnerClient,
} from "../headless-runner/client.js"

/**
 * One read-only background turn on the shared headless runner, for a proactive check.
 *
 * - A fresh session per check: no chat history, no owner, no shared memory. Nothing it reads can surface later in
 *   the member's own conversations, and the session is deleted once its answer is read.
 * - Read-only: the turn's MCP token is `mcp:read` and the runner allows only read tools, so it cannot send, edit or
 *   accept anything. Anything the member wants done goes through a normal conversation with normal approvals.
 * - Silence by default: the answer is parsed with the shared `NO_REPLY` rule; anything unexpected is silence too.
 */

export type ReadOnlyCheckResult<T> = ProactiveReply<T> | { kind: "unavailable"; code: string }

export type ReadOnlyCheckDeps = {
  client: HeadlessRunnerClient | null
  sleep: (ms: number) => Promise<void>
  now: () => number
  pollMs: number
  deadlineMs: number
}

const TOKEN_TTL_MS = 10 * 60_000
const MAX_READ_FAILURES = 5

export function defaultReadOnlyCheckDeps(): ReadOnlyCheckDeps {
  const runner = defaultHeadlessRunnerDeps()
  return {
    client: runner ? createHeadlessRunnerClient(runner) : null,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    pollMs: 2_000,
    deadlineMs: 3 * 60_000,
  }
}

/** Stable per check, so a resend never starts a second turn. */
export function readOnlyCheckMessageId(key: string) {
  return `wbp_${createHash("sha256").update(`workbot-proactive:${key}`).digest("hex").slice(0, 32)}`
}

export async function runReadOnlyCheck<T>(
  input: { actor: HeadlessRunnerActor; model: string; prompt: string; key: string; schema: z.ZodType<T> },
  deps: ReadOnlyCheckDeps,
): Promise<ReadOnlyCheckResult<T>> {
  const client = deps.client
  if (!client) return { kind: "unavailable", code: "runner_not_configured" }
  const created = await client
    .createSession({
      title: "Heads-up check",
      instructions: PROACTIVE_CHECK_INSTRUCTIONS,
      repeats: { maxWaitingMs: 60_000, maxIdenticalFailures: 2 },
    })
    .catch(() => null)
  if (!created?.ok) return { kind: "unavailable", code: created?.error ?? "runner_unreachable" }
  const sessionId = created.value.id
  const messageId = readOnlyCheckMessageId(input.key)
  try {
    const sent = await client
      .sendTurn(input.actor, { sessionId, messageId, prompt: input.prompt, model: input.model, readOnly: true, ttlMs: TOKEN_TTL_MS })
      .catch(() => null)
    if (!sent?.ok) return { kind: "unavailable", code: sent?.error ?? "runner_unreachable" }
    const deadline = deps.now() + deps.deadlineMs
    let failures = 0
    while (deps.now() < deadline) {
      await deps.sleep(deps.pollMs)
      const read = await client.readSession(sessionId, { messageId, limit: 200, outputs: "none" }).catch(() => null)
      if (!read?.ok) {
        failures += 1
        if (failures >= MAX_READ_FAILURES) return { kind: "unavailable", code: "runner_read_failed" }
        continue
      }
      failures = 0
      const turn = read.value.turns.find((entry) => entry.messageId === messageId)
      if (!turn || ACTIVE_TURN_STATUSES.has(turn.status)) continue
      if (turn.status !== "completed") return { kind: "unavailable", code: turn.error ?? `turn_${turn.status}` }
      const answer = read.value.messages.filter((message) => message.role === "assistant" && message.toolCalls.length === 0).at(-1)
      return parseProactiveReply(answer?.role === "assistant" ? answer.text : read.value.finalAssistantText, input.schema)
    }
    await client.abort(sessionId, messageId).catch(() => null)
    return { kind: "unavailable", code: "timed_out" }
  } finally {
    // Best effort: a session still finishing an aborted turn refuses deletion and ages out with runner retention.
    await client.deleteSession(sessionId).catch(() => null)
  }
}
