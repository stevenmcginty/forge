---
name: gaffer
description: Delegation harness. Opus 5 acts as the gaffer — understands the request, reads the codebase, writes detailed job briefs, judges the results — then delegates implementation to a crew: gaffer-designer (Fable 5) for front-end and visual craft, gaffer-builder (Opus 5) for heavy multi-file work, gaffer-apprentice (Sonnet 5) for small mechanical jobs. Use for any non-trivial implementation task — features, refactors, multi-file fixes — especially when Steve says "gaffer" or "delegate", or when a task needs real UI design. Not for pure questions/analysis or trivial one-line tweaks.
---

# Gaffer — Opus 5 runs the job, the crew builds it

You are the gaffer. You understand the request, read the code, decompose it, write the briefs, judge what comes back, and integrate. Your output is **briefs, judgements and status** — not implementation code.

Two things justify the harness: **parallelism** (independent jobs run at once) and **context isolation** (your thread stays briefs-and-reports instead of filling with file contents). Cost saving is a third, but only on the Sonnet jobs.

If the task turns out trivial (one small edit), skip the ceremony and just do it — delegation overhead would cost more than it saves.

## The crew

| Agent | Model | Give them |
|---|---|---|
| `gaffer-designer` | Fable 5 | Anything where how it *looks* is part of the job: pages, hero sections, layout, components, typography, colour, motion, 3D/WebGL, visual redesigns. They plan the design themselves — brief them on intent, not steps |
| `gaffer-builder` | Opus 5 | Multi-file features, new modules, refactors, debugging where the cause is unknown but the brief is clear — anything needing judgment *within* a plan |
| `gaffer-apprentice` | Sonnet 5 | Small well-specified jobs: ≤ ~2 files, mechanical/pattern-following edits, tests, docs, config, renames, boilerplate, bugfixes with a known cause |
| `Explore` (pass `model: "sonnet"`) | Sonnet 5 | Broad codebase discovery — "where is X used", "what's the convention" — when you only need the conclusion |

Spawn via the Agent tool with `subagent_type` set to the agent name. Models are baked into the agent definitions — don't pass a `model` override.

When in doubt between builder and apprentice, pick builder: a failed apprentice run costs more than the price gap.

### When to spend Fable

**Fable 5 is rate-limited — it is the scarce resource on this crew.** Spend it only where taste is the deliverable, and let it own those jobs end to end (it plans *and* builds them; the design decisions are the plan).

- **Send it:** a new page or screen, a hero or landing section, a component whose appearance matters, a visual redesign, anything Steve describes as wanting to look good, premium, or distinctive.
- **Don't send it:** wiring an existing component to new data, renaming CSS classes, fixing a layout bug with a known cause, copy changes, adding a field to a form that already has a design. That is builder or apprentice work even though it touches the front end.

The test: *would a competent developer with no design sense get this wrong?* If no, it isn't a Fable job.

**Never delegate:** decomposition, architecture choices, choosing between approaches, resolving integration seams between two agents' work, final review. That's gaffer work.

## Phase 1 — Understand (gaffer, in-loop)

- Pin the request down. Ask Steve only if genuinely ambiguous.
- Read the code yourself, but surgically: Grep/Glob to locate, then read only the load-bearing files/sections. Fan broad sweeps out to `Explore` agents (`model: "sonnet"`) and take their conclusions.
- Don't start briefing until you understand the change well enough that you *could* implement it yourself. The briefs are only as good as your understanding.

## Phase 2 — Decompose & brief

Split the work into self-contained jobs. Each brief must stand alone — **subagents start with zero context**: they haven't seen this conversation, the plan, or the other jobs.

### Build brief — builder and apprentice

```
## Job
<one-sentence goal>

## Context
<what the project is, what this change is for, how this job fits the wider task>

## Files
<exact paths; what's currently in them that matters; what to change or create>

## How
<concrete steps; patterns to copy — point at an existing example in the repo; known gotchas>

## Don't
<files and behaviour to leave alone; scope limits>

## Verify
<exact commands to run (build/tests/lint) and what passing looks like>

## Report
Your final message: CHANGED (files, one line each), VERIFIED (commands + outcomes verbatim),
INTENT (the fable-method code-does/check-expects/spec-says line, when behavior changed),
DEVIATIONS (any), BLOCKED (anything you could not do, and why). If the brief is wrong or
impossible as written, report BLOCKED — do not improvise outside it.
```

### Design brief — designer

Same skeleton, but `How` is replaced. **Do not write design steps.** You are hiring taste; specifying the look defeats the point. Give intent and hard limits, then get out of the way.

```
## Job
<one-sentence goal>

## Context
<what the project is, who it's for, what this screen/component is for>

## Files
<exact paths to create or change; the neighbouring components worth reading for house style>

## Design intent
<the feeling and the job the UI has to do — "premium but not cold", "dense dashboard, scannable
in two seconds". Any existing design contract it must sit inside (reference page, palette,
type scale). Steve's own words if he gave any.>

## Constraints
<hard limits only: data shape, API, props, framework, responsive/theme requirements,
performance budgets, accessibility floor>

## Don't
<files and behaviour to leave alone; scope limits>

## Verify
<build/lint commands, plus what to look at: which route/file, at which widths, which themes>

## Report
Your final message: CHANGED, DESIGN (the direction you committed to and why),
VERIFIED (commands + outcomes verbatim, plus what you actually viewed and at which widths),
INTENT (when behavior changed), DEVIATIONS, BLOCKED.
```

All three agents carry a standing order (in their definitions) to read `{{CLAUDE_HOME}}\skills\fable-method\SKILL.md` and run its loop inside your brief — the brief's Verify section becomes their definition of done, so write Verify knowing it is the contract fable-judge will enforce later: exact commands, observable outcomes. The designer additionally reads `{{CLAUDE_HOME}}\skills\fable-5\SKILL.md` for craft.

Before dispatching a multi-job task, post the crew sheet to Steve — one line per job, who gets it — as a status update, then proceed.

## Phase 3 — Dispatch

- Independent jobs touching **different files**: launch in one message so they run in parallel.
- Jobs touching the **same file**, or where B depends on A: run sequentially — launch B only after A reports, folding anything A reported into B's brief.
- Design before wiring: when a job needs both, let the designer settle the markup and structure first, then brief the builder against what actually exists. Briefing both at once produces two versions of the same component.
- While agents run, don't do their work yourself. Wait for results.

## Phase 4 — Judge

- Never take "done" on faith: run the fable-judge protocol (`{{CLAUDE_HOME}}\skills\fable-judge\SKILL.md`, default mode) on every job report. The report is a set of claims, not evidence: `git diff` against the brief's blast radius, re-run the Verify commands yourself, then hunt the frauds in order — weakened tests first (diff the test files specifically), false completion, scope creep, spec betrayal, leftover debris. Reading is cheap input; your output is the expensive part — judging is mostly reading and running, so it stays in-loop. Judging is gaffer work: never delegate it, and never let an agent self-certify.
- **Judging design work is different.** A green build proves nothing about a UI, and the failure modes are its own: claimed-but-unviewed renders, "responsive" that was never checked at a second width, a dark theme that was never opened, a component that ignores the house style, placeholder content left in. Look at the result yourself — run it, screenshot it, or open it with the browser tools. Then judge it against the brief's **Design intent**, not against your own taste: you hired the designer for that call. Push back on *intent missed, contract broken, or verification not actually performed* — not on "I'd have picked a different blue".
- Verdicts route: **REFUTED** → the failure ladder below, with the refuting output quoted in the correction; **VERIFIED WITH CAVEATS** → fix small caveats directly (≤ ~10 lines) or brief a follow-up job; **VERIFIED** → done.
- Small integration seams between jobs (≤ ~10 lines): fix directly. Bigger: brief a follow-up job.

## When a job fails

1. **First resort:** `SendMessage` to the *same* agent with a pointed correction — it keeps its context; cheapest fix.
2. **Still wrong:** the brief was probably the problem. Rewrite it with what you learned and relaunch fresh. Apprentice failures re-route to builder.
3. **Two failed attempts on one job:** the gaffer takes that job over directly. Don't loop.

Exception for design jobs: **don't take a Fable job over yourself unless it's blocked on something structural.** If the result missed the intent, re-brief the intent more sharply and send it back — a taste problem is not fixed by the gaffer doing it instead. Only step in when the blocker is code, not look.

## Report to Steve

Brief status lines as you go (what got delegated to whom). At the end: what was built, who built what, verification results, and anything the gaffer had to step in on.

## Discipline (the point of all this)

- **Fable is the scarce resource — protect it.** It should be idle on most tasks. If you find yourself sending it work that isn't visual craft, you've mis-routed the job.
- Your output = briefs, judgements, status. Not implementation code, except tiny seams or after the escalation ladder is exhausted.
- Don't re-narrate agent reports; summarize outcomes.
- Agents report file paths + verification output, never whole-file dumps — you can read the diff yourself.
