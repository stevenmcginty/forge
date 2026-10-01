import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { Icon } from '@/components/Icon'
import { slugFor } from '../lib/cache'
import { cloudSessionUrl, githubSlug } from '../lib/cloud'
import { useForge } from '../state'
import { BottomSheet, SheetGlyph, SheetSection } from './BottomSheet'
import './CloudLaunch.css'

/**
 * "Work in the cloud": hand a job to Claude Code on claude.ai/code, which runs
 * it against the project's GitHub repository instead of this PC.
 *
 * Nothing here talks to Anthropic. The sheet builds the pre-fill link
 * (lib/cloud.ts) and "Open Claude" is a plain link, so Android can hand it to
 * the Claude app; the person presses Send there. It works with the desktop
 * asleep — the projects come from the cached picture then.
 */

/** The project last sent to the cloud from this browser. */
const LAST_KEY = 'forge-web-cloud-project'

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

function writeLast(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id)
  } catch {
    // Private mode or a full quota: the next open picks the first project instead.
  }
}

export interface CloudProject {
  id: string
  name: string
  /** `owner/repo`, or null when the project has no GitHub remote this page knows of. */
  slug: string | null
}

/**
 * The sheet, wired to the app: live projects while the desktop answers, the
 * cached ones while it does not. `projectId` is the project it opens on.
 */
export function CloudLaunch({
  open,
  projectId,
  onClose
}: {
  open: boolean
  projectId?: string | null
  onClose: () => void
}): ReactNode {
  const { state } = useForge()
  const projects = state.picture?.projects ?? state.cached?.projects ?? []
  return (
    <CloudLaunchSheet
      open={open}
      projectId={projectId}
      projects={cloudProjects(projects, (id) => slugFor(state.cached, id))}
      onClose={onClose}
    />
  )
}

/** Each project's repository: its saved remote first, then the slug git last reported. */
export function cloudProjects(
  projects: Project[],
  knownSlug: (projectId: string) => string | null | undefined = () => undefined
): CloudProject[] {
  return projects
    .filter((p) => p.kind !== 'brain')
    .map((p) => ({ id: p.id, name: p.name, slug: githubSlug(p.repoUrl) ?? knownSlug(p.id) ?? null }))
}

/** Where the picker starts: the project asked for, else the last one used, else the first with a repository. */
function startChoice(projects: CloudProject[], asked: string | null | undefined): string | null {
  const choosable = (id: string | null | undefined): boolean => !!id && projects.some((p) => p.id === id && p.slug)
  // Opened from a project with no GitHub link: let Claude ask, rather than quietly pick another project.
  if (asked) return choosable(asked) ? asked : null
  const last = readLast()
  if (choosable(last)) return last
  return projects.find((p) => p.slug)?.id ?? null
}

export function CloudLaunchSheet({
  open,
  projectId,
  projects,
  onClose
}: {
  open: boolean
  projectId?: string | null
  projects: CloudProject[]
  onClose: () => void
}): ReactNode {
  const [choice, setChoice] = useState<string | null>(null)
  const [task, setTask] = useState('')
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  // Chosen afresh on every open; the task is kept until it is sent.
  useEffect(() => {
    if (open) setChoice(startChoice(projectsRef.current, projectId))
  }, [open, projectId])

  const append = useCallback((words: string) => {
    setTask((t) => (t && !/\s$/.test(t) ? `${t} ` : t) + words)
  }, [])
  const speech = useSpeech(open, append)

  const chosen = projects.find((p) => p.id === choice && p.slug) ?? null
  const href = cloudSessionUrl({ prompt: task, repo: chosen?.slug ?? null })

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label="Work in the cloud"
      subtitle="Claude opens with your task. Tap Send there. It works on GitHub, not your PC."
      testId="cloud-launch"
    >
      <SheetSection title="Project">
        <div role="radiogroup" aria-label="Project">
          {projects.map((p) => {
            const here = choice === p.id && !!p.slug
            return (
              <button
                key={p.id}
                type="button"
                className="bsrow cloudl__pick"
                role="radio"
                aria-checked={here}
                data-current={here ? 'true' : undefined}
                disabled={!p.slug}
                onClick={() => setChoice(p.id)}
                data-testid="cloud-project"
              >
                <span className="bsrow__text">
                  <span className="bsrow__label">{p.name}</span>
                  <span className="bsrow__sub">
                    {p.slug ? <span className="mono">{p.slug}</span> : 'no GitHub link'}
                  </span>
                </span>
                <span className="bsrow__trail cloudl__tick" aria-hidden="true">
                  {here ? <Icon name="check" size={20} /> : null}
                </span>
              </button>
            )
          })}
          <button
            type="button"
            className="bsrow cloudl__pick"
            role="radio"
            aria-checked={choice === null}
            data-current={choice === null ? 'true' : undefined}
            onClick={() => setChoice(null)}
            data-testid="cloud-project-none"
          >
            <span className="bsrow__text">
              <span className="bsrow__label">Pick the repo in Claude</span>
            </span>
            <span className="bsrow__trail cloudl__tick" aria-hidden="true">
              {choice === null ? <Icon name="check" size={20} /> : null}
            </span>
          </button>
        </div>
      </SheetSection>

      <SheetSection title="Task">
        <div className="cloudl__task">
          <textarea
            className="cloudl__input"
            rows={4}
            placeholder="What should Claude do?"
            aria-label="Task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            data-testid="cloud-task"
          />
          {speech.interim ? (
            <p className="cloudl__interim" aria-live="polite">
              {speech.interim}
            </p>
          ) : null}
          {speech.blocked ? (
            <p className="cloudl__note" role="status">
              {speech.blocked}
            </p>
          ) : null}
          {speech.supported ? (
            <button
              type="button"
              className="bsbtn cloudl__mic"
              aria-pressed={speech.listening}
              data-listening={speech.listening ? 'true' : undefined}
              onClick={speech.listening ? speech.stop : speech.start}
              data-testid="cloud-mic"
            >
              {speech.listening ? <SheetGlyph name="stop" size={18} /> : <Icon name="mic" size={18} />}
              {speech.listening ? 'Stop' : 'Speak'}
            </button>
          ) : null}
        </div>
      </SheetSection>

      <div className="cloudl__go">
        <button type="button" className="bsbtn" onClick={onClose} data-testid="cloud-close">
          Close
        </button>
        <a
          className="bsbtn cloudl__open"
          data-tone="act"
          href={href}
          target="_blank"
          rel="noopener"
          onClick={() => {
            if (chosen) writeLast(chosen.id)
            speech.stop()
            setTask('')
            onClose()
          }}
          data-testid="cloud-open"
        >
          <SheetGlyph name="cloud" size={20} />
          Open Claude
        </a>
      </div>
    </BottomSheet>
  )
}

/* ------------------------------------------------------------ dictation */

/** The slice of the Web Speech API used here; Chrome still ships it as `webkitSpeechRecognition`. */
interface Recogniser {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecogniserEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface RecogniserEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

type RecogniserCtor = new () => Recogniser

function recogniserCtor(): RecogniserCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecogniserCtor; webkitSpeechRecognition?: RecogniserCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * The browser's own speech to text, into the task box. Final words go to
 * `onFinal`; the words still being heard are shown under the box. Stopped when
 * the sheet closes. A mic the browser refuses hides the button for good and
 * says so in one line.
 */
function useSpeech(
  open: boolean,
  onFinal: (words: string) => void
): { supported: boolean; listening: boolean; interim: string; blocked: string; start: () => void; stop: () => void } {
  const [ctor] = useState(recogniserCtor)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [blocked, setBlocked] = useState('')
  const recRef = useRef<Recogniser | null>(null)
  const finalRef = useRef(onFinal)
  finalRef.current = onFinal

  const stop = useCallback(() => {
    const rec = recRef.current
    recRef.current = null
    if (rec) {
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
      rec.abort()
    }
    setListening(false)
    setInterim('')
  }, [])

  const start = useCallback(() => {
    if (!ctor || recRef.current) return
    let rec: Recogniser
    try {
      rec = new ctor()
    } catch {
      setBlocked('Speech is not available here. Type the task instead.')
      return
    }
    rec.lang = 'en-GB'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (event) => {
      let heard = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const words = result[0].transcript
        if (result.isFinal) {
          if (words.trim()) finalRef.current(words.trim())
        } else {
          heard += words
        }
      }
      setInterim(heard.trim())
    }
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setBlocked('The mic is blocked for this page. Type the task instead.')
      }
    }
    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null
      setListening(false)
      setInterim('')
    }
    recRef.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      recRef.current = null
    }
  }, [ctor])

  useEffect(() => {
    if (!open) stop()
  }, [open, stop])
  useEffect(() => stop, [stop])

  return { supported: !!ctor && !blocked, listening, interim, blocked, start, stop }
}
