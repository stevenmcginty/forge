# Forge conductor voice agent — chosen direction (condensed from the Plan agent, 2026-11-04)

(m) measured, (e) estimate, (v) vendor fact to verify.

## Recommended: C — two Claudes + a job ledger, over a full-duplex voice shell

1. Duplex shell. Mic always open in the main renderer (getUserMedia echo cancel); Forge's own speech echo-cancelled; talking over Forge stops only the speech.
   Ears, two engines behind one interface: (a) OpenAI realtime transcription with semantic VAD (v); (b) local Parakeet fed 16 kHz frames from the renderer, partials every ~300 ms, endpointer: end 350 ms after a finished-sounding partial, wait up to 1.2 s after "and/so/um/comma"; joinsTurnInFlight stays as a net. Speculative start on the first pause, abort if he keeps talking.
   Mouth: clause streaming (first clause 4-8 words), 2-clause prefetch; Kokoro bf_emma fp32 (free) or a cloud streaming voice — Steve picks by ear. All playback through the main renderer AudioContext (echo reference). Ack clips in the same voice if no audio 600 ms after he stops. Words, never beeps.
2. Claude Voice (main). Messages API streaming, Haiku 5.5 thinking off (Sonnet 5.5 switch). Frozen cached prefix + message thread; per-turn state as a mid-conversation system message: app snapshot + ledger digest (<=1.5k tokens). Instant tools only: get_app_state, show_view, focus_pane, forge_command (non-destructive), look, read_ledger, pane_digest, delegate(job), steer(job), cancel(job). No Bash/typing/project creation. Cannot claim work the ledger does not show.
3. Conductor (main). Agent SDK, Opus 5.5 on the subscription, one warm streaming-input session (host.ts pattern). Tools: forgeToolDefs, forge-bridge, browser/window_*, open_agent_pane, type_into_pane, read_pane (summary default), create_project, report(job, step, state). Subagents: researcher, operator (computer use), summarizer (Haiku). PostToolUse hooks write ledger steps. Watches coding panes via attention-bus + brief report-back, never 58k-token screen reads.
4. Job ledger (main, event log in data dir). Job = id, title, project, pane, owner, state (queued|running|needs-you|done|failed|stopped), steps (<=200 chars), times. Written by Conductor report, hooks, attention-bus, brief delivery. Read by Voice (digest + news), the UI, desktop cards, phone push, Telegram. News: "needs you" at the next gap, never over him; "done" batched; progress only when asked.
5. Operator (computer use). Sonnet 5.5 + computer_toolset_20260801, actions executed by electron/desktop-hands.ts (screenshot px, DPI aware); UIA window_read first, pixels only where UIA sees nothing; confirm before submit/buy/send.
6. Agent UI — Steve picks Direction A or B (scratchpad/agent-ui-concepts/A.png, B.png). Bar position fixed; every state = word + shape; Show me + Stop on every job; desktop cards (shot-card-window pattern) when Forge is minimised; phone web push.

Latency budget (e): end-of-turn 300-500 ms + Haiku TTFT 300-600 ms + first clause Kokoro 400-600 ms = ~1.0-1.7 s. Ack at 0.6 s covers tool turns.
Cost (e): Voice on Haiku < $1/heavy day (API key — host.ts header currently says "no key, ever": needs Steve's OK; fallback = SDK session on haiku via subscription). Conductor = subscription. Operator ~$0.2-1/task API.

## Build order (each step ships on its own; old agents stay in the picker)
1. Voice shell + Claude Voice on desktop, new picker entry. Proof: 30-turn log end-of-speech -> first audio sample, p50 <= 1.2 s, p90 <= 1.8 s, zero cut-off sentences.
2. Ledger + Conductor; Voice gets delegate/steer/cancel + news. Proof: "open an agent in koraos, run the tests, tell me when done" — small talk continues, report spoken within 10 s of the pane stopping, no false "done" in 10 runs.
3. Agent UI (chosen direction), desktop cards, phone push.
4. Hands: pane summaries (<=2k tokens per tool result), operator subagent, create/open project with "show me".
5. Remote: phone ears in the browser, clause audio over binary WebSocket frames, ledger news to Telegram.

Fallback if step 1 misses latency: GPT Realtime in front of the same ledger + Conductor (architecture A).

## Rejected
A (GPT Realtime front, Claude behind a tool): fastest, but Claude neither talks nor thinks at the front; paraphrase/false "done" risk; $10-20/heavy day.
B (one Claude, faster shell): serial loop can't talk while working; barge-in stops the work; context bloat; 1.5-2.5 s (e).

## Audit gaps to close along the way (scratchpad/agent-capability-audit.md)
- Claude Voice: ask_brain/tell_brain/list_subagents defined but not in the allowed set (host.ts ~1427-1466; canUseTool ~1518) — UNVERIFIED.
- No report-back into Claude Voice; announcer only speaks while Forge is minimised.
- create_project only makes a folder; many actions confirm-gated (GATED_TOOLS host.ts ~96); settingSources: [] so no global memory.
