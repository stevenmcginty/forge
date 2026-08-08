import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  allToolSpecs,
  customToolId,
  displayLatest,
  installCommandFor,
  isNewer,
  KNOWN_TOOLS,
  latestSourceLabel,
  MAX_CUSTOM_TOOLS,
  relativeTime,
  sanitiseCustomTool,
  updateCommandFor
} from '@shared/tools'
import type { ToolId, ToolLatest, ToolProbe, ToolSpec, UpdateStatus } from '@shared/types'
import { whatsNew } from '@/lib/whatsnew'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Card, Row, Section, StateChip, TextField, Toggle, type ChipTone } from './parts'

/**
 * What is installed, what is available, and one button per row that puts the
 * real update command in a real terminal.
 *
 * The design decision worth defending: **the Update button does not run
 * anything.** It opens a pane titled `update: PowerShell`, types
 * `winget upgrade --id Microsoft.PowerShell --exact` into it, and stops with the
 * cursor at the end of the line. You press Enter.
 *
 * That is not timidity, it is where the responsibility belongs. Installing
 * software is the one action on this page with consequences outside Forge, and
 * a settings button is a bad place to hide it — but a *terminal* is exactly the
 * right place for it, because the output, the prompts and the failure are all
 * things you were going to need to see anyway. The button removes the typing,
 * not the decision. `updatesAutoRun` flips it for anyone who disagrees.
 *
 * The second decision: **the list is not ours to close.** Every row here — the
 * five Forge ships with, the twelve it suggests, and anything typed into "Add
 * your own" — is the same `ToolSpec` running through the same probe, the same
 * check and the same button. A tool released next month is a row, not a patch.
 *
 * Installed and latest are fetched separately and on purpose: the local probes
 * come back in milliseconds and the network ones do not, so the page is never
 * blank waiting on registry.npmjs.org.
 */
export function UpdatesSection(): ReactNode {
  const { state, actions } = useApp()
  const [probes, setProbes] = useState<ToolProbe[] | null>(null)
  const [latest, setLatest] = useState<Map<ToolId, ToolLatest>>(new Map())
  const [checking, setChecking] = useState<Set<ToolId>>(new Set())
  const [checkedAt, setCheckedAt] = useState(0)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [editing, setEditing] = useState<ToolId | null>(null)
  const [adding, setAdding] = useState(false)

  const customTools = useMemo(() => state.settings.customTools ?? [], [state.settings.customTools])
  const specs = useMemo(() => allToolSpecs(customTools), [customTools])

  /**
   * What the probes and checks below are answers *to*. Adding a tool, or editing
   * the package name of one, has to re-ask — and nothing else should. Comparing
   * the specs themselves would re-run on every render, since `allToolSpecs`
   * builds a new array each time.
   */
  const catalogueKey = useMemo(
    () =>
      specs
        .map((s) => `${s.id}:${s.command}:${s.latest.npmPackage ?? ''}:${(s.latest.wingetIds ?? []).join(',')}`)
        .join('|'),
    [specs]
  )

  useEffect(() => {
    void window.forge.updates.status().then(setUpdate)
    return window.forge.updates.onStatus(setUpdate)
  }, [])

  /**
   * Probe, and keep asking until the answer covers the list.
   *
   * A tool added a second ago is in the renderer's settings immediately and in
   * settings.json 200ms later — AppState writes on a debounce — while main
   * builds its catalogue by *reading* settings.json. So the first probe after an
   * add can come back without the new row in it. Retrying until the answer is
   * complete is the fix that does not require this section to know about the
   * debounce, the store, or which of the two is currently ahead.
   */
  useEffect(() => {
    let cancelled = false
    const wanted = specs.map((s) => s.id)

    const load = (attempt: number): void => {
      void window.forge.tools.probe().then((rows) => {
        if (cancelled) return
        setProbes(rows)
        const missing = wanted.some((id) => !rows.some((r) => r.id === id))
        if (missing && attempt < 5) setTimeout(() => load(attempt + 1), 300)
      })
    }
    load(0)

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogueKey])

  // `refresh: false`, so this is the session cache if there is one and a real
  // check if there is not. Arriving on the tab a second time costs nothing;
  // arriving on it the first time fills the column in without being asked,
  // which is the difference between a page and a form. A newly added tool is
  // the only thing not in that cache, so adding one costs exactly one request.
  useEffect(() => {
    let cancelled = false
    const wanted = specs.map((s) => s.id)

    const load = (attempt: number): void => {
      void window.forge.tools.latest(null, false).then((rows) => {
        if (cancelled) return
        setLatest((prev) => {
          const next = new Map(prev)
          for (const row of rows) next.set(row.id, row)
          return next
        })
        setCheckedAt(Math.max(0, ...rows.map((r) => r.checkedAt)))
        // Same race as the probe above, and the same answer.
        const missing = wanted.some((id) => !rows.some((r) => r.id === id))
        if (missing && attempt < 5) setTimeout(() => load(attempt + 1), 300)
      })
    }
    load(0)

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogueKey])

  const check = useCallback(
    async (ids: ToolId[] | null) => {
      const marking = ids ?? specs.map((t) => t.id)
      setChecking((prev) => new Set([...prev, ...marking]))
      try {
        const rows = await window.forge.tools.latest(ids, true)
        setLatest((prev) => {
          const next = new Map(prev)
          for (const row of rows) next.set(row.id, row)
          return next
        })
        setCheckedAt(Date.now())
      } finally {
        setChecking((prev) => {
          const next = new Set(prev)
          for (const id of marking) next.delete(id)
          return next
        })
      }
    },
    [specs]
  )

  /* ------------------------------------------------------ custom tool edits */

  const saveTool = useCallback(
    (raw: unknown): boolean => {
      const clean = sanitiseCustomTool(raw)
      if (!clean) return false
      const existing = customTools.some((t) => t.id === clean.id)
      if (!existing && customTools.length >= MAX_CUSTOM_TOOLS) return false
      actions.patchSettings({
        customTools: existing ? customTools.map((t) => (t.id === clean.id ? clean : t)) : [...customTools, clean]
      })
      return true
    },
    [actions, customTools]
  )

  const removeTool = useCallback(
    (id: ToolId) => {
      actions.patchSettings({ customTools: customTools.filter((t) => t.id !== id) })
      setEditing((open) => (open === id ? null : open))
    },
    [actions, customTools]
  )

  /* ------------------------------------------------------------- everything */

  const rechecking = checking.size > 0

  /**
   * The rows that are behind, each with the command that fixes it.
   *
   * Joined with `;` into one line rather than one pane per tool: four panes
   * each wanting a keypress is not "update everything", it is homework. One
   * line in one shell, still unsubmitted, still readable end to end.
   */
  const pending = useMemo(() => {
    return specs
      .map((spec) => ({
        spec,
        command: updateCommandFor(spec, latest.get(spec.id) ?? null),
        behind: isNewer(latest.get(spec.id)?.latest, probes?.find((p) => p.id === spec.id)?.version)
      }))
      .filter((row) => row.behind && row.command)
  }, [specs, latest, probes])

  const knownToAdd = useMemo(() => {
    const have = new Set(specs.map((s) => s.id))
    const haveCommands = new Set(specs.map((s) => s.command.toLowerCase()))
    return KNOWN_TOOLS.filter((k) => !have.has(customToolId(k.id)) && !haveCommands.has(k.command.toLowerCase()))
  }, [specs])

  return (
    <Section
      title="Updates & tools"
      blurb="The command-line tools Forge runs in its panes, whatever else you want kept current, and Forge itself. Nothing on this page installs anything on its own."
    >
      <Card
        title="Installed tools"
        actions={
          <>
            {pending.length > 1 ? (
              <button
                type="button"
                className="ghost-btn sbtn stool__update"
                data-behind="true"
                title={pending.map((p) => p.command).join('; ')}
                onClick={() =>
                  actions.openToolPane('update: everything', pending.map((p) => p.command).join('; '))
                }
              >
                <Icon name="terminal" size={12} />
                Update all {pending.length}
              </button>
            ) : null}
            <button
              type="button"
              className="ghost-btn sbtn"
              title="Re-read every version from this machine"
              onClick={() => void window.forge.tools.probe(true).then(setProbes)}
            >
              <Icon name="restart" size={12} />
              Re-probe
            </button>
            <button
              type="button"
              className="ghost-btn sbtn"
              disabled={rechecking}
              title="Ask winget and the npm registry what the latest versions are"
              onClick={() => void check(null)}
            >
              <Icon name="restart" size={12} />
              {rechecking ? 'Checking…' : 'Check all'}
            </button>
          </>
        }
        hint={
          <>
            Latest versions come from <span className="mono">winget</span> and{' '}
            <span className="mono">registry.npmjs.org</span> — one call per tool per check, no data sent, nothing
            installed. Last checked {relativeTime(checkedAt)}. Offline simply means the right-hand column stays empty.
          </>
        }
      >
        <ul className="stool">
          {specs.map((spec) => {
            const row = latest.get(spec.id) ?? null
            return (
              <ToolRow
                key={spec.id}
                spec={spec}
                probe={probes?.find((p) => p.id === spec.id) ?? null}
                latest={row}
                busy={checking.has(spec.id)}
                open={editing === spec.id}
                onCheck={() => void check([spec.id])}
                onUpdate={(command) => actions.openToolPane(`update: ${spec.name}`, command)}
                onInstall={(command) => actions.openToolPane(`install: ${spec.name}`, command)}
                onEdit={() => setEditing(editing === spec.id ? null : spec.id)}
                onSave={(next) => {
                  if (saveTool(next)) setEditing(null)
                }}
                onRemove={() => removeTool(spec.id)}
              />
            )
          })}
        </ul>
      </Card>

      <Card
        title="Add a tool"
        actions={
          <button type="button" className="ghost-btn sbtn" onClick={() => setAdding((v) => !v)}>
            <Icon name="plus" size={12} />
            {adding ? 'Close' : 'Add your own'}
          </button>
        }
        hint={
          <>
            Anything with a <span className="mono">--version</span> and a package behind it can be a row: it gets the
            same check and the same Update button as everything above. {customTools.length} of {MAX_CUSTOM_TOOLS} added.
          </>
        }
      >
        {knownToAdd.length ? (
          <div className="stool__known">
            {knownToAdd.map((known) => (
              <button
                key={known.id}
                type="button"
                className="ghost-btn sbtn stool__add"
                title={`${known.blurb} — checked via ${latestSourceLabel(known.latest.source)}`}
                onClick={() => saveTool({ ...known, id: customToolId(known.id) })}
              >
                <Icon name="plus" size={11} />
                {known.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="scard__hint">Every tool Forge knows to suggest is already on the list.</p>
        )}

        {adding ? (
          <ToolForm
            initial={null}
            onCancel={() => setAdding(false)}
            onSave={(next) => {
              if (saveTool(next)) setAdding(false)
            }}
          />
        ) : null}
      </Card>

      <Card
        title="Update commands"
        tone="quiet"
        hint="Turning this on means a single click in Settings can start installing software. It is off because the command deserves a look before it runs — especially winget's, which may ask about a licence agreement."
      >
        <Row
          label="Press Enter for me"
          hint={
            state.settings.updatesAutoRun
              ? 'The update command runs the moment the pane opens'
              : 'The command is typed and left unsubmitted — you press Enter'
          }
        >
          <Toggle
            checked={state.settings.updatesAutoRun}
            onChange={(next) => actions.patchSettings({ updatesAutoRun: next })}
            label="Run update commands automatically"
          />
        </Row>
      </Card>

      <ForgeUpdateCard
        status={update}
        version={state.info?.version ?? ''}
        onNotes={whatsNew() ? () => actions.setWhatsNewOpen(true) : null}
      />
    </Section>
  )
}

/* ------------------------------------------------------------------- a row */

function ToolRow({
  spec,
  probe,
  latest,
  busy,
  open,
  onCheck,
  onUpdate,
  onInstall,
  onEdit,
  onSave,
  onRemove
}: {
  spec: ToolSpec
  probe: ToolProbe | null
  latest: ToolLatest | null
  busy: boolean
  open: boolean
  onCheck: () => void
  onUpdate: (command: string) => void
  onInstall: (command: string) => void
  onEdit: () => void
  onSave: (next: unknown) => void
  onRemove: () => void
}): ReactNode {
  const installed = probe?.version ?? null
  const behind = isNewer(latest?.latest, installed)
  const here = probe?.found === true
  const updateCommand = updateCommandFor(spec, latest)
  const installCommand = installCommandFor(spec)
  const checkable = spec.latest.source === 'npm' || spec.latest.source === 'winget'

  return (
    <li className="stool__item" data-open={open ? 'true' : undefined}>
      <div className="stool__row" data-behind={behind ? 'true' : undefined}>
        <div className="stool__text">
          <span className="stool__name">
            {spec.name}
            {spec.custom ? <span className="eyebrow stool__tag">added</span> : null}
          </span>
          <span className="stool__blurb">{spec.blurb || spec.command}</span>
        </div>

        <div className="stool__versions">
          <span className="stool__version mono" title={probe?.path ?? probe?.error ?? ''}>
            {installedLabel(spec, probe)}
          </span>
          <span className="stool__arrow" aria-hidden="true">
            →
          </span>
          <span className="stool__version stool__version--latest mono">{latestLabel(spec, probe, latest, busy)}</span>
        </div>

        <StateChip tone={tone(probe, latest, behind)}>{chip(probe, latest, behind)}</StateChip>

        <div className="stool__actions">
          {checkable ? (
            <button
              type="button"
              className="ghost-btn sbtn"
              disabled={busy}
              title={`Check ${latestSourceLabel(spec.latest.source)} for a newer ${spec.name}`}
              onClick={onCheck}
            >
              Check
            </button>
          ) : null}

          {/*
            Installed and updatable, or not installed and installable — never
            both, and never a button that would type a command at something
            that is not there. A tool with neither (Kimi, a local shim) simply
            has no button, which is the honest answer rather than a disabled
            one that invites a hover to find out why.

            Both are gated on the probe having *answered*. Until it has, the row
            knows nothing, and "nothing" must not render as Install — a freshly
            added row offering to install something already on the machine is
            the one wrong button this list can show.
          */}
          {here && updateCommand ? (
            <button
              type="button"
              className="ghost-btn sbtn stool__update"
              data-behind={behind ? 'true' : undefined}
              title={`Open a pane with “${updateCommand}” typed in it`}
              onClick={() => onUpdate(updateCommand)}
            >
              <Icon name="terminal" size={12} />
              Update
            </button>
          ) : null}

          {probe && !here && installCommand ? (
            <button
              type="button"
              className="ghost-btn sbtn"
              title={`Open a pane with “${installCommand}” typed in it`}
              onClick={() => onInstall(installCommand)}
            >
              <Icon name="terminal" size={12} />
              Install
            </button>
          ) : null}

          {spec.custom ? (
            <button
              type="button"
              className="ghost-btn sbtn"
              aria-expanded={open}
              title={`Edit the ${spec.name} row`}
              onClick={onEdit}
            >
              <Icon name="chevronDown" size={12} className={open ? 'stool__chev stool__chev--open' : 'stool__chev'} />
            </button>
          ) : null}
        </div>
      </div>

      {open ? <ToolForm initial={spec} onSave={onSave} onCancel={onEdit} onRemove={onRemove} /> : null}
    </li>
  )
}

function installedLabel(spec: ToolSpec, probe: ToolProbe | null): string {
  if (!probe) return '…'
  if (!probe.found) return 'not installed'
  if (probe.version) return probe.version
  // A tool we deliberately never ask for a version — Kimi, or a custom row
  // whose version arguments were left blank. "on PATH" is the whole truth about
  // it, and an ellipsis that never resolves is not.
  if (!spec.versionArgs) return 'on PATH'
  return probe.error ? 'installed' : '…'
}

function latestLabel(spec: ToolSpec, probe: ToolProbe | null, latest: ToolLatest | null, busy: boolean): string {
  if (busy) return 'checking…'
  if (spec.latest.source === 'local') return 'managed locally'
  if (spec.latest.source === 'none') return 'not checked'
  if (!latest) return '—'
  if (latest.latest) return displayLatest(latest.latest, probe?.version)
  return latest.error ?? '—'
}

function tone(probe: ToolProbe | null, latest: ToolLatest | null, behind: boolean): ChipTone {
  if (!probe) return 'off'
  if (!probe.found) return 'off'
  if (behind) return 'warn'
  if (latest?.latest && probe.version) return 'ok'
  return 'soon'
}

function chip(probe: ToolProbe | null, latest: ToolLatest | null, behind: boolean): string {
  if (!probe) return '…'
  if (!probe.found) return 'not found'
  if (behind) return 'update'
  if (latest?.latest && probe.version) return 'current'
  return 'installed'
}

/* --------------------------------------------------------------- the form */

interface ToolDraft {
  name: string
  blurb: string
  command: string
  versionArgs: string
  source: 'npm' | 'winget' | 'none'
  pkg: string
  updateCommand: string
  installCommand: string
}

function toDraft(spec: ToolSpec | null): ToolDraft {
  return {
    name: spec?.name ?? '',
    blurb: spec?.blurb ?? '',
    command: spec?.command ?? '',
    versionArgs: (spec ? (spec.versionArgs ?? []) : ['--version']).join(' '),
    source: spec?.latest.source === 'npm' || spec?.latest.source === 'winget' ? spec.latest.source : 'none',
    pkg: spec?.latest.npmPackage ?? (spec?.latest.wingetIds ?? []).join(' '),
    updateCommand: spec?.updateCommand ?? '',
    installCommand: spec?.installCommand ?? ''
  }
}

/**
 * A draft as the rest of the app would see it.
 *
 * Deliberately shaped and then handed to the *same* `sanitiseCustomTool` the
 * store uses, rather than validated here: a form that accepts something the
 * store then quietly drops is the worst of both, and there is no second set of
 * rules to keep in step if there is only one set of rules.
 */
function fromDraft(draft: ToolDraft, id: string | null): unknown {
  const args = draft.versionArgs.trim()
  return {
    ...(id ? { id } : {}),
    name: draft.name,
    blurb: draft.blurb,
    command: draft.command,
    // Blank means "never spawn this one", which is a real answer — see Kimi.
    versionArgs: args ? args.split(/\s+/) : null,
    latest:
      draft.source === 'npm'
        ? { source: 'npm', npmPackage: draft.pkg.trim() }
        : draft.source === 'winget'
          ? { source: 'winget', wingetIds: draft.pkg.trim().split(/[\s,]+/).filter(Boolean) }
          : { source: 'none' },
    updateCommand: draft.updateCommand,
    installCommand: draft.installCommand
  }
}

function ToolForm({
  initial,
  onSave,
  onCancel,
  onRemove
}: {
  initial: ToolSpec | null
  onSave: (next: unknown) => void
  onCancel: () => void
  onRemove?: () => void
}): ReactNode {
  const [draft, setDraft] = useState<ToolDraft>(() => toDraft(initial))
  const patch = (next: Partial<ToolDraft>): void => setDraft((d) => ({ ...d, ...next }))

  const raw = fromDraft(draft, initial?.id ?? null)
  // The row as it will actually be stored — which is also the only honest way
  // to show what the buttons will type, since both are derived from it.
  const preview = sanitiseCustomTool(raw)
  const id = `tool-${initial?.id ?? 'new'}`

  return (
    <div className="stool__edit">
      <Row label="Name" htmlFor={`${id}-name`}>
        <TextField
          id={`${id}-name`}
          value={draft.name}
          onCommit={(name) => patch({ name })}
          placeholder="Codex CLI"
        />
      </Row>

      <Row label="Command" hint="What to look for on PATH — a program name, nothing more" htmlFor={`${id}-cmd`}>
        <TextField
          id={`${id}-cmd`}
          value={draft.command}
          onCommit={(command) => patch({ command })}
          placeholder="codex"
          mono
        />
      </Row>

      <Row
        label="Version arguments"
        hint="Blank means never run it — right for a shim that would launch something else"
        htmlFor={`${id}-args`}
      >
        <TextField
          id={`${id}-args`}
          value={draft.versionArgs}
          onCommit={(versionArgs) => patch({ versionArgs })}
          placeholder="--version"
          mono
        />
      </Row>

      <Row label="Updates come from" hint="Where “latest” is looked up, and what the buttons type">
        <select
          className="select"
          value={draft.source}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => patch({ source: e.target.value as ToolDraft['source'] })}
        >
          <option value="npm">npm registry</option>
          <option value="winget">winget</option>
          <option value="none">nothing — just tell me it is installed</option>
        </select>
      </Row>

      {draft.source !== 'none' ? (
        <Row
          label={draft.source === 'npm' ? 'Package' : 'winget id'}
          hint={
            draft.source === 'npm'
              ? 'Exactly as npm spells it'
              : 'From `winget search` — more than one, space separated, if the package is split'
          }
          htmlFor={`${id}-pkg`}
        >
          <TextField
            id={`${id}-pkg`}
            value={draft.pkg}
            onCommit={(pkg) => patch({ pkg })}
            placeholder={draft.source === 'npm' ? '@openai/codex' : 'Git.Git'}
            mono
          />
        </Row>
      ) : null}

      <Row
        label="Update command"
        hint="Only if the obvious one is wrong — Claude Code needs `claude update`, not npm"
        htmlFor={`${id}-update`}
      >
        <TextField
          id={`${id}-update`}
          value={draft.updateCommand}
          onCommit={(updateCommand) => patch({ updateCommand })}
          placeholder={(preview && updateCommandFor(preview)) || 'nothing to type'}
          mono
        />
      </Row>

      <Row label="Install command" hint="Same rule, for when it is not on the machine yet" htmlFor={`${id}-install`}>
        <TextField
          id={`${id}-install`}
          value={draft.installCommand}
          onCommit={(installCommand) => patch({ installCommand })}
          placeholder={(preview && installCommandFor(preview)) || 'nothing to type'}
          mono
        />
      </Row>

      {preview ? (
        <div className="stool__preview">
          <span className="eyebrow">update types</span>
          <code className="mono">{updateCommandFor(preview) ?? '(nothing — no source and no command)'}</code>
        </div>
      ) : (
        <p className="sprof__warn">
          A name and a plain command are the two things a row cannot do without. The command is spawned to read a
          version, so it has to be a program's name — not a pipeline, a redirect or a quoted string.
        </p>
      )}

      <div className="stool__foot">
        {onRemove ? (
          <button
            type="button"
            className="ghost-btn sbtn"
            data-danger="true"
            title="Take this row off the list — it does not uninstall anything"
            onClick={onRemove}
          >
            <Icon name="trash" size={12} />
            Remove
          </button>
        ) : (
          <span />
        )}
        <div className="stool__foot-right">
          <button type="button" className="ghost-btn sbtn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="ghost-btn sbtn" disabled={!preview} onClick={() => onSave(raw)}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- forge itself */

/**
 * Forge's own updates, told honestly.
 *
 * In a dev run this card says so and stops, because a checkout does not update
 * itself and a card implying otherwise would be the beginning of a very bad
 * afternoon. In a packaged build it repeats what the banner says, plus the one
 * thing the banner has no room for: Forge is not code-signed, and an unsigned
 * app replacing its own executable is a shape Windows is entitled to be
 * suspicious of.
 */
function ForgeUpdateCard({
  status,
  version,
  onNotes
}: {
  status: UpdateStatus | null
  version: string
  /** Open the "what's new" card. Null when this build carries no notes. */
  onNotes: (() => void) | null
}): ReactNode {
  const phase = status?.phase ?? 'unsupported'
  const dev = phase === 'unsupported'

  return (
    <Card
      title="Forge itself"
      tone={dev ? 'quiet' : 'plain'}
      actions={
        <>
          {/*
            The permanent way back to the card that appears after an update — and
            the only way to see it at all in a checkout, where the version never
            changes and the automatic trigger therefore never fires.
          */}
          {onNotes ? (
            <button type="button" className="ghost-btn sbtn" title="What changed in this build" onClick={onNotes}>
              <Icon name="note" size={12} />
              What&apos;s new
            </button>
          ) : null}
          {dev ? null : (
            <button type="button" className="ghost-btn sbtn" onClick={() => void window.forge.updates.check()}>
              <Icon name="restart" size={12} />
              Check now
            </button>
          )}
        </>
      }
      hint={
        <>
          Forge is <strong>not code-signed</strong> — there is no certificate behind it. Windows SmartScreen will warn
          about the downloaded installer the same way it warned about the first one, and on a machine with{' '}
          <span className="mono">Smart App Control</span> switched on, an unsigned auto-update can be blocked outright
          with no dialog at all. If that happens, download the release by hand or run from source. Signing is the only
          real fix, and it is the right one for anything actually distributed —{' '}
          <span className="mono">GIVE-TO-A-FRIEND.md</span> has the detail.
        </>
      }
    >
      <Row label="This build">
        <span className="mono srow__readout">{version || '…'}</span>
      </Row>
      <Row
        label="Updates"
        hint={
          dev
            ? 'A checkout updates itself with git, not with an installer'
            : 'Checked on launch and every six hours. Nothing downloads until you say so.'
        }
      >
        <StateChip tone={forgeTone(phase)}>{forgeLabel(status)}</StateChip>
      </Row>
      {status?.error ? <p className="scard__hint">{status.error}</p> : null}
      {status?.simulated ? (
        <p className="scard__hint">
          <span className="mono">FORGE_FAKE_UPDATE</span> is set, so this is a simulation — no release feed is being
          contacted and nothing can be installed.
        </p>
      ) : null}
    </Card>
  )
}

function forgeTone(phase: UpdateStatus['phase']): ChipTone {
  if (phase === 'error') return 'danger'
  if (phase === 'available' || phase === 'ready') return 'warn'
  if (phase === 'unsupported') return 'soon'
  return 'ok'
}

function forgeLabel(status: UpdateStatus | null): string {
  switch (status?.phase) {
    case 'checking':
      return 'checking'
    case 'available':
      return `${status.version} available`
    case 'downloading':
      return `downloading ${status.percent ?? 0}%`
    case 'ready':
      return 'ready to install'
    case 'error':
      return 'check failed'
    case 'idle':
      return 'up to date'
    default:
      return 'dev build'
  }
}
