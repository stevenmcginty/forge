import type { AgentProfile } from '@shared/types'

/**
 * The capability manifest: what the voice agent is told about Forge.
 *
 * One text block, built fresh on every request, handed to every brain as its
 * system instruction. It has to do three things at once — explain the app,
 * enumerate exactly what the model may ask for, and describe the state it is
 * looking at — while staying small enough to send on every turn.
 *
 * Written once, used by every brain. When new abilities land, add them to
 * `ACTION_SPECS` and the brain can use them the same day; the EXTENSION POINTS
 * section names what is coming so the model can say "not yet" instead of
 * hallucinating an action that does not exist.
 */

export interface ManifestPane {
  title: string
  profileName: string
  status: string
  focused: boolean
}

export interface ManifestTab {
  /** 1-based, matching what a human would say ("tab three"). */
  number: number
  title: string
  active: boolean
  panes: ManifestPane[]
}

export interface ManifestSnapshot {
  appVersion: string | null
  projects: Array<{ name: string; path: string; active: boolean }>
  profiles: AgentProfile[]
  tabs: ManifestTab[]
  paneCount: number
  maxSessions: number
  maxPanesPerTab: number
  view: {
    railCollapsed: boolean
    voicePanelWidth: number
    terminalFontSize: number
    shell: string
  }
}

/** Spoken aliases the deterministic grammar accepts, told to the model too. */
const SPOKEN_ALIASES: Record<string, string[]> = {
  pwsh: ['powershell', 'pwsh', 'ps', 'shell', 'posh'],
  claude: ['claude', 'claude code', 'cc'],
  kimi: ['kimi', 'kimmy', 'ki']
}

interface ActionSpec {
  kind: string
  args: string
  what: string
}

/**
 * Every action the executor implements. Keep this list and
 * `runAppAction()` in step — the model is told these are the only ones.
 */
export const ACTION_SPECS: ActionSpec[] = [
  {
    kind: 'open_tabs',
    args: '{"kind":"open_tabs","profileId":"<profile id>","count":<1-16>,"projectName":"<optional project>"}',
    what: 'Open N new terminal tabs running that launch profile.'
  },
  {
    kind: 'open_panes',
    args: '{"kind":"open_panes","profileId":"<profile id>","count":<1-8>,"direction":"row"|"column"}',
    what: 'Split the focused pane N times inside the current tab. row = side by side, column = stacked.'
  },
  {
    kind: 'close_pane',
    args: '{"kind":"close_pane","which":"focused"}',
    what: 'Close the pane that has focus (closing a tab’s last pane closes the tab).'
  },
  {
    kind: 'close_tab',
    args: '{"kind":"close_tab","which":"current"}',
    what: 'Close the current tab and every pane in it.'
  },
  {
    kind: 'switch_project',
    args: '{"kind":"switch_project","name":"<project name>"}',
    what: 'Switch to another project in the rail. Names are matched loosely.'
  },
  {
    kind: 'focus_tab',
    args: '{"kind":"focus_tab","index":<0-based>}',
    what: 'Focus an existing tab. index 0 is the first tab; humans say "tab one" for index 0.'
  },
  {
    kind: 'new_project_hint',
    args: '{"kind":"new_project_hint"}',
    what: 'Explain how to add a project. Adding one needs a folder picker, which you may not open.'
  }
]

/**
 * Abilities that are coming but do NOT exist yet. Listed so the model can be
 * honest about them. ▸ EXTENSION POINT: when one is implemented, move its line
 * into ACTION_SPECS, add the variant to `AppAction`, and handle it in
 * `runAppAction()`. Nothing else needs to change.
 */
export const EXTENSION_POINTS: string[] = [
  'set_permission_mode — switching an agent between plan / auto / full-access modes',
  'open_settings — jumping the user to a settings section',
  'create_project — adding a project folder without the user picking it',
  'send_prompt — typing a drafted prompt into a pane on the user’s behalf',
  'capture_screenshot — taking and attaching a screenshot'
]

function paneLine(pane: ManifestPane): string {
  const bits = [pane.profileName, pane.status]
  if (pane.focused) bits.push('focused')
  return `${pane.title} (${bits.join(', ')})`
}

export function buildManifest(s: ManifestSnapshot): string {
  const lines: string[] = []

  lines.push('# FORGE')
  lines.push(
    'Forge is a Windows development environment for driving coding agents. Every pane is a real PowerShell;',
    'a launch profile decides what gets typed into it (nothing for a plain shell, `claude` for Claude Code, and so on).',
    'Panes live in tabs, tabs belong to a project, and a project is just a folder on disk.'
  )
  lines.push('')
  lines.push('# YOUR JOB')
  lines.push(
    'You are the voice agent inside Forge. Steve talks to you. You do two things:',
    '1. Drive the app when he asks you to — return one or more actions.',
    '2. Turn half-formed ideas into a precise brief for a coding agent — return draftPrompt.',
    'Short, plain, British English. Never speak aloud; never claim to have done something you did not do.'
  )
  lines.push('')
  lines.push('# ACTIONS YOU MAY RETURN')
  for (const spec of ACTION_SPECS) {
    lines.push(`- ${spec.kind}: ${spec.what}`)
    lines.push(`  ${spec.args}`)
  }
  lines.push('')
  lines.push('# LIMITS')
  lines.push(
    `- ${s.maxSessions} shells maximum across the whole app; ${s.paneCount} are open now.`,
    `- ${s.maxPanesPerTab} panes maximum per tab.`,
    '- Over-ask and it is fulfilled partially; you will be told what actually happened.',
    '- You cannot pick folders, read files, run commands directly, or change settings.',
    '- Anything not in the action list above does not exist. Say so rather than inventing it.'
  )
  lines.push('')
  lines.push('# LAUNCH PROFILES')
  if (s.profiles.length === 0) {
    lines.push('- (none configured)')
  } else {
    for (const p of s.profiles) {
      const aliases = SPOKEN_ALIASES[p.id] ?? [p.name.toLowerCase()]
      lines.push(
        `- id "${p.id}" — ${p.name}, runs \`${p.command || '(plain shell)'}\`; spoken as: ${aliases.join(', ')}`
      )
    }
  }
  lines.push('')
  lines.push('# CURRENT STATE')
  lines.push(`forge version: ${s.appVersion ?? 'unknown'} · shell: ${s.view.shell}`)
  if (s.projects.length === 0) {
    lines.push('projects: none yet — the rail is empty')
  } else {
    lines.push('projects:')
    for (const p of s.projects) {
      lines.push(`- ${p.name} — ${p.path}${p.active ? '  [ACTIVE]' : ''}`)
    }
  }
  if (s.tabs.length === 0) {
    lines.push('tabs: none open in the active project')
  } else {
    lines.push('tabs in the active project:')
    for (const tab of s.tabs) {
      lines.push(
        `- ${tab.number}. "${tab.title}"${tab.active ? ' [CURRENT]' : ''} — ${tab.panes.map(paneLine).join('; ')}`
      )
    }
  }
  lines.push(
    `view: projects rail ${s.view.railCollapsed ? 'collapsed' : 'open'}, ` +
      `voice panel ${s.view.voicePanelWidth}px, terminal font ${s.view.terminalFontSize}px`
  )
  lines.push('')
  lines.push('# NOT YET POSSIBLE (do not emit these)')
  for (const point of EXTENSION_POINTS) lines.push(`- ${point}`)
  lines.push('')
  lines.push('# HOW TO REPLY')
  lines.push(
    'Reply with JSON only — no prose outside it, no markdown fence:',
    '{',
    '  "understood": "one line: what you think he wants",',
    '  "say": "your conversational reply to him, plain text, a sentence or two",',
    '  "questions": ["only if you genuinely need to ask"],',
    '  "actions": [ /* zero or more actions from the list above */ ],',
    '  "draftPrompt": "a full, structured prompt for a coding agent — only when he is describing something to build",',
    '  "confidence": "low" | "medium" | "high"',
    '}',
    'If he is commanding the app, return actions and a short say, and leave draftPrompt out.',
    'If he is describing something to build, return draftPrompt (markdown, with goal, constraints and acceptance',
    'criteria) and no actions. If you are unsure which, ask one question instead of guessing.'
  )

  return lines.join('\n')
}
