# Composer context and connectors indicators

Status: proposed, behind `composerContextIndicators`, off by default for cloud
and self-hosted deployments. Enable through the Features controls in `/admin`;
this change does not enable a live rollout.

## Experience

The composer row shows quiet, secondary controls next to the model picker. Each
is a compact control that names its state and opens a small popover; nothing is
added to the transcript and nothing auto-opens.

| Control | Closed | Open |
| --- | --- | --- |
| Connectors | Connected MCP server count and a small logo stack | One row per connector, with sign-in for the ones that need it and a short note for the rest |
| Context | "Context: 34%" and a ring that turns amber from 70% of the window and stronger amber shortly before the engine compacts | Measured total, a segmented bar and one row per category (messages, skills, memory, tools, system and other, buffer, free), each estimate marked, with a switch between share of the window and share of the used context |
| Memory | A count of the workspace's Claude Code compatible memory files | The `MEMORY.md` index, marked as in the prompt, then the topic files as available on demand, each with its approximate token cost |

The memory control is a passive read of the workspace's memory directory. It has
no runtime status to wait for, so it also appears on the new-task screen, and it
hides itself completely when the workspace has no memory at all. Memory tokens
are attributed to their own row, so the memory the engine injects no longer
hides inside "system and other".

Everything is computed locally from what the app already holds (the transcript,
the skill list), plus the engine's own context lists and the workspace memory
route on loopback. No model is asked.

## Memory

A workspace's memory is the Claude Code compatible directory
`<CLAUDE_CONFIG_DIR>/projects/<key>/memory/`, with a `MEMORY.md` index and
frontmatter topic files. The native OpenWork port is read-only: it injects the
index into the system prompt and exposes `memory_list`, `memory_read` and
`memory_search` tools. Recall, extraction and every write are deliberately out
of scope, because they need child sessions and a model. The injected prompt says
memory is read-only, which keeps the model from promising to remember.

The injected text and the reported token count come from one module, so they can
never disagree. Nothing is injected when the workspace has no memory, so an
empty workspace costs zero tokens and the control stays hidden.

## Rollout

Both engines are supported: v1 through `experimental.chat.system.transform`, v2
through the plugin context hook. The engine's injected system text is not tagged
on either engine, so the app asks the server how many tokens memory costs and
subtracts that from the residual row.

Turning the flag off removes the connectors, context and memory controls without
touching the transcript, the skills or the memory files. The memory injection is
currently independent of the flag.

Design follows P3, P5, P6, S7, C6, V2, V5 and T5 in `DESIGN.md`.
