import { useRef, useState, type ReactNode } from 'react'
import { SHARE_CAPTURE_DEFAULT_LINES } from '@shared/share'
import type { ShareSlot } from '@shared/types'
import { useHandOff } from '@/hooks/useHandOff'
import { useShareSnapshot } from '@/hooks/useShareSnapshot'
import { sinceLabel } from '@/lib/gitview'
import { shortPath } from '@/lib/paths'
import { captureTitle, capturePaneOptions, sharePrompt, slotRelPath, type PaneOption } from '@/lib/shareview'
import { terminalHost } from '@/lib/terminals'
import { useActiveProject, useActiveWorkspace, useApp } from '@/state/AppState'
import { EmptyState } from '../EmptyState'
import { Icon } from '../Icon'
import { Popover, PopoverRow, PopoverSection } from '../Popover'
import { RailExpand } from './RailExpand'
import { RailSection } from './RailSection'
import { ShareSlotDetail, ShareSlotRow } from './ShareSlotRow'
import './ShareSection.css'

/**
 * Five markdown slots that every agent in this project can read and write.
 *
 * The section exists because a project with five panes open has five sealed
 * processes in it: a plan drafted in Claude cannot be handed to Codex for review
 * without somebody copying text between two terminals. No vendor offers a way for
 * one agent to read another's session and none is going to. But Forge is the
 * parent of all five, and a *file* is something every one of them can already
 * read with the tools it has — so the protocol is five files in the project, and
 * this panel is a comfortable way to fill them.
 *
 * Which means the section is deliberately not the only way in. An agent writing
 * `.forge/share/slot-2.md` itself is a first-class path, arrives here within a
 * settle beat, and is credited honestly as `via: agent`. The MCP tools are a
 * convenience for the CLIs that can see them, not the mechanism.
 */
export function ShareSection(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()
  const view = useShareSnapshot()
  const handOff = useHandOff('Share')

  const [openSlot, setOpenSlot] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ index: number; anchor: HTMLButtonElement } | null>(null)
  const [capturing, setCapturing] = useState<number | null>(null)
  const captureRef = useRef<HTMLButtonElement | null>(null)

  const snap = view.snap
  const expanded = state.railExpanded === 'share'
  const slots = snap?.slots ?? []
  const newest = slots.reduce((max, s) => (s.updatedAt > max ? s.updatedAt : max), 0)

  /** Opening a row means reading it, and a 240px rail is no place to read. */
  const openRow = (index: number): void => {
    setOpenSlot(index)
    if (!expanded) actions.setRailExpanded('share')
  }

  const panes = capturePaneOptions(workspace, state.settings.agentProfiles, (id) =>
    terminalHost.runtime(id).status === 'live'
  )

  /**
   * Capture a pane into a slot.
   *
   * The renderer's own grid first, because it is the same output without the
   * redraw artefacts; main's replay buffer only for a pane this window has never
   * had a terminal for — a session restored on launch and not yet visited.
   */
  const capture = async (index: number, pane: PaneOption): Promise<void> => {
    setCapturing(null)
    setMenu(null)
    const text = terminalHost.snapshotText(pane.paneId, SHARE_CAPTURE_DEFAULT_LINES)
    if (text) {
      const body = [
        `Captured from **${pane.label}** (${pane.agent}), last ${text.split('\n').length} lines.`,
        '',
        '```text',
        text,
        '```',
        ''
      ].join('\n')
      await view.write({ index, title: captureTitle(pane.label), body, via: 'capture', author: pane.label })
      openRow(index)
      return
    }
    await view.capture({
      index,
      paneId: pane.paneId,
      lines: SHARE_CAPTURE_DEFAULT_LINES,
      title: captureTitle(pane.label),
      author: pane.label
    })
    openRow(index)
  }

  const send = async (slot: ShareSlot): Promise<void> => {
    setMenu(null)
    const body = await view.read(slot.index)
    handOff(sharePrompt(slot, body?.body ?? null))
  }

  const copy = async (slot: ShareSlot): Promise<void> => {
    setMenu(null)
    const body = await view.read(slot.index)
    if (body?.body) void navigator.clipboard.writeText(body.body)
  }

  /*
   * The header's pieces, built once and rendered in whichever header is on screen
   * — the rail's or the panel's. Once, because the capture button carries the
   * popover's anchor ref: two live copies and the popover opens under whichever
   * rendered last.
   */
  const status =
    snap && snap.filled > 0 ? (
      <span className="shsec__status" title={`Most recently written ${sinceLabel(newest)}`}>
        {sinceLabel(newest)}
      </span>
    ) : null

  const headerActions = (
    <>
      <button
        ref={captureRef}
        type="button"
        className="ghost-btn"
        title="Capture a pane’s screen into a slot"
        disabled={!snap || view.busy}
        onClick={() => setCapturing(nextEmpty(slots))}
      >
        <Icon name="camera" size={14} />
      </button>
      <button
        type="button"
        className="ghost-btn"
        title="Read the slots again now"
        data-running={view.busy ? 'true' : undefined}
        onClick={view.refresh}
      >
        <Icon name="refresh" size={14} className="shsec__spin" />
      </button>
      <button
        type="button"
        className="ghost-btn"
        title="Show .forge/share in Explorer"
        disabled={!snap}
        onClick={() => project && window.forge.share.reveal(project.id, null)}
      >
        <Icon name="folder" size={14} />
      </button>
    </>
  )

  const body = (
    <div className="shsec">
      {!project ? (
        <EmptyState icon="note" size="sm" title="No project" body="Select a project to share notes inside it." />
      ) : !snap ? (
        <EmptyState icon="note" size="sm" title="Opening…" body="Reading .forge/share." />
      ) : snap.presence === 'no-folder' ? (
        <EmptyState
          icon="folder"
          size="sm"
          title="This folder is gone"
          body="It has been moved, renamed or unmounted since it was added."
          hint={shortPath(project.path)}
        />
      ) : (
        <>
          <div className="shsec__rows">
            {slots.map((slot) => (
              <div key={slot.index} className="shsec__slot">
                <ShareSlotRow
                  slot={slot}
                  selected={openSlot === slot.index}
                  busy={view.busy}
                  onOpen={() => (openSlot === slot.index && expanded ? setOpenSlot(null) : openRow(slot.index))}
                  onMenu={(anchor) => setMenu({ index: slot.index, anchor })}
                />
                {/*
                  The body only ever opens in the panel. Five rows fit in 240px of
                  rail; an eight-line textarea does not, and a section that grows
                  to swallow the project list has broken the rail it lives in.
                */}
                {expanded && openSlot === slot.index ? (
                  <ShareSlotDetail
                    slot={slot}
                    read={view.read}
                    write={(req) => view.write({ ...req, via: 'rail' })}
                    busy={view.busy}
                    onClose={() => setOpenSlot(null)}
                  />
                ) : null}
              </div>
            ))}
          </div>

          <div className="shsec__foot">
            <span title="Written to .forge/share/panes.json, so an agent can read it too">
              {snap.panes.length === 1 ? '1 pane here' : `${snap.panes.length} panes here`}
            </span>
            {/*
              Said out loud rather than fixed silently. A worktree's real exclude
              file lives wherever `git rev-parse --git-common-dir` points, and
              spawning git to find it for a comfort feature is not worth it — so
              the honest answer is a line saying which case this is.
            */}
            {!snap.excluded ? (
              <span className="shsec__warn" title="A worktree, a submodule, or a folder that is not a git repository">
                .forge/ is not excluded from git here
              </span>
            ) : null}
          </div>

          {view.error ? (
            <button type="button" className="shsec__error" title="Dismiss" onClick={view.dismissError}>
              {view.error}
            </button>
          ) : null}
        </>
      )}
    </div>
  )

  return (
    <>
      <RailSection
        id="share"
        title="Share"
        count={snap?.filled ?? null}
        hint="Five notes every agent in this project can read"
        status={expanded ? null : status}
        actions={expanded ? null : headerActions}
        expanded={expanded}
        onExpand={() => actions.setRailExpanded(expanded ? null : 'share')}
      >
        {body}
      </RailSection>

      {/*
        The same body, in a panel over the app. One element rendered in one place
        or the other — never both — so expanding costs no second watch and closing
        puts the section back exactly as it was.
      */}
      {expanded ? (
        <RailExpand
          id="share"
          title="Share"
          hint="Five markdown notes in .forge/share. Every agent working in this project can read and write them — and so can you."
          status={status}
          actions={headerActions}
        >
          {body}
        </RailExpand>
      ) : null}

      {/* Per-slot actions. Outside the section, because a closed section draws no body. */}
      <Popover
        anchor={menu?.anchor ?? null}
        open={menu !== null}
        onClose={() => setMenu(null)}
        align="end"
        width={272}
        label="Slot actions"
      >
        {menu ? (
          <SlotMenu
            slot={slots[menu.index - 1]}
            onCopy={copy}
            onSend={send}
            onCapture={() => setCapturing(menu.index)}
            onClear={() => {
              setMenu(null)
              void view.clear(menu.index)
            }}
            onReveal={() => {
              setMenu(null)
              if (project) window.forge.share.reveal(project.id, menu.index)
            }}
          />
        ) : null}
      </Popover>

      {/* Which pane to capture. Shells included — a failing build is worth sharing. */}
      <Popover
        anchor={captureRef.current}
        open={capturing !== null}
        onClose={() => setCapturing(null)}
        align="end"
        width={288}
        label="Capture a pane"
      >
        <PopoverSection title={capturing ? `Capture into slot ${capturing}` : 'Capture'}>
          {panes.length === 0 ? (
            <div className="popover__hint">No panes are open in this project.</div>
          ) : (
            panes.map((pane) => (
              <PopoverRow key={pane.paneId} onClick={() => capturing && void capture(capturing, pane)}>
                <Icon name="terminal" size={14} />
                <span className="shsec__menu-name truncate">{pane.label}</span>
                <span className="shsec__menu-agent mono">{pane.agent}</span>
              </PopoverRow>
            ))
          )}
        </PopoverSection>
        <div className="popover__hint">
          The last {SHARE_CAPTURE_DEFAULT_LINES} lines of that pane’s screen, as text.
        </div>
      </Popover>
    </>
  )
}

/* -------------------------------------------------------------------- menu */

function SlotMenu({
  slot,
  onCopy,
  onSend,
  onCapture,
  onClear,
  onReveal
}: {
  slot: ShareSlot | undefined
  onCopy: (slot: ShareSlot) => void
  onSend: (slot: ShareSlot) => void
  onCapture: () => void
  onClear: () => void
  onReveal: () => void
}): ReactNode {
  if (!slot) return null
  return (
    <>
      <PopoverSection title={slot.filled ? slot.title : `Slot ${slot.index}`}>
        <PopoverRow disabled={!slot.filled} onClick={() => onSend(slot)}>
          <Icon name="send" size={14} />
          <span className="shsec__menu-name">Send to an agent</span>
        </PopoverRow>
        <PopoverRow disabled={!slot.filled} onClick={() => onCopy(slot)}>
          <Icon name="file" size={14} />
          <span className="shsec__menu-name">Copy the text</span>
        </PopoverRow>
        <PopoverRow onClick={onCapture}>
          <Icon name="camera" size={14} />
          <span className="shsec__menu-name">Capture a pane into it</span>
        </PopoverRow>
        <PopoverRow onClick={onReveal}>
          <Icon name="folder" size={14} />
          <span className="shsec__menu-name truncate">{slotRelPath(slot.index)}</span>
        </PopoverRow>
        <PopoverRow danger disabled={!slot.filled} onClick={onClear}>
          <Icon name="trash" size={14} />
          <span className="shsec__menu-name">Empty it</span>
        </PopoverRow>
      </PopoverSection>
      <div className="popover__hint">Sending types the note into an agent, never submitted — you press Enter.</div>
    </>
  )
}

/* ----------------------------------------------------------------- helpers */

/** The first empty slot, or slot 1 — what a capture with nowhere named uses. */
function nextEmpty(slots: ShareSlot[]): number {
  return slots.find((s) => !s.filled)?.index ?? 1
}
