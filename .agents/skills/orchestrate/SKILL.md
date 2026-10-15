---
name: orchestrate
description: Act as operational manager for InterDesk — plan and verify here, push mechanical work to the cheaper sub-agents in .Codex/agents/. Invoke at the start of substantial work (multi-file changes, refactors, anything spanning several build/verify cycles). Skip it for one-line questions and small edits.
---

# Orchestrating InterDesk work

While this skill is active the main session acts as an **operational manager**: plan the work, decide
what happens, verify the result — and push mechanical execution down to the sub-agents defined in
`.Codex/agents/`.

**This is standing authorization to spawn those sub-agents without asking each time.** It applies to
the four agents below and to nothing else.

Keep for yourself: architecture and design decisions, anything crossing the BLE wire-format
boundary, debugging with an unknown cause, judging whether output is correct, and talking to the user.

## Routing

| Work | Agent | Model | Effort |
| --- | --- | --- | --- |
| Locating code, tracing call sites, "where does X happen" | `Explore` | Opus 5 | low |
| Running builds, type-check, lint, `pio` compiles | `build-runner` | Opus 5 | low |
| Scoped TypeScript/React edits in `app` | `electron-dev` | Opus 5 | medium |
| Scoped C++ edits in `firmware/InterDesk_firmware` | `firmware-dev` | Opus 5 | medium |

`Explore` deliberately overrides the built-in agent of the same name. Without it, codebase search
inherits the session model; the override pins it to Opus 5 explicitly.

Each agent's `model:` is set explicitly in its frontmatter, so none of them inherit the session
model — the main session stays on Fable 5 while every sub-agent runs on Opus 5; don't remove
those lines.

Give each agent a self-contained brief: the goal, the files it should touch, the constraints, and
what to report back. They start cold and inherit none of this conversation.

## When NOT to delegate

Delegation is not free — each spawn re-derives context the session already has, so misapplied it
costs more than doing the work directly. Do it yourself when:

- The change is a couple of lines, or the file is already open in context.
- You're mid-debug and iterating — the round-trip destroys the feedback loop.
- The task is vague enough that writing the brief takes longer than doing the work.
- It spans the Electron↔firmware boundary. Split it into two briefs, or handle it directly.

It pays off on: parallel independent edits, repo-wide searches, build/verify cycles, and batches of
similar mechanical changes.

## Running them

- Fan out genuinely independent work in a single message so the agents run in parallel.
- Prefer `SendMessage` to continue an existing agent over spawning a fresh one — the fresh one starts
  cold again.
- **Sub-agent reports are claims, not results.** Before telling the user something works, confirm it —
  usually by having `build-runner` compile it, or by reading the diff. A sub-agent reporting
  unverified success is the single most likely failure mode of this setup.
- Relay what matters in your own words; the user does not see the agents' reports.

## On Fable 5

This skill pairs with `/model fable` for genuinely hard sessions. Two things follow from that:

**Pace for long turns.** Fable turns can run many minutes. Its advantage lives in long autonomous
runs, so give the complete task specification up front in one well-specified message rather than
building it across interactive turns. The "when NOT to delegate" rules matter *more* here — a
delegation round-trip inside an already-long turn compounds.

**Expect occasional cyber-classifier fallbacks on firmware work.** InterDesk is a USB dongle that injects
keystrokes into a host machine — structurally the same shape as BadUSB tooling, whatever its ordinary
purpose. Fable's safety classifiers are weighted toward cybersecurity content, so firmware work
around USB HID injection can trip a flag where Opus 5 would not.

This degrades rather than breaks: Codex re-runs the flagged request on Opus 4.8 and prints a
notice in the transcript. It is not a bug. If it happens often enough to be disruptive, run firmware
sessions on `/model opus` instead — the sub-agent tiers below are unaffected either way.
