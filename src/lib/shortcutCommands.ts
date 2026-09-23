import type { KeyCommandDef } from './keymap'

/**
 * Forge's built-in keyboard commands: what each one is called, where it lives
 * on the cheat sheet, and the keys it starts with. Handlers live in
 * src/hooks/useShortcuts.ts; this file is data so the check script can prove
 * the defaults never collide and never take a key a terminal needs.
 *
 * Every shortcut Forge had before the registry is here with its old keys, so
 * nobody's fingers have to relearn anything.
 */

const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9]

export const BUILTIN_COMMANDS: KeyCommandDef[] = [
  /* ------------------------------------------------------------ app */
  { id: 'voice.hubCard', title: 'Ask Forge (go to the bar)', group: 'Voice', defaultKeys: ['Ctrl+Shift+G'], scope: 'global' },
  { id: 'app.settings', title: 'Settings', group: 'App', defaultKeys: ['Ctrl+,'], scope: 'global' },
  { id: 'app.devices', title: 'Devices preview', group: 'App', defaultKeys: ['Ctrl+Shift+D'], scope: 'global' },
  {
    id: 'app.cheatSheet',
    title: 'Keyboard cheat sheet',
    group: 'App',
    // Ctrl+Shift+/ ("Ctrl+?"), not Ctrl+/: a terminal sends Ctrl+/ as ^_, readline's undo.
    defaultKeys: ['Ctrl+Shift+/'],
    scope: 'global',
    description: 'Every shortcut, grouped by area.'
  },

  /* ---------------------------------------------------- tabs & panes */
  { id: 'tab.new', title: 'New tab', group: 'Tabs', defaultKeys: ['Ctrl+T'], scope: 'workspace' },
  { id: 'pane.close', title: 'Close pane', group: 'Panes', defaultKeys: ['Ctrl+W'], scope: 'workspace' },
  { id: 'tab.close', title: 'Close tab', group: 'Tabs', defaultKeys: ['Ctrl+Shift+W'], scope: 'workspace' },
  { id: 'tab.next', title: 'Next tab', group: 'Tabs', defaultKeys: ['Ctrl+Tab'], scope: 'workspace' },
  { id: 'tab.prev', title: 'Previous tab', group: 'Tabs', defaultKeys: ['Ctrl+Shift+Tab'], scope: 'workspace' },
  ...digits.map(
    (n): KeyCommandDef => ({
      id: `tab.goto.${n}`,
      title: `Go to tab ${n}`,
      group: 'Tabs',
      defaultKeys: [`Alt+${n}`],
      scope: 'workspace'
    })
  ),
  ...digits.map(
    (n): KeyCommandDef => ({
      id: `pane.goto.${n}`,
      title: `Go to panel ${n}`,
      group: 'Panes',
      defaultKeys: [`Ctrl+${n}`],
      scope: 'workspace',
      description: 'Panels are numbered across the project: tabs in order, panes in each tab in order.'
    })
  ),
  { id: 'pane.next', title: 'Next panel', group: 'Panes', defaultKeys: ['Ctrl+PageDown'], scope: 'workspace' },
  { id: 'pane.prev', title: 'Previous panel', group: 'Panes', defaultKeys: ['Ctrl+PageUp'], scope: 'workspace' },
  { id: 'pane.split.left', title: 'Split left', group: 'Panes', defaultKeys: ['Ctrl+Shift+Left'], scope: 'workspace' },
  { id: 'pane.split.right', title: 'Split right', group: 'Panes', defaultKeys: ['Ctrl+Shift+Right'], scope: 'workspace' },
  { id: 'pane.split.up', title: 'Split up', group: 'Panes', defaultKeys: ['Ctrl+Shift+Up'], scope: 'workspace' },
  { id: 'pane.split.down', title: 'Split down', group: 'Panes', defaultKeys: ['Ctrl+Shift+Down'], scope: 'workspace' },
  { id: 'pane.focus.left', title: 'Focus pane to the left', group: 'Panes', defaultKeys: ['Alt+Left'], scope: 'workspace' },
  { id: 'pane.focus.right', title: 'Focus pane to the right', group: 'Panes', defaultKeys: ['Alt+Right'], scope: 'workspace' },
  { id: 'pane.focus.up', title: 'Focus pane above', group: 'Panes', defaultKeys: ['Alt+Up'], scope: 'workspace' },
  { id: 'pane.focus.down', title: 'Focus pane below', group: 'Panes', defaultKeys: ['Alt+Down'], scope: 'workspace' },

  /* --------------------------------------------------------- projects */
  { id: 'project.next', title: 'Next project', group: 'Projects', defaultKeys: ['Ctrl+Shift+PageDown'], scope: 'workspace' },
  { id: 'project.prev', title: 'Previous project', group: 'Projects', defaultKeys: ['Ctrl+Shift+PageUp'], scope: 'workspace' },

  /* ----------------------------------------------------------- canvas */
  { id: 'canvas.show', title: 'Go to the canvas', group: 'Canvas', defaultKeys: ['Ctrl+Shift+K'], scope: 'workspace' },

  /* -------------------------------------------------------- clipboard */
  { id: 'clipboard.copy', title: 'Copy selection', group: 'Clipboard', defaultKeys: ['Ctrl+Shift+C'], scope: 'workspace' },
  { id: 'clipboard.paste', title: 'Paste', group: 'Clipboard', defaultKeys: ['Ctrl+Shift+V'], scope: 'workspace' },

  /* ------------------------------------------------------------- view */
  { id: 'rail.toggle', title: 'Show or hide the rail', group: 'View', defaultKeys: ['Ctrl+Shift+B'], scope: 'workspace' },
  { id: 'view.toggle', title: 'Tabs ⇄ mosaic', group: 'View', defaultKeys: ['Ctrl+G'], scope: 'workspace' },
  { id: 'font.bigger', title: 'Bigger terminal text', group: 'View', defaultKeys: ['Ctrl+=', 'Ctrl+NumpadAdd'], scope: 'workspace' },
  { id: 'font.smaller', title: 'Smaller terminal text', group: 'View', defaultKeys: ['Ctrl+-', 'Ctrl+NumpadSubtract'], scope: 'workspace' },
  { id: 'font.reset', title: 'Reset terminal text size', group: 'View', defaultKeys: ['Ctrl+0'], scope: 'workspace' },

  /* ------------------------------------------------------------ voice
   * Handlers come from whoever owns the live voice session (B1's
   * VoiceHubController) through `setCommandHandler`; until one is set the key
   * passes straight through to the terminal.
   */
  { id: 'voice.live.toggle', title: 'Start / stop live talk', group: 'Voice', defaultKeys: ['Ctrl+Shift+Space'], scope: 'global' },
  { id: 'voice.mute', title: 'Mute / unmute the mic', group: 'Voice', defaultKeys: ['Ctrl+Shift+M'], scope: 'global' },
  { id: 'voice.interrupt', title: 'Interrupt the assistant', group: 'Voice', defaultKeys: ['Ctrl+Shift+.'], scope: 'global' },
  { id: 'voice.mode.toggle', title: 'Mic: Dictate ⇄ Agent', group: 'Voice', defaultKeys: ['Ctrl+Shift+L'], scope: 'global' }
]

/** Command id for a saved prompt's hotkey. */
export function promptCommandId(promptId: string): string {
  return `prompt.${promptId}`
}

/** Command id for "new pane running this agent profile". Unbound by default; Steve picks the keys. */
export function agentCommandId(profileId: string): string {
  return `agent.new.${profileId}`
}
