import { useState, type ReactNode } from 'react'
import { DEFAULT_FOREMAN_BRIEF, FOREMAN_BRIEF_MAX } from '@shared/foreman'
import { useApp } from '@/state/AppState'
import { Card, Row, Section } from './parts'

/**
 * Foreman's own settings: which model drives, and the house rules it drives by.
 *
 * Deliberately two things and no switch. Foreman is switched on per pane, from
 * the pane's own header, because "is something else typing into this terminal"
 * is a property of that terminal and belongs where you can see it — a global
 * on/off here would be a setting you could forget you had left on.
 */

/**
 * Aliases, not pinned ids — the CLI resolves an alias to whatever is current
 * and a pinned id here would quietly go stale. See `foremanModel` in
 * shared/types.ts.
 *
 * The Claude three only. The voice brain's picker also offers GPT-5.6 Luna,
 * which is a *codex* route (electron/voice-agent/host.ts), and Foreman has no
 * such route: it is an Agent SDK session and nothing else. Offering it here
 * would be offering something that cannot start.
 */
const FOREMAN_MODELS = [
  { id: 'opus', label: 'Opus — smartest, the default' },
  { id: 'sonnet', label: 'Sonnet — faster, lighter on usage' },
  { id: 'haiku', label: 'Haiku — lightest' }
]

/**
 * The recycled sessions that carry the job between step boundaries. A separate
 * list because "the default" means something different here: the seed session
 * above has already done the deciding by the time these take over.
 */
const FOREMAN_DRIVE_MODELS = [
  { id: 'sonnet', label: 'Sonnet — the default between steps' },
  { id: 'opus', label: 'Opus — same as the seed model' },
  { id: 'haiku', label: 'Haiku — lightest' }
]

export function ForemanSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings

  return (
    <Section
      title="Foreman"
      blurb="Switch Foreman on in a Claude pane's header and it takes one line about the job, writes the brief itself, answers every question the pane comes back with, hires other agents when a job suits them, and stops when it judges the work finished. Switching it off hands you the keyboard mid-sentence."
    >
      <Card
        title="Model"
        hint="No key to enter: Foreman signs in with the `claude` login already on this machine, the same subscription every Forge pane uses. Changing this takes effect the next time a job starts."
      >
        <Row label="Which model drives" hint="It is making the decisions a person would otherwise be making, so Opus is the default.">
          <select
            className="select"
            value={s.foremanModel}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.patchSettings({ foremanModel: e.target.value })}
          >
            {FOREMAN_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Driving model (between steps)"
          hint="A long job hands its session over at every step boundary to keep context lean, and the sessions that carry it from there run on this. Your own mid-job messages always go back to the model above."
        >
          <select
            className="select"
            value={s.foremanDriveModel}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.patchSettings({ foremanDriveModel: e.target.value })}
          >
            {FOREMAN_DRIVE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
      </Card>

      <StandingBriefCard />
    </Section>
  )
}

/**
 * The standing brief.
 *
 * Its own component because a textarea cannot commit on blur alone and stay
 * honest: an 8 KB field you have half-rewritten must not lose the edit when a
 * push from somewhere else re-renders the page. So it holds a draft while it
 * has focus and tracks the store the rest of the time — the same contract
 * `TextField` in ./parts.tsx keeps for a one-line field.
 */
function StandingBriefCard(): ReactNode {
  const { state, actions } = useApp()
  const brief = state.settings.foremanBrief
  const [draft, setDraft] = useState(brief)
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : brief
  const isDefault = brief.trim() === DEFAULT_FOREMAN_BRIEF.trim()

  return (
    <Card
      title="Standing brief"
      actions={
        <button
          type="button"
          className="ghost-btn"
          disabled={isDefault}
          title="Put back the brief a fresh install starts with"
          onClick={() => {
            setDraft(DEFAULT_FOREMAN_BRIEF)
            setEditing(false)
            actions.patchSettings({ foremanBrief: DEFAULT_FOREMAN_BRIEF })
          }}
        >
          Reset to default
        </button>
      }
      hint={`${shown.length.toLocaleString()} of ${FOREMAN_BRIEF_MAX.toLocaleString()} characters. Saved when you click away.`}
    >
      <p className="scard__hint sbrief__blurb">
        Foreman reads this at the start of every job, whatever the seed said. House rules and stack preferences go
        here — which backend new work uses, how a job is planned before it is built, what has to be green before
        anything counts as finished. Write it as instructions to Foreman rather than as notes about you: it is read by
        a model that is about to make decisions. Leaving it empty is a valid answer, and means “use your judgement”.
      </p>
      <textarea
        className="sbrief mono"
        value={shown}
        spellCheck={false}
        rows={14}
        maxLength={FOREMAN_BRIEF_MAX}
        aria-label="Foreman’s standing brief"
        // The global shortcut map listens in the capture phase and would read a
        // typed "w" as close-pane.
        onKeyDown={(e) => e.stopPropagation()}
        onFocus={() => {
          setDraft(brief)
          setEditing(true)
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (draft !== brief) actions.patchSettings({ foremanBrief: draft })
        }}
      />
    </Card>
  )
}
