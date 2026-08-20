import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  GitHub,
  asFailure,
  assertWebBranch,
  defaultWebBranch,
  type Shelf,
  isSlug,
  type GitHubFailure,
  type RepoInfo,
  type TreeEntry
} from './github'
import { slugFor } from './cache'
import { useForge } from '../state'

/**
 * GitHub mode's state: everything the browser knows about a repository when the
 * desktop is off, and the one seam its four screens read through.
 *
 * The shape mirrors web/src/state.tsx on purpose, because the two are the same
 * product in two conditions: a *stage* that is first-class rather than a
 * spinner, a picture that arrives from exactly one place, and a cache of that
 * picture so the second visit is not another six round trips. What is different
 * is where the picture comes from — a socket to Steve's PC there, GitHub's REST
 * API here — and that difference is the honest limitation docs/forge-web.md
 * states in as many words: this is Forge's *shell*, not Forge's *powers*. There
 * is no terminal in this file and no agent, because there is no computer to run
 * one.
 *
 * ## Which repository, and how this page knows
 *
 * From `GitSnapshot.slug` — `owner/repo`, "only when remoteUrl is a github.com
 * URL", which is the same field `electron/git/gh.ts` gates every `gh` call on.
 * It reaches the browser in a `git` push and is written into the offline
 * snapshot (see `slugFor` in lib/cache.ts), so a desktop that is off can still
 * say which repository the project it was showing belongs to. A project whose
 * snapshot had no slug says so; a project this browser has never seen git for
 * says something different, because they are different facts.
 *
 * ## The token
 *
 * A fine-grained personal access token, pasted by a human, held in this browser
 * and nowhere else. It is deliberately *not* an OAuth device flow: GitHub's
 * device and token endpoints send no CORS headers, so the exchange cannot be
 * completed without a server, and Forge Web has no server of its own by
 * decision 12.
 *
 * That choice has a consequence this module refuses to hide: **a token in
 * browser storage is a capability against those repositories for as long as it
 * lives.** So it is kept under its own key rather than anywhere near the offline
 * snapshot, `forget()` genuinely removes it, and `probeReach` exists so the
 * blast radius can be looked at rather than assumed. Nothing here sends the
 * token to the desktop, writes it into the snapshot, or puts it in a message.
 *
 * ## Never lose work
 *
 * Every keystroke in the editor is written to `forge-web-github-drafts` on a
 * short debounce and on `pagehide`. A commit that fails — offline, rate
 * limited, or a branch that moved — leaves the draft exactly where it was, and
 * the editor offers it back. A browser tab that swallows somebody's changes is
 * worse than one that refuses to accept them.
 */

/* ---------------------------------------------------------------- storage */

const TOKEN_KEY = 'forge-web-github-token'
const DRAFTS_KEY = 'forge-web-github-drafts'
const CACHE_KEY = 'forge-web-github-cache'
const CACHE_VERSION = 1

/** How many file bodies the offline cache keeps, newest first. */
const MAX_CACHED_FILES = 24
/** How many trees. One per ref, and two refs is a repo plus its branch. */
const MAX_CACHED_TREES = 4
/** How long an edit sits before it is written down. Short: this is the promise. */
const DRAFT_FLUSH_MS = 400

export interface Draft {
  slug: string
  branch: string
  path: string
  text: string
  /** The blob this edit was made against, so a stale one can be recognised. */
  baseSha: string
  /** The message the person had written when it was last saved. */
  message: string
  at: number
  /** Why the last commit of this draft failed, when one did. */
  failure?: string
}

interface CachedRepo {
  at: number
  info: RepoInfo
  trees: Array<{ ref: string; at: number; truncated: boolean; entries: TreeEntry[] }>
  files: Array<{ ref: string; path: string; at: number; text: string; sha: string }>
}

interface RepoCache {
  version: number
  repos: Record<string, CachedRepo>
}

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function readDrafts(): Draft[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(DRAFTS_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return (value as Draft[]).filter(
      (d) => d && typeof d.slug === 'string' && typeof d.path === 'string' && typeof d.text === 'string'
    )
  } catch {
    return []
  }
}

function writeDrafts(drafts: Draft[]): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  } catch {
    /*
     * Out of quota. Nothing is dropped and nothing is retried smaller, because
     * a draft is the one thing in this client that cannot be re-fetched — the
     * in-memory copy is still on screen and still committable, and quietly
     * shrinking the set here would be this module breaking its own promise.
     */
  }
}

function readCache(): RepoCache {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(CACHE_KEY)
  } catch {
    return { version: CACHE_VERSION, repos: {} }
  }
  if (!raw) return { version: CACHE_VERSION, repos: {} }
  try {
    const value = JSON.parse(raw) as Partial<RepoCache>
    if (value?.version !== CACHE_VERSION || !value.repos) return { version: CACHE_VERSION, repos: {} }
    return { version: CACHE_VERSION, repos: value.repos }
  } catch {
    return { version: CACHE_VERSION, repos: {} }
  }
}

/**
 * Trim and write. Same posture as lib/cache.ts: oldest first, and a quota
 * failure drops the cache rather than throwing into whatever was rendering.
 */
function writeCache(cache: RepoCache): void {
  for (const repo of Object.values(cache.repos)) {
    repo.trees.sort((a, b) => b.at - a.at)
    repo.trees.length = Math.min(repo.trees.length, MAX_CACHED_TREES)
    repo.files.sort((a, b) => b.at - a.at)
    repo.files.length = Math.min(repo.files.length, MAX_CACHED_FILES)
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      /* private mode: this mode still works, it is simply never cached */
    }
  }
}

/* ------------------------------------------------------------------ state */

/** What GitHub mode is doing, before any of the repository detail. */
export type RepoStage =
  /** No project selected in the rail, so there is no repository to name. */
  | { kind: 'no-project' }
  /**
   * This browser has never been told what git thinks of that project — it was
   * never live with the desktop long enough to be sent a `git` push. Not the
   * same as "there is no remote".
   */
  | { kind: 'unknown-remote'; projectName: string }
  /** git was read, and the remote is not a github.com one — or there is none. */
  | { kind: 'no-remote'; projectName: string }
  /** A repository to read, and no token to read it with. */
  | { kind: 'no-token'; slug: string }
  /** Reading. The cached tree, if there is one, is already on screen underneath. */
  | { kind: 'reading'; slug: string }
  /** GitHub said no, in one of nine different ways. */
  | { kind: 'failed'; slug: string; failure: GitHubFailure }
  /** A tree, and a file open or not. */
  | { kind: 'ready'; slug: string }

export interface OpenFile {
  path: string
  /** The ref it was read at. */
  ref: string
  /** The text as GitHub has it. */
  base: string
  /** The text on screen — `base` plus whatever has been typed. */
  text: string
  /** The blob sha this edit is against. */
  sha: string
  /** True when GitHub returned no body because the blob is too large to inline. */
  tooLarge: boolean
  /** True when this came out of the offline cache rather than off the wire. */
  cached: boolean
}

/** One repository this token was asked about, for the "what can it reach" list. */
export interface Reach {
  slug: string
  /** The projects on that desktop that point at it. */
  projects: string[]
  state: 'checking' | 'reachable' | 'refused'
  /** How GitHub described it — "Private, and this token may write" or a refusal. */
  detail: string
}

export interface RepoState {
  stage: RepoStage
  /** True when a token is stored. The token itself is never exposed. */
  hasToken: boolean
  slug: string | null
  info: RepoInfo | null
  /** The branch this mode reads and writes. Always `forge-web/*`. */
  branch: string
  /** Which ref the tree on screen was read at — the branch, the default, or a shelf. */
  ref: string
  /**
   * Set when `ref` is a `forge-wip/*` shelf: the desktop's uncommitted working
   * tree, shelved after a pane went idle, and newer than the default branch.
   * The header names the machine and when, so "why is this not what GitHub
   * shows" has an answer on screen.
   */
  shelf: Shelf | null
  tree: TreeEntry[]
  /** True when GitHub cut the tree at its ceiling. */
  truncated: boolean
  /** True when the tree on screen came out of the cache. */
  treeCached: boolean
  /**
   * A read that failed *over* a listing already on screen — the cached tree is
   * still true as of when it was taken, so this is a strip above it rather than
   * a screen instead of it.
   */
  warning: GitHubFailure | null
  open: OpenFile | null
  /** Failure of the last file open, which is not the same as the tree's. */
  fileFailure: GitHubFailure | null
  drafts: Draft[]
  committing: boolean
  commitFailure: GitHubFailure | null
  /** Set when GitHub had a different blob than this edit was made against. */
  conflict: { path: string; theirSha: string } | null
  /** The last commit this browser landed, so the desktop can be told what to pull. */
  landed: { sha: string; branch: string; path: string } | null
  reach: Reach[]
}

export interface RepoActions {
  saveToken: (token: string) => void
  forgetToken: () => void
  probeReach: () => void
  setBranch: (branch: string) => void
  refresh: () => void
  openFile: (path: string) => void
  closeFile: () => void
  edit: (text: string) => void
  revert: () => void
  commit: (message: string) => Promise<void>
  /** Take GitHub's version of the file, abandoning this edit. */
  takeTheirs: () => void
  /** Re-base this edit on GitHub's current blob and try again. */
  keepMine: () => void
  discardDraft: (path: string) => void
  restoreDraft: (path: string) => void
}

const RepoContext = createContext<{ state: RepoState; actions: RepoActions } | null>(null)

export function useRepo(): { state: RepoState; actions: RepoActions } {
  const value = useContext(RepoContext)
  if (!value) throw new Error('useRepo outside <RepoProvider>')
  return value
}

/* --------------------------------------------------------------- provider */

export function RepoProvider({ children }: { children: ReactNode }): ReactNode {
  const { state: forge } = useForge()
  const apiBase = forge.config?.githubApiBase ?? ''
  /**
   * Inert unless the desktop is off. GitHub mode is what this client offers
   * *instead of* a live session, and a provider that fetched trees while a
   * socket was up would be the second source of truth decision 9 exists to
   * avoid — the desktop's working tree is the truth whenever there is one.
   */
  const offline = forge.stage.kind === 'offline'

  const [token, setToken] = useState(() => readToken())
  const [branch, setBranchState] = useState(() => defaultWebBranch())
  const [info, setInfo] = useState<RepoInfo | null>(null)
  const [tree, setTree] = useState<TreeEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [treeCached, setTreeCached] = useState(false)
  const [ref, setRef] = useState('')
  const [reading, setReading] = useState(false)
  const [failure, setFailure] = useState<GitHubFailure | null>(null)
  const [open, setOpen] = useState<OpenFile | null>(null)
  const [fileFailure, setFileFailure] = useState<GitHubFailure | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>(() => readDrafts())
  const [committing, setCommitting] = useState(false)
  const [commitFailure, setCommitFailure] = useState<GitHubFailure | null>(null)
  const [conflict, setConflict] = useState<{ path: string; theirSha: string } | null>(null)
  const [landed, setLanded] = useState<{ sha: string; branch: string; path: string } | null>(null)
  const [shelf, setShelf] = useState<Shelf | null>(null)
  const [reach, setReach] = useState<Reach[]>([])
  const [nonce, setNonce] = useState(0)

  /* ------------------------------------------------- which repository this is */

  const projectId = forge.projectId
  const project = (forge.picture?.projects ?? forge.cached?.projects ?? []).find((p) => p.id === projectId) ?? null
  const remote = slugFor(forge.cached, projectId)
  const slug = typeof remote === 'string' && isSlug(remote) ? remote : null

  const api = useMemo(() => (token ? new GitHub({ token, ...(apiBase ? { apiBase } : {}) }) : null), [token, apiBase])

  /* ---------------------------------------------------------------- reading */

  /**
   * Read the repository: what it is, whether the `forge-web` branch exists yet,
   * and the tree at whichever ref that makes current.
   *
   * The cache is painted *first* and the network answer replaces it, rather than
   * a spinner over an empty pane. This mode exists because the network is the
   * only thing there is, so the second visit to a repository has to be worth
   * something even when GitHub is slow, rate limiting, or unreachable — and a
   * failure that arrives over a tree already on screen is a badge rather than a
   * blank page.
   */
  useEffect(() => {
    if (!offline || !slug || !api) return
    let cancelled = false

    const cached = readCache().repos[slug]
    if (cached) {
      setInfo(cached.info)
      const newest = cached.trees[0]
      if (newest) {
        setTree(newest.entries)
        setTruncated(newest.truncated)
        setRef(newest.ref)
        setTreeCached(true)
      }
    }

    setReading(true)
    setFailure(null)
    void (async () => {
      try {
        const repo = await api.repo(slug)
        if (cancelled) return
        setInfo(repo)

        const branchHead = await api.head(slug, branch)
        if (cancelled) return
        // The branch when it exists, the repository's default when it does not.
        // Reading the default branch is not writing to it: every write below
        // goes through `assertWebBranch`, and there is exactly one branch name
        // in this component.
        /*
         * The forge-web branch when it exists; otherwise the freshest picture of
         * the default branch — which is the desktop's shelf when it pushed one
         * after the last commit to the default branch, and the default branch
         * itself when it did not. docs/GITHUB-FALLBACK-PLAN.md, Phase A.
         */
        let readAt = branchHead ? branch : repo.defaultBranch
        let found: Shelf | null = null
        if (!branchHead) {
          const tip = await api.head(slug, repo.defaultBranch)
          if (cancelled) return
          found = await api.newestShelf(slug, repo.defaultBranch, tip).catch(() => null)
          if (cancelled) return
          if (found) readAt = found.branch
        }
        const listing = await api.tree(slug, readAt)
        if (cancelled) return

        setTree(listing.entries)
        setTruncated(listing.truncated)
        setRef(readAt)
        setShelf(found)
        setTreeCached(false)
        setFailure(null)

        const cache = readCache()
        const entry = cache.repos[slug] ?? { at: 0, info: repo, trees: [], files: [] }
        entry.at = Date.now()
        entry.info = repo
        entry.trees = [
          { ref: readAt, at: Date.now(), truncated: listing.truncated, entries: listing.entries },
          ...entry.trees.filter((t) => t.ref !== readAt)
        ]
        cache.repos[slug] = entry
        writeCache(cache)
      } catch (err) {
        if (!cancelled) setFailure(asFailure(err))
      } finally {
        if (!cancelled) setReading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [offline, slug, api, branch, nonce])

  /* ----------------------------------------------------------------- drafts */

  /**
   * Write the open buffer down, on a short debounce and when the tab is put
   * away. `pagehide` is the one event that fires for a reload, a navigation and
   * a closed tab alike — without it, everything typed since the last tick is
   * lost exactly when it mattered.
   */
  const pending = useRef<Draft | null>(null)
  useEffect(() => {
    /*
     * localStorage first, React state second, and never a write inside a state
     * updater. An updater runs when React decides to render, so a `forget` or a
     * `take theirs` immediately afterwards would read a store that had not been
     * written yet and hand back the draft it was told to drop. The stored set is
     * the truth; `drafts` is a copy of it for rendering.
     */
    const flush = (): void => {
      const draft = pending.current
      if (!draft) return
      pending.current = null
      const next = [draft, ...readDrafts().filter((d) => !sameDraft(d, draft))]
      writeDrafts(next)
      setDrafts(next)
    }
    const timer = window.setInterval(flush, DRAFT_FLUSH_MS)
    window.addEventListener('pagehide', flush)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  /* ---------------------------------------------------------------- actions */

  const dropDraft = useCallback((forSlug: string, forBranch: string, path: string) => {
    pending.current = null
    const next = readDrafts().filter((d) => !(d.slug === forSlug && d.branch === forBranch && d.path === path))
    writeDrafts(next)
    setDrafts(next)
  }, [])

  const loadFile = useCallback(
    async (path: string, at: string, forSlug: string, forBranch: string): Promise<void> => {
      setFileFailure(null)
      const cache = readCache()
      const hit = cache.repos[forSlug]?.files.find((f) => f.ref === at && f.path === path)
      const draft = readDrafts().find((d) => d.slug === forSlug && d.branch === forBranch && d.path === path)

      if (hit) {
        setOpen({
          path,
          ref: at,
          base: hit.text,
          text: draft?.text ?? hit.text,
          sha: draft?.baseSha || hit.sha,
          tooLarge: false,
          cached: true
        })
      } else {
        setOpen({ path, ref: at, base: '', text: draft?.text ?? '', sha: draft?.baseSha ?? '', tooLarge: false, cached: false })
      }
      if (!api) return

      try {
        const file = await api.file(forSlug, path, at)
        setOpen((current) =>
          current && current.path === path
            ? {
                path,
                ref: at,
                base: file.text,
                // A draft outranks what GitHub just said: the person's own
                // unsaved edit is the thing this module promised not to lose.
                text: draft?.text ?? file.text,
                // And it keeps the blob it was *made against*, not the one
                // GitHub has now. Taking the fresh sha here would quietly
                // re-base a recovered edit onto whatever landed while it was
                // stranded, so the next commit would overwrite somebody else's
                // work with no conflict ever being raised.
                sha: draft?.baseSha || file.sha,
                tooLarge: file.tooLarge,
                cached: false
              }
            : current
        )
        // Only into an entry the tree read already made. A repository whose own
        // description has never arrived has nothing to hang a file body off,
        // and inventing a half-filled `RepoInfo` to hold it would put a lie in
        // the cache to save one request.
        const next = readCache()
        const entry = next.repos[forSlug]
        if (entry) {
          entry.files = [
            { ref: at, path, at: Date.now(), text: file.text, sha: file.sha },
            ...entry.files.filter((f) => !(f.ref === at && f.path === path))
          ]
          writeCache(next)
        }
      } catch (err) {
        setFileFailure(asFailure(err))
      }
    },
    [api]
  )

  const actions = useMemo<RepoActions>(
    () => ({
      saveToken: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return
        try {
          localStorage.setItem(TOKEN_KEY, trimmed)
        } catch {
          /* private mode: the token lives for this tab only, which still works */
        }
        setToken(trimmed)
        setFailure(null)
        setReach([])
      },
      forgetToken: () => {
        try {
          localStorage.removeItem(TOKEN_KEY)
        } catch {
          /* nothing to remove */
        }
        setToken('')
        setInfo(null)
        setTree([])
        setOpen(null)
        setReach([])
        setFailure(null)
      },
      probeReach: () => {
        if (!api) return
        const projects = forge.cached?.projects ?? []
        const bySlug = new Map<string, string[]>()
        for (const p of projects) {
          const s = slugFor(forge.cached, p.id)
          if (typeof s !== 'string' || !isSlug(s)) continue
          bySlug.set(s, [...(bySlug.get(s) ?? []), p.name])
        }
        const rows: Reach[] = [...bySlug.entries()].map(([s, names]) => ({
          slug: s,
          projects: names,
          state: 'checking' as const,
          detail: ''
        }))
        setReach(rows)
        for (const row of rows) {
          void api
            .repo(row.slug)
            .then((repo) => {
              setReach((current) =>
                current.map((r) =>
                  r.slug === row.slug
                    ? {
                        ...r,
                        state: 'reachable',
                        detail: `${repo.private ? 'Private' : 'Public'}, default branch ${repo.defaultBranch}${
                          repo.canPush ? ', and this token may write to it' : ', read only for this token'
                        }`
                      }
                    : r
                )
              )
            })
            .catch((err: unknown) => {
              const f = asFailure(err)
              setReach((current) =>
                current.map((r) => (r.slug === row.slug ? { ...r, state: 'refused', detail: f.message } : r))
              )
            })
        }
      },
      setBranch: (value) => {
        const trimmed = value.trim()
        try {
          assertWebBranch(trimmed)
        } catch {
          return
        }
        setBranchState(trimmed)
        setOpen(null)
      },
      refresh: () => setNonce((n) => n + 1),
      openFile: (path) => {
        if (!slug || !ref) return
        void loadFile(path, ref, slug, branch)
      },
      closeFile: () => {
        setOpen(null)
        setFileFailure(null)
        setCommitFailure(null)
        setConflict(null)
      },
      edit: (text) => {
        if (!open || !slug) return
        // Outside the state updater, for the reason `flush` gives: an updater
        // runs when React decides to render, and the draft has to exist the
        // instant it is typed rather than the instant it is painted.
        pending.current = { slug, branch, path: open.path, text, baseSha: open.sha, message: '', at: Date.now() }
        setOpen({ ...open, text })
      },
      revert: () => {
        setOpen((current) => (current ? { ...current, text: current.base } : current))
        if (slug && open) dropDraft(slug, branch, open.path)
      },
      commit: async (message) => {
        if (!api || !slug || !open) return
        setCommitting(true)
        setCommitFailure(null)
        setConflict(null)
        try {
          // The branch first, from the current head, and never the default one:
          // `createBranch` and `putFile` both run `assertWebBranch`, so there is
          // no path through this function that can name `master`.
          const head = await api.head(slug, branch)
          if (!head) {
            // From the ref on screen — the default branch, or the desktop's
            // shelf when that is what this page has been reading — so an edit
            // made against the shelf is committed on top of it, not on top of
            // an older default branch it would then silently revert.
            const from = ref || info?.defaultBranch || ''
            const base = from ? await api.head(slug, from) : null
            if (!base) {
              throw new Error(`There is no ${from} on GitHub to start ${branch} from.`)
            }
            await api.createBranch(slug, branch, base)
          }

          // What is on the branch right now, so "it moved under you" is a fact
          // rather than a guess at a 409. A file that is not on the branch yet
          // is a create, which is `sha` omitted.
          let currentSha = ''
          try {
            const theirs = await api.file(slug, open.path, branch)
            currentSha = theirs.sha
          } catch (err) {
            const f = asFailure(err)
            if (f.kind !== 'missing') throw err
          }
          if (open.sha && currentSha && currentSha !== open.sha) {
            setConflict({ path: open.path, theirSha: currentSha })
            setCommitFailure({
              kind: 'conflict',
              message: `${open.path} changed on ${branch} after this page read it. Nothing has been committed.`
            })
            return
          }

          const result = await api.putFile(slug, {
            path: open.path,
            branch,
            message,
            text: open.text,
            ...(currentSha ? { sha: currentSha } : {})
          })
          setLanded({ sha: result.commitSha, branch, path: open.path })
          dropDraft(slug, branch, open.path)
          setOpen((current) =>
            current && current.path === open.path
              ? {
                  ...current,
                  base: current.text,
                  ref: branch,
                  // The blob this file now *is*, so a second edit in the same
                  // sitting is against what was committed rather than against
                  // what it replaced.
                  sha: result.blobSha || current.sha,
                  cached: false
                }
              : current
          )
          setRef(branch)
          setNonce((n) => n + 1)
        } catch (err) {
          // The draft is untouched on purpose. Whatever went wrong, the edit is
          // still in localStorage and still on screen — that is the promise.
          setCommitFailure(asFailure(err))
          const draft = pending.current
          if (draft) pending.current = { ...draft, message }
        } finally {
          setCommitting(false)
        }
      },
      takeTheirs: () => {
        if (!slug || !open) return
        dropDraft(slug, branch, open.path)
        setConflict(null)
        setCommitFailure(null)
        void loadFile(open.path, branch, slug, branch)
      },
      keepMine: () => {
        if (!conflict) return
        // Re-base this edit on what is actually there. The *text* is untouched —
        // only the blob it claims to be against — so the next commit overwrites
        // GitHub's version deliberately rather than by accident.
        setOpen((current) => (current ? { ...current, sha: conflict.theirSha } : current))
        setConflict(null)
        setCommitFailure(null)
      },
      discardDraft: (path) => {
        if (!slug) return
        dropDraft(slug, branch, path)
        if (open?.path === path) setOpen((current) => (current ? { ...current, text: current.base } : current))
      },
      restoreDraft: (path) => {
        if (!slug || !ref) return
        void loadFile(path, ref, slug, branch)
      }
    }),
    [api, branch, conflict, dropDraft, forge.cached, info, loadFile, open, ref, slug]
  )

  /* ------------------------------------------------------------------ stage */

  const stage = useMemo<RepoStage>(() => {
    if (!project) return { kind: 'no-project' }
    if (remote === undefined) return { kind: 'unknown-remote', projectName: project.name }
    if (!slug) return { kind: 'no-remote', projectName: project.name }
    if (!token) return { kind: 'no-token', slug }
    if (failure && tree.length === 0) return { kind: 'failed', slug, failure }
    if (reading && tree.length === 0) return { kind: 'reading', slug }
    return { kind: 'ready', slug }
  }, [failure, project, reading, remote, slug, token, tree.length])

  const state = useMemo<RepoState>(
    () => ({
      stage,
      hasToken: Boolean(token),
      slug,
      info,
      branch,
      ref,
      shelf,
      tree,
      truncated,
      treeCached,
      warning: failure && tree.length > 0 ? failure : null,
      open,
      fileFailure,
      // Only this repository's, and only this branch's: a draft for another
      // project is not something to offer back here.
      drafts: drafts.filter((d) => d.slug === slug && d.branch === branch),
      committing,
      commitFailure,
      conflict,
      landed,
      reach
    }),
    [
      branch,
      commitFailure,
      committing,
      conflict,
      drafts,
      failure,
      fileFailure,
      info,
      landed,
      open,
      reach,
      ref,
      slug,
      stage,
      token,
      tree,
      treeCached,
      truncated
    ]
  )

  return <RepoContext.Provider value={{ state, actions }}>{children}</RepoContext.Provider>
}

/* ---------------------------------------------------------------- helpers */

function sameDraft(a: Draft, b: Draft): boolean {
  return a.slug === b.slug && a.branch === b.branch && a.path === b.path
}
