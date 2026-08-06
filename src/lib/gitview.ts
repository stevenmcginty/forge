import type { GitFileChange, GitSnapshot, GitUpstreamState } from '@shared/types'

/**
 * Everything the GIT section decides, with no React and no DOM in it.
 *
 * Two kinds of thing live here and both are here for the same reason. The
 * symbols and tones are the section's whole vocabulary, so they belong somewhere
 * a check script can read them rather than being spread across three components
 * that could drift apart. And the handoff prompts are text Forge puts into an
 * agent's prompt on Steve's behalf — the one place in this feature where getting
 * a sentence wrong has consequences past a repaint — so `npm run git:check`
 * holds every one of them to the same four rules.
 */

/**
 * The longest commit message the composer will take.
 *
 * The renderer's copy of `COMMIT_MESSAGE_MAX` in electron/git/git-actions.ts,
 * which it cannot import across the main/renderer line. Main refuses anything
 * longer whatever this says; this is only so the field stops accepting text at
 * the same place rather than letting a paste be typed and then rejected.
 * `npm run git:check` asserts the two numbers agree.
 */
export const COMMIT_MESSAGE_MAX = 500

/* ------------------------------------------------------------------ symbols */

/**
 * The one mono glyph that says where a branch stands.
 *
 * GitLens' vocabulary, deliberately: ahead / behind / diverged / gone is already
 * in the head of anyone who has used a git UI in the last decade, and inventing
 * a fifth spelling of it would buy nothing.
 *
 * **Symbols rather than icons**, and that is a motion decision as much as a
 * drawing one. A glyph carries its meaning while completely still, so the panel
 * reads exactly the same with animation switched off — no spinner, no pulse, and
 * nothing that has to be re-learned in the reduced-motion case.
 */
export function upstreamSymbol(state: GitUpstreamState, ahead = 0, behind = 0): string {
  switch (state) {
    case 'gone':
      // The upstream was deleted — usually by GitHub tidying up after a merge.
      return '!'
    case 'unpublished':
      return '▲+'
    case 'diverged':
      return '▼▲'
    case 'ahead':
      return `▲${ahead}`
    case 'behind':
      return `▼${behind}`
    case 'synced':
      return '✓'
    default:
      // Detached, unborn, or a remote-tracking ref: there is nothing to be ahead
      // or behind of, and a symbol claiming otherwise would be inventing news.
      return ''
  }
}

/** Which token the state's dot and symbol are painted in. */
export type UpstreamTone = 'ok' | 'warn' | 'danger' | 'dim' | 'none'

/**
 * The colour of a branch's state.
 *
 * `unpublished` is 'none' rather than a colour on purpose: a branch that exists
 * only on this machine is not a warning, it is just a branch, and the panel must
 * never make local-only work feel like the degraded path. `synced` is dim for
 * the same reason in reverse — being up to date is the state you want to be able
 * to stop looking at.
 */
export function upstreamTone(state: GitUpstreamState): UpstreamTone {
  switch (state) {
    case 'ahead':
      return 'ok'
    case 'behind':
      return 'danger'
    case 'diverged':
    case 'gone':
      return 'warn'
    case 'synced':
      return 'dim'
    default:
      return 'none'
  }
}

/* ------------------------------------------------------------------ changes */

export interface ChangeGroup {
  /** Repo-relative folder, forward slashes. Empty string is the repository root. */
  dir: string
  files: GitFileChange[]
}

/**
 * Dirty files, folded into their folders.
 *
 * Folders rather than a tree: at rail width a two-level list of "folder, then
 * the files in it" is readable and a nested tree with three levels of indent is
 * not, and the list is nearly always short enough that the extra structure would
 * be pure ceremony. Groups come out in the order git printed their first file,
 * which is alphabetical by path — so the root folder leads and the rest follow
 * their own names without a second sort inventing an order of its own.
 */
export function groupChanges(files: GitFileChange[]): ChangeGroup[] {
  const groups: ChangeGroup[] = []
  const byDir = new Map<string, ChangeGroup>()
  for (const file of files) {
    const cut = file.path.lastIndexOf('/')
    const dir = cut === -1 ? '' : file.path.slice(0, cut)
    let group = byDir.get(dir)
    if (!group) {
      group = { dir, files: [] }
      byDir.set(dir, group)
      groups.push(group)
    }
    group.files.push(file)
  }
  return groups
}

/**
 * The one letter that stands for a file's state.
 *
 * A deliberate copy of `statusLetter` in electron/git/porcelain.ts, which the
 * renderer cannot import — main and the renderer do not share modules, and the
 * two porcelain columns arrive on the snapshot precisely so this side can render
 * them without a second round trip. `npm run git:check` runs both over the same
 * table of `xy` values and asserts they agree, which is the house rule for any
 * fact that has to exist on both sides of that line.
 */
export function changeLetter(xy: string): string {
  if (xy === '??') return '?'
  if (CONFLICT_XY.has(xy)) return 'U'
  // The staged column wins when both are set: "added, then edited again" is
  // still fundamentally an addition, and one letter has to pick one.
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  const c = x !== '.' ? x : y
  return c === '.' ? 'M' : c
}

/** The seven states `git status` calls unmerged. */
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * The colour of a change letter.
 *
 * Untracked is dim rather than green: a file git has never seen is the quietest
 * thing in the list, and a build output that slipped past .gitignore should not
 * be the brightest row on screen.
 */
export function changeTone(letter: string): 'ok' | 'warn' | 'danger' | 'info' | 'dim' {
  switch (letter) {
    case 'A':
      return 'ok'
    case 'D':
      return 'danger'
    case 'U':
      return 'warn'
    case 'R':
      return 'info'
    case '?':
      return 'dim'
    default:
      return 'warn'
  }
}

/** The filename on its own — the part of a path worth the width in a rail. */
export function fileName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

/* ------------------------------------------------------------------- labels */

/**
 * What to call where HEAD is.
 *
 * A detached HEAD gets its sha rather than a blank, because "HEAD @ 3f1c2a" is a
 * place you can recognise and an empty space is a panel that looks broken. A
 * repository before its first commit keeps its branch name: `git init` puts you
 * on a real branch, and saying nothing there is the fastest way to make a
 * perfectly ordinary state look like a failure.
 */
export function branchLabel(snap: GitSnapshot | null): string {
  if (!snap || snap.presence !== 'ok') return ''
  if (snap.detached) return snap.head ? `HEAD @ ${snap.head}` : 'detached'
  return snap.branch ?? ''
}

/** "6m ago", for a fetch time that must never be presented as current. */
export function sinceLabel(at: number | null, now = Date.now()): string {
  if (at === null || !Number.isFinite(at) || at <= 0) return 'never'
  const secs = Math.max(0, Math.round((now - at) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/* ------------------------------------------------------------------ handoff */

/**
 * The things Forge will not do itself, each one a sentence for an agent.
 *
 * `init` and `publish` are the two "there is no repository here" doors; the rest
 * are the clever operations the action row deliberately does not offer. Every
 * one of them is typed into a live agent and never submitted — Steve reads the
 * brief and presses Enter, which is the same contract dictation, task cards and
 * the tab handover all honour.
 */
export type HandoffKind = 'init' | 'publish' | 'diverged' | 'conflicts' | 'tidy' | 'pr' | 'explain'

/**
 * The exact words, per kind.
 *
 * Four rules, asserted by `npm run git:check` over every kind: non-empty, under
 * seven hundred characters, no trailing newline, and no destructive command
 * anywhere inside. The last one is the point of writing them here rather than
 * inline in a component — a prompt that says "force-push it" would be Forge
 * asking an agent to do the one thing this whole feature refuses to do itself,
 * and that is worth a test rather than a careful memory.
 *
 * All of them end in a trailing space rather than a newline, matching the task
 * card handover: the cursor sits after the brief, ready for a person to add a
 * sentence of their own before submitting it.
 */
export function handoffPrompt(kind: HandoffKind, snap: GitSnapshot | null): string {
  const ahead = snap?.ahead ?? 0
  const behind = snap?.behind ?? 0
  const conflicted = snap?.conflicted ?? 0

  switch (kind) {
    case 'init':
      return (
        'Set this folder up on GitHub. It is not a git repository yet. Please: run `git init`, add a .gitignore ' +
        'that matches what is actually in here, make the first commit, then create the GitHub repository with ' +
        '`gh repo create` — private, named after the folder, with the remote set to origin — and push. Tell me ' +
        'the repo URL when it is done. Ask me first if the name or the visibility is not obvious. '
      )

    case 'publish':
      return (
        'Publish this repository to GitHub. It is a git repository with no `origin` remote. Please create it ' +
        'with `gh repo create` — private, named after this folder — set it as origin, push the current branch ' +
        'and set upstream. Tell me the repo URL when it is done. Ask me first if the name or the visibility is ' +
        'not obvious. '
      )

    case 'diverged':
      return (
        `This branch has diverged from its upstream: ${ahead} commit(s) here that are not on origin, and ` +
        `${behind} there that are not here. Look at both sides and tell me what you would do — rebase, merge, ` +
        'or something else — before you do anything. Do not force-push. '
      )

    case 'conflicts':
      return (
        `There are ${conflicted} conflicted file(s) in this repository after a merge or a rebase. Go through ` +
        'them one at a time: resolve each conflict, explain each decision as you go, and stop before committing ' +
        'so I can look at what you did. '
      )

    case 'tidy':
      return (
        'Tidy up this branch before it goes anywhere: look at the commits that are not yet on origin and tell me ' +
        'how you would squash, reword or reorder them, and why. Show me the plan before you rewrite anything. '
      )

    case 'pr':
      return (
        'Open a pull request for this branch with `gh pr create`. Read the commits and the diff against the ' +
        'default branch first, write a title and body that say what actually changed and why, and show them to ' +
        'me before you create it. '
      )

    case 'explain':
      return (
        'Summarise the uncommitted changes in this repository: read the diff and tell me what has changed and ' +
        'why, file by file where that matters. Do not change anything. '
      )

    default:
      return ''
  }
}

/** A short label for the popover row that sends each prompt. */
export function handoffLabel(kind: HandoffKind): string {
  switch (kind) {
    case 'init':
      return 'Set one up'
    case 'publish':
      return 'Publish to GitHub'
    case 'diverged':
      return 'Sort out the divergence'
    case 'conflicts':
      return 'Ask an agent to resolve'
    case 'tidy':
      return 'Tidy the history'
    case 'pr':
      return 'Open a pull request'
    case 'explain':
      return 'Explain the changes'
    default:
      return ''
  }
}

/**
 * Which handoffs are worth offering for this repository, in the order they
 * should be listed.
 *
 * Contextual rather than a fixed menu: a row for resolving conflicts on a
 * repository with none is a row that teaches you to stop reading the menu.
 * "Explain the changes" is the only one that is always there, because it is
 * the one that is always answerable.
 */
export function handoffKinds(snap: GitSnapshot | null): HandoffKind[] {
  if (!snap) return []
  if (snap.presence === 'no-repo') return ['init']
  if (snap.presence !== 'ok') return []

  const kinds: HandoffKind[] = []
  if (!snap.remoteUrl) kinds.push('publish')
  if (snap.conflicted > 0) kinds.push('conflicts')
  if (snap.state === 'diverged') kinds.push('diverged')
  if (snap.ahead > 0) kinds.push('tidy')
  if (snap.gh.status === 'ready' && !snap.gh.currentPr && snap.ahead > 0) kinds.push('pr')
  kinds.push('explain')
  return kinds
}
