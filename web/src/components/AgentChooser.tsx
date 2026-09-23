import { useEffect, useState, type ReactNode } from 'react'
import type { AgentProfile, ClaudePermissionMode, CommandPresence } from '@shared/types'
import {
  effectivePermissionMode,
  permissionSpec,
  profilePermissionModes,
  splitProfiles,
  supportsPermissionModes
} from '@/lib/agents'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { Popover, PopoverRow, PopoverSection } from '@/components/Popover'
import { useMobile } from '../lib/mobile'
import { useForge, useProfiles } from '../state'
import { BottomSheet, SheetRow, SheetSection } from './BottomSheet'
import './Sheets.phone.css'

/**
 * "Open a terminal with…", drawn with the desktop chooser's own `.agent-chooser`
 * classes and its `AgentBadge` and `Popover` primitives.
 *
 * One thing the desktop's has and this one does not, on purpose: **creating a
 * profile**. A profile is a command line, and there is no frame on this wire
 * that carries one — `WebLayoutOp` names a `profileId` the desktop resolves
 * against its own settings, because "nothing on this wire chooses a cwd or an
 * executable". Adding a create form here would mean adding that frame, which is
 * the one thing the protocol's shape refuses.
 *
 * The permission-mode submenu, on the other hand, is here, and it is literally
 * the desktop's: the rungs, their words, their order and which of them is the
 * dangerous one all come out of `profilePermissionModes`, which reads the same
 * `PERMISSION_FAMILIES` table the desk reads. A browser therefore cannot offer a
 * mode this machine would spell differently or refuse to launch. It was left out
 * of the first release on the grounds that nobody had asked for it from a
 * browser; somebody has, and the ladder was never the expensive part —
 * `WebLayoutOp.permissionMode` was already on the wire and already passed
 * through, so all this component had to grow was a second argument on `onPick`
 * carrying the rung the click chose. Leave that argument off and the profile's
 * own default still applies, exactly as it did before.
 *
 * What it keeps is the part that earns its place: the "is this actually
 * installed" column, asked over the `agents` request while the popover is open.
 * A chooser that offers Codex on a machine without Codex is the exact moment the
 * fact is worth having.
 */
export function AgentChooser({
  anchor,
  open,
  onClose,
  onPick,
  title,
  align = 'start',
  selectedId
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  /** One click here opens the pane; the mode, when given, is that open only. */
  onPick: (profileId: string, permissionMode?: ClaudePermissionMode) => void
  /** The heading. Defaults to "Open terminal with" at a desk and "New tab" on a phone. */
  title?: string
  align?: 'start' | 'end' | 'center'
  selectedId?: string
}): ReactNode {
  const { state, actions } = useForge()
  const mobile = useMobile()
  const { shells, agents } = splitProfiles(useProfiles())
  const [presence, setPresence] = useState<CommandPresence[]>([])
  /** Profile id whose permission submenu is showing. */
  const [modeFor, setModeFor] = useState<string | null>(null)

  // A popover that was closed with a ladder hanging open would reopen showing
  // it, which reads as "this is where you left off" for a menu nobody left off
  // anywhere. The desktop's chooser forgets the same thing on the same edge.
  useEffect(() => {
    if (!open) setModeFor(null)
  }, [open])

  /**
   * The command lines to ask about, as one string, so the effect below re-asks
   * when the *set* changes rather than on every push that rebuilds the array.
   * A PATH probe per frame from the desktop would be this chooser making the
   * machine slower the busier it gets.
   */
  const probeKey = agents
    .map((p) => p.command)
    .filter(Boolean)
    .join('\n')

  useEffect(() => {
    if (!open || !probeKey) return
    let cancelled = false
    void actions.request({ kind: 'agents', commands: probeKey.split('\n') }).then((result) => {
      if (cancelled || result.kind !== 'agents') return
      setPresence(result.commands)
    })
    return () => {
      cancelled = true
    }
  }, [open, probeKey, actions])

  const missing = (command: string): boolean => {
    const found = presence.find((p) => p.command === command)
    // `unknown` is the honest third state: a command line that cannot be
    // resolved against PATH must not be labelled "not installed", because that
    // would be a confident lie about a profile that works perfectly.
    return Boolean(found && !found.found && !found.unknown)
  }

  const pick = (profile: AgentProfile, mode?: ClaudePermissionMode): void => {
    onPick(profile.id, mode)
    onClose()
  }

  const row = (profile: AgentProfile): ReactNode => {
    const ladder = supportsPermissionModes(profile)
    // The rung this row would launch on if you simply clicked it — which is what
    // the submenu ticks, and what the chip beside the name is naming.
    const mode = effectivePermissionMode(profile)
    const spec = permissionSpec(profile.command, mode)
    return (
      <div className="agent-chooser__line" key={profile.id}>
        <PopoverRow selected={profile.id === selectedId} onClick={() => pick(profile)}>
          <AgentBadge profile={profile} />
          <span className="agent-chooser__name truncate">{profile.name}</span>
          {missing(profile.command) ? (
            <span
              className="agent-chooser__missing"
              title={`${profile.command} is not on that machine — the pane will open as a shell and tell you how to install it`}
            >
              not installed
            </span>
          ) : spec && spec.chip ? (
            <span className="agent-chooser__mode mono" data-danger={spec.danger ? 'true' : undefined}>
              {spec.chip}
            </span>
          ) : (
            <span className="agent-chooser__cmd mono truncate">{profile.command || 'shell'}</span>
          )}
        </PopoverRow>
        {ladder ? (
          <button
            type="button"
            className="ghost-btn agent-chooser__modes"
            title={`Open ${profile.name} in a different permission mode`}
            aria-expanded={modeFor === profile.id}
            onClick={() => setModeFor(modeFor === profile.id ? null : profile.id)}
          >
            <Icon name="chevronDown" size={12} />
          </button>
        ) : null}

        {modeFor === profile.id ? (
          <div className="agent-chooser__submenu" role="group" aria-label={`${profile.name} permission mode`}>
            {profilePermissionModes(profile).map((m) => (
              <button
                key={m.id}
                type="button"
                className="agent-chooser__mode-row"
                data-danger={m.danger ? 'true' : undefined}
                data-selected={m.id === mode ? 'true' : undefined}
                onClick={() => pick(profile, m.id)}
              >
                <span className="agent-chooser__mode-name">{m.label}</span>
                <span className="agent-chooser__mode-note">{m.note}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  if (mobile) {
    const desktop = state.picture?.desktopName || 'the desktop'
    const project = state.picture?.projects.find((p) => p.id === state.projectId)
    return (
      <ChooserSheet
        open={open}
        onClose={onClose}
        title={title ?? 'New tab'}
        subtitle={project ? `In ${project.name}` : undefined}
        agents={agents}
        shells={shells}
        selectedId={selectedId}
        modeFor={modeFor}
        setModeFor={setModeFor}
        missing={missing}
        desktop={desktop}
        pick={pick}
      />
    )
  }

  const heading = title ?? 'Open terminal with'
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align={align} width={286} label={heading}>
      <PopoverSection title={heading}>{shells.map(row)}</PopoverSection>
      {agents.length > 0 ? <PopoverSection title="Agents">{agents.map(row)}</PopoverSection> : null}
    </Popover>
  )
}

/* ------------------------------------------------------------ the phone sheet */

/** "claude asks before it acts" → "Claude asks before it acts". The ladder's notes are mid-sentence. */
function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/**
 * The chooser as a phone sheet: agents first (on a phone the person almost
 * always wants one), shells last, 56px rows.
 *
 * The permission mode is a second step, not a 20px chevron: an agent that has a
 * ladder carries a pill on its row naming the mode a plain tap opens it in, and
 * the pill opens the ladder in the same sheet — every rung in words, the one it
 * would launch on ticked. Esc and Back step out of the ladder before they close
 * the sheet, the same as the ⋯ sheet's confirm step.
 */
function ChooserSheet({
  open,
  onClose,
  title,
  subtitle,
  agents,
  shells,
  selectedId,
  modeFor,
  setModeFor,
  missing,
  desktop,
  pick
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  agents: AgentProfile[]
  shells: AgentProfile[]
  selectedId?: string
  modeFor: string | null
  setModeFor: (id: string | null) => void
  missing: (command: string) => boolean
  desktop: string
  pick: (profile: AgentProfile, mode?: ClaudePermissionMode) => void
}): ReactNode {
  const ladderFor = modeFor ? (agents.find((p) => p.id === modeFor) ?? null) : null

  if (ladderFor) {
    const current = effectivePermissionMode(ladderFor)
    return (
      <BottomSheet
        open={open}
        onClose={onClose}
        onBack={() => setModeFor(null)}
        label={`Open ${ladderFor.name} in`}
        subtitle="The ticked one is what a plain tap opens. Your pick is for this tab only."
        testId="agent-chooser-sheet"
      >
        <button type="button" className="psheet__back" onClick={() => setModeFor(null)}>
          <Icon name="chevronLeft" size={16} />
          All agents
        </button>
        <SheetSection title="Permission mode">
          {profilePermissionModes(ladderFor).map((m) => (
            <SheetRow
              key={m.id}
              icon={
                <span className="psheet__tick" data-on={m.id === current ? 'true' : undefined} aria-hidden="true">
                  {m.id === current ? <Icon name="check" size={16} /> : null}
                </span>
              }
              label={m.label}
              secondary={sentence(m.note)}
              trailing={
                m.danger ? (
                  <span className="psheet__warn">
                    <WarnGlyph />
                    No guard
                  </span>
                ) : undefined
              }
              onClick={() => pick(ladderFor, m.id)}
              testId={`agent-mode-${m.id}`}
            />
          ))}
        </SheetSection>
      </BottomSheet>
    )
  }

  const row = (profile: AgentProfile): ReactNode => {
    const ladder = supportsPermissionModes(profile)
    const mode = effectivePermissionMode(profile)
    const spec = ladder ? permissionSpec(profile.command, mode) : null
    const absent = missing(profile.command)
    // The mode is the pill's to say; the second line says where the row comes
    // from — the command it runs, and whether it is this project's default.
    const detail = absent ? `Not installed on ${desktop} — opens as a shell` : profile.command || 'The default shell'
    const secondary = profile.id === selectedId ? `Project default · ${detail}` : detail
    return (
      <div className="psheet__line" key={profile.id}>
        <SheetRow
          icon={<AgentBadge profile={profile} />}
          label={profile.name}
          secondary={secondary}
          onClick={() => pick(profile)}
          testId={`agent-row-${profile.id}`}
        />
        {ladder && spec && !absent ? (
          <button
            type="button"
            className="psheet__mode"
            aria-label={`Permission mode for ${profile.name}: ${spec.label}. Change it`}
            onClick={() => setModeFor(profile.id)}
            data-testid={`agent-mode-open-${profile.id}`}
          >
            {spec.danger ? <WarnGlyph /> : null}
            <span>{spec.label}</span>
            <Icon name="chevronRight" size={14} />
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label={title}
      subtitle={subtitle}
      testId="agent-chooser-sheet"
    >
      {agents.length > 0 ? <SheetSection title="Agents">{agents.map(row)}</SheetSection> : null}
      {shells.length > 0 ? <SheetSection title="Shells">{shells.map(row)}</SheetSection> : null}
    </BottomSheet>
  )
}

/** A small outlined triangle with "!" — the shape that says "no guard" beside the words that say it. */
function WarnGlyph(): ReactNode {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 2.2 14.2 13H1.8z" />
      <path d="M8 6.4v3.2M8 11.4v.1" />
    </svg>
  )
}
