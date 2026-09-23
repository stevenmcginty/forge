/**
 * Discussion mode: the hub talks and plans, but does nothing, until he says go.
 *
 * While it is on, every tool that is not on the read-only list — so
 * run_app_action (opening, closing, send_prompt and every other kind),
 * remember, and the B2 tools that move focus or put things on the canvas — is
 * answered with a refusal the model reads, and the call is kept as the plan.
 * Read-only tools (get_app_state, read_pane, get_project_memory,
 * take_screenshot) still run: planning needs to look.
 *
 * "Go" turns it off and runs the kept plan in order; the model is then told
 * what ran, so it reports rather than repeats it. Pure, so
 * scripts/realtime-check.mjs can hold every one of those rules.
 */

/**
 * Tools that only look. Everything else — including any tool added later that
 * nobody remembered to list — counts as changing something, so a new tool is
 * held by discussion mode until someone decides it is safe.
 */
export const READ_ONLY_TOOLS: readonly string[] = ['get_app_state', 'get_project_memory', 'read_pane', 'take_screenshot']

export function isSideEffecting(name: string): boolean {
  return !READ_ONLY_TOOLS.includes(name)
}

/** Run a call now, or keep it as the plan. The controller asks this for every call. */
export function discussionGate(discussionOn: boolean, name: string): 'run' | 'plan' {
  return discussionOn && isSideEffecting(name) ? 'plan' : 'run'
}

export const DISCUSSION_REFUSAL =
  'NOT DONE: discussion mode is on, so nothing was run. This step is kept in the plan. Tell Steve what you would do, in a sentence, and that you will run it when he says go.'

/**
 * "go", "go ahead", "ok do it", "yes, run it now." — a whole short utterance,
 * never a sentence that merely contains "go" ("go to terminal two" is an
 * instruction, not a green light).
 */
const GO_PHRASES = [
  'go',
  'go ahead',
  'go for it',
  'do it',
  'run it',
  'run the plan',
  'make it so',
  'execute',
  'ship it',
  'lets go',
  'proceed',
  'carry on'
]

export function isGoCommand(text: string): boolean {
  const words = (text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  // Politeness either side of the phrase is fine; anything more is a sentence.
  const lead = new Set(['ok', 'okay', 'yes', 'yeah', 'right', 'alright', 'sure', 'then', 'jarvis'])
  const tail = new Set(['then', 'now', 'please', 'jarvis'])
  while (words.length && lead.has(words[0]!)) words.shift()
  while (words.length && tail.has(words[words.length - 1]!)) words.pop()
  return GO_PHRASES.includes(words.join(' '))
}

export function discussionNote(on: boolean): string {
  return on
    ? 'Discussion mode is ON. Talk it through and plan with Steve; do not run anything that changes Forge — those calls will be refused and kept as the plan. Looking (get_app_state, read_pane, screenshots, memory) is fine. When he says go, the plan runs.'
    : 'Discussion mode is OFF. Act on requests as normal.'
}

export interface PlannedCall {
  name: string
  args: Record<string, unknown>
}

/** What the model is told after "go" ran the kept plan. */
export function planRanNote(results: Array<{ call: PlannedCall; text: string }>): string {
  if (!results.length) return 'Steve said go and discussion mode is now OFF. Carry out the plan you discussed now.'
  const lines = results.map((r, i) => `${i + 1}. ${r.call.name}${r.call.args.kind ? ` ${String(r.call.args.kind)}` : ''} → ${r.text.split('\n')[0]}`)
  return `Steve said go and discussion mode is now OFF. The kept plan has ALREADY been run — do not run these again, just tell him how it went in one line:\n${lines.join('\n')}`
}
