import { useSyncExternalStore } from 'react'
import type { CommandsFeed, FeedOrigin, ReleaseNote, SlashCommand } from '@shared/commands'
import {
  BUNDLED_COMMANDS,
  BUNDLED_SNAPSHOT_DATE,
  commandSignature,
  commandToType,
  matchesQuery,
  needsNewerCli,
  rankCommands,
  releasesAhead
} from '@shared/commands'
import { usesSlashSkills } from '@shared/skills'
import { terminalHost } from './terminals'

export type { CommandsFeed, FeedOrigin, ReleaseNote, SlashCommand }
export {
  BUNDLED_SNAPSHOT_DATE,
  commandSignature,
  commandToType,
  matchesQuery,
  needsNewerCli,
  rankCommands,
  releasesAhead
}

/**
 * The renderer's copy of the command reference.
 *
 * A module store rather than component state, and for a plainer reason than
 * skillLibrary's: the flyout unmounts every time it closes. Held in a component
 * it would re-fetch on every open, which on a cold cache is two HTTPS requests
 * to show a list that has not changed since the last time you looked at it.
 *
 * `loading` is part of the snapshot rather than a separate hook because the
 * empty first render and a genuinely empty answer look identical otherwise, and
 * the difference is "spinner" versus "something is wrong".
 */

const EMPTY: CommandsFeed = {
  commands: BUNDLED_COMMANDS,
  releases: [],
  commandsFrom: 'bundled',
  releasesFrom: 'bundled',
  installed: null,
  latest: null,
  fetchedAt: null
}

export interface CommandsState {
  feed: CommandsFeed
  loading: boolean
}

class CommandsStore {
  private state: CommandsState = { feed: EMPTY, loading: false }
  private listeners = new Set<() => void>()
  private started = false

  /**
   * Subscribing does NOT fetch, and that is the whole point of this comment.
   *
   * It used to. `CommandsButton` is rendered by the tab strip, so the first
   * subscriber appeared the instant the terminal grid mounted — which is the
   * same instant the first pane asks the main process to spawn a shell. The
   * fetch walks eighteen tools down PATH (measured on Steve's machine: 322ms of
   * uninterrupted synchronous stat/access calls, 8,540 of them), then spawns
   * eight `cmd.exe` processes and hits the npm registry — all on the main
   * process's event loop, the same loop serving `pty:create` and every
   * keystroke's `pty:write`.
   *
   * That is the "the first tab is slow and glitchy, but if I close it and open
   * another it's fine" complaint, exactly: the probe cache lives for the life of
   * the process, so tab two finds it warm.
   *
   * Nothing here is needed until the flyout is opened, so nothing here happens
   * until the flyout is opened. See `ensureLoaded`.
   */
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * Fetch once, on demand. Called when the flyout is first opened.
   *
   * Idempotent: later opens are free, and a `refresh(true)` from the Refresh
   * button still goes out regardless.
   */
  ensureLoaded = (): void => {
    if (this.started) return
    this.started = true
    void this.refresh(false)
  }

  snapshot = (): CommandsState => this.state

  private set(next: CommandsState): void {
    this.state = next
    for (const cb of this.listeners) cb()
  }

  /**
   * `refresh(true)` is the Refresh button; `refresh(false)` is the first mount.
   *
   * The old feed is kept on screen for the length of the request. A list that
   * blanks itself while it reloads is a list you cannot read while it reloads,
   * and this one is nearly always already correct.
   */
  async refresh(force: boolean): Promise<void> {
    this.set({ ...this.state, loading: true })
    try {
      const feed = await window.forge.commands.feed(force)
      this.set({ feed, loading: false })
    } catch (err) {
      this.set({
        feed: { ...this.state.feed, error: (err as Error).message || 'Could not read the command reference' },
        loading: false
      })
    }
  }
}

export const commandsStore = new CommandsStore()

export function useCommands(): CommandsState {
  return useSyncExternalStore(commandsStore.subscribe, commandsStore.snapshot, commandsStore.snapshot)
}

/* ------------------------------------------------------------ typing in */

/**
 * Put a slash command into a pane, unsubmitted.
 *
 * Same rule as a skill and as dictation: Forge types, Steve presses Enter. It
 * matters more here than anywhere else in the app — `/clear` and `/logout` are
 * one keystroke from being irreversible, and a reference that ran what you
 * clicked would be a reference nobody could safely browse.
 *
 * Returns false when the pane is not running, so the caller can say so.
 *
 * Synchronous, unlike its skills counterpart: that one may have to read a
 * SKILL.md off disk before it knows what to type, and this one always knows.
 */
export function typeCommandIntoPane(paneId: string, command: SlashCommand): boolean {
  return terminalHost.type(paneId, commandToType(command))
}

/**
 * Is this pane running something that has these commands?
 *
 * The same test the skills rail uses, and the same answer for the same reason:
 * `kimi` is Claude Code pointed at another model, so it has the whole command
 * set; a bare PowerShell has none of it and typing `/context` into one is just
 * an error message. The flyout still lists them — it is a reference — but it
 * warns before typing rather than after.
 */
export function paneTakesCommands(profileCommand: string): boolean {
  return usesSlashSkills(profileCommand)
}
