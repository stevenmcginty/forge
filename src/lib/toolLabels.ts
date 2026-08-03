/**
 * Tool names, as a person would say them.
 *
 * The hub's activity strip shows what Jarvis is doing while he works, and
 * `run_app_action` is not a thing anyone says out loud. This is the one place
 * the mapping lives — the strip, and any future surface that narrates tool
 * work, reads it from here. Names arrive already shortened by the host
 * (`shortToolName` strips the `mcp__forge__` wrapper), so the keys are the
 * bare names as written in electron/voice-agent/host.ts, plus the read-only
 * SDK built-ins its options() allows.
 *
 * Phrasing rule: present participle, lowercase, no trailing full stop —
 * "reading the app state", the way the strip's sentence wants it.
 */
const TOOL_LABELS: Record<string, string> = {
  /* ------------------------------------------------ Forge's eyes and hands */
  get_app_state: 'reading the app state',
  run_app_action: 'working the app',
  get_project_memory: 'reading project memory',
  remember: 'making a note',
  take_screenshot: 'taking a screenshot',
  describe_self: 'checking what it can do',

  /* ------------------------------------------------------------ the desktop */
  list_desktop_apps: 'listing installed apps',
  open_desktop_app: 'opening an app',
  list_windows: 'looking at open windows',
  focus_window: 'switching windows',
  type_into_window: 'typing into a window',
  open_file_or_link: 'opening a file or link',
  close_window: 'closing a window',

  /* -------------------------------------------------------------- the files */
  list_files: 'listing files',
  save_asset: 'saving a file',
  write_file: 'writing a file',
  run_command: 'running a command',

  /* ------------------------------------------------------------ the browser */
  browser_open: 'opening a web page',
  browser_read: 'reading a web page',
  browser_click: 'clicking in the browser',
  browser_type: 'typing in the browser',
  browser_screenshot: 'looking at the browser',

  /* ------------------------------------------- the SDK's read-only built-ins */
  Read: 'reading a file',
  Glob: 'finding files',
  Grep: 'searching the code',
  WebSearch: 'searching the web',
  WebFetch: 'reading a web page',
  Task: 'researching',
  Agent: 'researching'
}

/**
 * The spoken form of a tool name. Unknown names — a tool added before its
 * phrase is — fall back to the identifier de-snaked into words, which is at
 * least readable: `probe_gpu_state` → "probe gpu state".
 */
export function toolLabel(name: string): string {
  const known = TOOL_LABELS[name]
  if (known) return known
  return name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() || 'working'
}
