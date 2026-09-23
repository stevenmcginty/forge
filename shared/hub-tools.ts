/**
 * The hub's four voice tools — navigate by call-sign, list the panes with
 * their names, run a saved prompt, put a file on the canvas — in words and
 * JSON schema, one source for every brain: the realtime ones
 * (src/lib/realtime/tools-hub.ts) and the Claude brain
 * (electron/hub-brain-tools.ts). Both answer through the renderer, in
 * src/lib/realtime/tools-hub.ts `runHubTool`.
 */

export const HUB_TOOL_NAMES = ['focus_pane_by_name', 'list_panes_with_names', 'run_saved_prompt', 'show_on_canvas'] as const

export type HubToolName = (typeof HUB_TOOL_NAMES)[number]

export function isHubTool(name: string): name is HubToolName {
  return (HUB_TOOL_NAMES as readonly string[]).includes(name)
}

export interface HubToolSpec {
  name: HubToolName
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
}

export const HUB_TOOL_SPECS: HubToolSpec[] = [
  {
    name: 'focus_pane_by_name',
    description: [
      'Go to a pane, or to the canvas board, the way Steve says it: a call-sign ("Everest", "Skylar"), a panel number ("panel 4"), an agent ("the codex one"), a pane title, or "the canvas".',
      'Every pane has a short call-sign — list_panes_with_names shows them. Brings the pane’s tab forward and puts the keyboard in it. If more than one pane matches, the answer lists them: ask which one, never guess.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The target in his words: "Everest", "panel 4", "the canvas"' } },
      required: ['name']
    }
  },
  {
    name: 'list_panes_with_names',
    description:
      'List every pane in the open project with its call-sign, panel number, title and agent, and which one is focused. Use it before navigating by name when you are not sure what exists.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'run_saved_prompt',
    description: [
      'Run one of Steve’s saved prompts by its title (or id): it is typed into the focused pane, or into the pane named by `pane`, or put in the composer — whatever the prompt is set to unless `target` says otherwise.',
      'It is only sent (Enter pressed) when the saved prompt itself is set to send. With no `prompt`, the answer lists the saved prompts.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The saved prompt’s title, e.g. "code review"' },
        pane: { type: 'string', description: 'Optional: which pane, in words ("Everest", "panel 2"). Default: the focused one' },
        target: { type: 'string', enum: ['active-pane', 'composer'], description: 'Optional: override where it goes' }
      },
      required: []
    }
  },
  {
    name: 'show_on_canvas',
    description: [
      'Put a file on Forge’s canvas board and show the board: an image (png/jpg/webp/gif/svg), a video (mp4/webm), an .html / .md artifact (Forge renders it live) or a txt note, by absolute path. The file is copied; the original stays put, so to have an artifact refresh live as it changes, write it straight into the board folder (FORGE_CANVAS_DIR) instead.',
      'Images made with make_image/edit_image/make_video go on the board by themselves — no need to post those. With no path it just shows the board.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file' },
        title: { type: 'string', description: 'Optional short title for the board' }
      },
      required: []
    }
  }
]
