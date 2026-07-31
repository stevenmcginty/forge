import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import {
  BUNDLED_COMMANDS,
  CHANGELOG_URL,
  COMMANDS_DOC_URL,
  parseChangelog,
  parseCommandsDoc
} from '@shared/commands'
import type { CommandsFeed, ReleaseNote, SlashCommand } from '@shared/commands'
import { getDataDir } from './store'
import { latestFor, probeTools } from './tools'

/**
 * The slash-command reference and the Claude Code changelog, fetched and kept.
 *
 * Two plain GETs of public markdown. Nothing here runs a command, and nothing
 * here writes anywhere but one cache file Forge owns — the update *button* for
 * Claude Code lives where it always did, in the Updates section, typing into a
 * pane you can read before pressing Enter.
 *
 * Three layers of answer, in order, and the feed always says which one it gave:
 *
 *   live      fetched just now, or within the TTL
 *   cached    the last successful fetch, read back off disk — could be days old
 *   bundled   the snapshot compiled into the app, when there has never been one
 *
 * The disk cache is the layer that earns its keep. Without it the first launch
 * on a train shows a 36-command snapshot from whenever the app was built, while
 * a copy of the real page from yesterday was sitting right there.
 */

/** Long enough that opening the flyout repeatedly is free; short enough that a
 *  CLI released this morning is in the list this afternoon. */
const TTL_MS = 6 * 60 * 60 * 1000

/** These are documents, not APIs. If one is slow, the flyout still opens. */
const FETCH_TIMEOUT_MS = 8000

/** A docs page that has stopped being a table would parse to a handful of rows
 *  and look like a working answer. Below this, treat it as a failed fetch and
 *  keep whatever we had. */
const MIN_PLAUSIBLE_COMMANDS = 12

interface Cached {
  commands: SlashCommand[]
  releases: ReleaseNote[]
  fetchedAt: number
}

let memory: Cached | null = null
/** Set once the disk cache has been consulted, successfully or not. */
let diskRead = false
/** In-flight fetch, so three components mounting at once make one request. */
let inflight: Promise<CommandsFeed> | null = null

function cacheFile(): string {
  return join(getDataDir(), 'claude-docs.json')
}

async function readDisk(): Promise<Cached | null> {
  try {
    const raw = JSON.parse(await readFile(cacheFile(), 'utf8')) as Partial<Cached>
    if (!Array.isArray(raw.commands) || !Array.isArray(raw.releases)) return null
    if (raw.commands.length < MIN_PLAUSIBLE_COMMANDS) return null
    return {
      commands: raw.commands,
      releases: raw.releases,
      fetchedAt: typeof raw.fetchedAt === 'number' ? raw.fetchedAt : 0
    }
  } catch {
    // No cache yet, or a corrupted one. Both mean "fetch"; neither is news.
    return null
  }
}

async function writeDisk(value: Cached): Promise<void> {
  try {
    await writeFile(cacheFile(), JSON.stringify(value), 'utf8')
  } catch {
    // A cache that cannot be written is a slower app, not a broken one.
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'text/markdown, text/plain, */*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/**
 * What version of Claude Code this is, and what the newest one is.
 *
 * Both come from the Updates system rather than being asked again here, so the
 * flyout and the settings page can never disagree about the number — and both
 * are cached there, which is what keeps opening the flyout from spawning
 * processes every time.
 *
 * Both calls are scoped to `['claude']` on purpose, and for the same reason.
 * The unscoped `latestFor` asks winget about PowerShell and Node — a 25-second
 * timeout hanging off a flyout that should open instantly. The unscoped
 * `probeTools` was worse and less visible: eighteen PATH walks, ~322ms of
 * synchronous filesystem calls blocking the main process, and eight `cmd.exe`
 * spawns, to read one field off one of them. Two lines below, only `claude` is
 * ever looked at.
 */
async function versions(): Promise<{ installed: string | null; latest: string | null }> {
  const [probes, latest] = await Promise.all([
    probeTools(false, ['claude']).catch(() => []),
    latestFor(['claude'], false).catch(() => [])
  ])
  return {
    installed: probes.find((p) => p.id === 'claude')?.version ?? null,
    latest: latest.find((l) => l.id === 'claude')?.latest ?? null
  }
}

/**
 * The feed, from the freshest layer that can answer.
 *
 * A refresh forces the network but still falls back the same way: pressing
 * Refresh on a dead connection must not empty a list that was fine a second
 * ago. That is why `previous` is captured before anything is fetched and why
 * every failure path returns it.
 */
async function build(refresh: boolean): Promise<CommandsFeed> {
  if (!diskRead) {
    diskRead = true
    memory = await readDisk()
  }

  const previous = memory
  const fresh = previous && Date.now() - previous.fetchedAt < TTL_MS

  if (!refresh && fresh && previous) {
    const { installed, latest } = await versions()
    return {
      commands: previous.commands,
      releases: previous.releases,
      commandsFrom: 'live',
      releasesFrom: 'live',
      installed,
      latest,
      fetchedAt: previous.fetchedAt
    }
  }

  const [doc, changelog] = await Promise.all([getText(COMMANDS_DOC_URL), getText(CHANGELOG_URL)])
  const { installed, latest } = await versions()

  const parsedCommands = doc ? parseCommandsDoc(doc) : []
  const parsedReleases = changelog ? parseChangelog(changelog) : []
  const gotCommands = parsedCommands.length >= MIN_PLAUSIBLE_COMMANDS
  const gotReleases = parsedReleases.length > 0

  const commands = gotCommands ? parsedCommands : (previous?.commands ?? BUNDLED_COMMANDS)
  const releases = gotReleases ? parsedReleases : (previous?.releases ?? [])

  const commandsFrom: CommandsFeed['commandsFrom'] = gotCommands
    ? 'live'
    : previous?.commands.length
      ? 'cached'
      : 'bundled'
  const releasesFrom: CommandsFeed['releasesFrom'] = gotReleases
    ? 'live'
    : previous?.releases.length
      ? 'cached'
      : 'bundled'

  // Only a real result advances the clock. Stamping a failed fetch would mean
  // six hours of "cached" before anything tries the network again.
  if (gotCommands || gotReleases) {
    memory = { commands, releases, fetchedAt: Date.now() }
    await writeDisk(memory)
  }

  const failed = [!gotCommands ? 'the command list' : '', !gotReleases ? 'the changelog' : '']
    .filter(Boolean)
    .join(' and ')

  return {
    commands,
    releases,
    commandsFrom,
    releasesFrom,
    installed,
    latest,
    fetchedAt: memory?.fetchedAt ?? null,
    ...(failed ? { error: `Could not reach ${failed} — offline, or the page moved.` } : {})
  }
}

export async function commandsFeed(refresh = false): Promise<CommandsFeed> {
  // One request at a time. Without this, a flyout that mounts while a refresh
  // is running fires a second pair of GETs and the two race to write the cache.
  if (inflight && !refresh) return inflight
  const run = build(refresh).finally(() => {
    if (inflight === run) inflight = null
  })
  inflight = run
  return run
}

export function registerCommandsHandlers(): void {
  ipcMain.handle(IPC.commandsFeed, (_e, refresh: boolean) => commandsFeed(refresh === true))
}
