/**
 * Forge Companion — the phone app.
 *
 * Two screens. A list of Steve's projects with a live status line, and one
 * project's feed: what he has sent up, and what the agent has said back. The
 * composer sends text (typed or dictated) and images.
 *
 * Everything durable goes through `outbox.js` first, so a send survives a dead
 * signal, a locked phone and a killed tab. Everything live comes down an
 * EventSource that reconnects with a fresh token.
 */

import { isEmulated, resolveConfig } from '../config.js'
import { idToken, initAuth, isSignedOutError, signedIn, signIn, signOut, uid } from './auth.js'
import { applyEvent, initDb, live, patch, paths, safeKey, SERVER_TIMESTAMP, sortableId } from './rtdb.js'
import { autoFlush, count as queueCount, enqueue, flush, pending as queuePending } from './outbox.js'
import { packImage } from './imgpack.js'

const $ = (id) => document.getElementById(id)
const el = {
  body: document.body,
  back: $('backBtn'),
  brandText: $('brandText'),
  statusCapsule: $('statusCapsule'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  projectList: $('projectList'),
  projectsEmpty: $('projectsEmpty'),
  projectTitle: $('projectTitle'),
  projectSub: $('projectSub'),
  feed: $('feed'),
  composerInput: $('composerInput'),
  sendBtn: $('sendBtn'),
  imageBtn: $('imageBtn'),
  imageInput: $('imageInput'),
  micBtn: $('micBtn'),
  authPane: $('authPane'),
  authEmail: $('authEmail'),
  authPassword: $('authPassword'),
  authBtn: $('authBtn'),
  authError: $('authError'),
  toast: $('toast')
}

const config = resolveConfig()

/** Everything the two screens render from. */
const state = {
  /** projectId -> record, mirrored from `users/<uid>/projects`. */
  projects: {},
  /** The open project's id, or null on the list screen. */
  openId: null,
  /** itemId -> record for the open project's inbox (what I sent). */
  inbox: {},
  /** itemId -> record for the open project's outbox (what the agent said). */
  outbox: {},
  /** Optimistic rows for sends still sitting in the IndexedDB queue. */
  queued: [],
  link: 'offline',
  stopProjects: null,
  stopFeed: null,
  /**
   * Row ids already on screen. Both lists are rebuilt wholesale on every stream
   * event — cheap, and far simpler than reconciling — but that means the
   * entrance animation would replay on every one of them. These sets are what
   * make "new" mean new.
   */
  seenProjects: new Set(),
  seenRows: new Set()
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  if (!config.apiKey || !config.databaseURL) {
    showAuth("This build isn't pointed at a Firebase project yet — see companion/GO-LIVE.md")
    el.authBtn.disabled = true
    return
  }

  initAuth(config)
  initDb(config)
  wireUi()

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !isEmulated(config)) {
    // Not against the emulator: a cached shell during a test run is a great way
    // to spend an hour debugging yesterday's JavaScript.
    navigator.serviceWorker.register('sw.js').catch(() => {})
  }

  if (!signedIn()) {
    showAuth('')
    return
  }
  start()
}

function start() {
  el.authPane.hidden = true
  el.brandText.textContent = 'Forge'
  watchProjects()
  autoFlush(runFlush)
  void runFlush()
}

/* ------------------------------------------------------------------- auth */

function showAuth(message) {
  el.authPane.hidden = false
  el.authError.textContent = message || ''
}

async function doSignIn() {
  const email = el.authEmail.value.trim()
  const password = el.authPassword.value
  if (!email || !password) {
    el.authError.textContent = 'Email and password, please'
    return
  }
  el.authBtn.disabled = true
  el.authBtn.textContent = 'Signing in…'
  try {
    await signIn(email, password)
    el.authPassword.value = ''
    el.authError.textContent = ''
    start()
  } catch (err) {
    el.authError.textContent = err?.message || 'Sign-in failed'
  } finally {
    el.authBtn.disabled = false
    el.authBtn.textContent = 'Sign in'
  }
}

function handleSignedOut() {
  state.stopProjects?.()
  state.stopFeed?.()
  state.stopProjects = null
  state.stopFeed = null
  signOut()
  showProjects()
  showAuth('Signed out — sign in again')
}

/* --------------------------------------------------------------- projects */

function watchProjects() {
  state.stopProjects?.()
  state.stopProjects = live(paths.projects(uid()), {
    onEvent: ({ event, path, data }) => {
      state.projects = applyEvent(state.projects, event, path, data) ?? {}
      renderProjects()
      if (state.openId) renderProjectHeader()
    },
    onState: (s) => {
      if (s === 'signed-out') {
        handleSignedOut()
        return
      }
      setLink(s)
    }
  })
}

function renderProjects() {
  const rows = Object.entries(state.projects)
    .filter(([, p]) => p && typeof p === 'object')
    .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0))

  el.projectsEmpty.hidden = rows.length > 0
  el.projectList.replaceChildren(
    ...rows.map(([id, p]) => {
      const li = document.createElement('li')
      const btn = document.createElement('button')
      btn.type = 'button'
      const fresh = state.seenProjects.has(id) ? '' : ' fresh'
      state.seenProjects.add(id)
      btn.className = `project-row${p.panes > 0 ? ' busy' : ''}${fresh}`
      btn.addEventListener('click', () => openProject(id))

      const dot = document.createElement('span')
      dot.className = 'project-dot'
      dot.style.background = p.color || 'var(--volt)'

      const body = document.createElement('span')
      body.className = 'project-body'
      const name = document.createElement('span')
      name.className = 'project-name'
      name.textContent = p.name || id
      const status = document.createElement('span')
      status.className = 'project-status'
      status.textContent = p.status || 'idle'
      body.append(name, status)

      const when = document.createElement('span')
      when.className = 'project-when'
      when.textContent = ago(p.lastActivity)

      btn.append(dot, body, when)
      li.append(btn)
      return li
    })
  )
}

/* ---------------------------------------------------------------- project */

function openProject(id) {
  state.openId = id
  state.inbox = {}
  state.outbox = {}
  // A different project is a different conversation, so its rows really are new.
  state.seenRows.clear()
  el.body.classList.remove('view-projects')
  el.body.classList.add('view-project')
  renderProjectHeader()
  renderFeed()
  watchFeed(id)
  autosize()
}

function showProjects() {
  state.openId = null
  state.stopFeed?.()
  state.stopFeed = null
  el.body.classList.remove('view-project')
  el.body.classList.add('view-projects')
}

function renderProjectHeader() {
  const p = state.projects[state.openId] || {}
  el.projectTitle.textContent = p.name || state.openId || '—'
  const bits = [p.status || 'idle']
  if (p.lastActivity) bits.push(ago(p.lastActivity))
  el.projectSub.textContent = bits.join(' · ')
}

function watchFeed(projectId) {
  state.stopFeed?.()
  const u = uid()
  const stopIn = live(paths.inbox(u, projectId), {
    onEvent: ({ event, path, data }) => {
      state.inbox = applyEvent(state.inbox, event, path, data) ?? {}
      renderFeed()
    },
    onState: (s) => {
      if (s === 'signed-out') handleSignedOut()
      else setLink(s)
    }
  })
  const stopOut = live(paths.outbox(u, projectId), {
    onEvent: ({ event, path, data }) => {
      state.outbox = applyEvent(state.outbox, event, path, data) ?? {}
      renderFeed()
      ackReplies()
    }
  })
  state.stopFeed = () => {
    stopIn()
    stopOut()
  }
}

/**
 * One list, both directions, ordered by the id — which is time-prefixed, so
 * sorting the keys sorts the conversation without needing every record's
 * server timestamp to have resolved yet.
 */
function renderFeed() {
  const rows = []
  for (const [id, item] of Object.entries(state.inbox)) {
    if (item && typeof item === 'object') rows.push({ id, mine: true, item })
  }
  for (const [id, item] of Object.entries(state.outbox)) {
    if (item && typeof item === 'object') rows.push({ id, mine: false, item })
  }
  for (const q of state.queued) {
    if (q.projectId === state.openId && !state.inbox[q.id]) {
      rows.push({ id: q.id, mine: true, item: { ...q.value, status: 'queued' } })
    }
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  el.feed.replaceChildren(
    ...rows.map(({ id, mine, item }) => {
      const li = document.createElement('li')
      const fresh = state.seenRows.has(id) ? '' : ' fresh'
      state.seenRows.add(id)
      li.className = `bubble ${mine ? 'mine' : 'theirs'}${fresh}`
      li.dataset.status = mine ? item.status || 'pending' : 'done'
      li.id = `row-${id}`

      if (item.kind === 'image' && item.data) {
        const img = document.createElement('img')
        img.src = item.data
        img.alt = item.name || 'Image sent to Forge'
        img.loading = 'lazy'
        li.append(img)
      }

      const text = document.createElement('span')
      text.textContent = item.text || (item.kind === 'image' ? item.name || 'Image' : '')
      li.append(text)

      const meta = document.createElement('span')
      meta.className = 'bubble-meta'
      if (mine) {
        const pip = document.createElement('span')
        pip.className = 'pip'
        meta.append(pip)
      }
      const label = document.createElement('span')
      label.textContent = mine ? item.result || statusWord(item.status) : `Agent · ${ago(item.createdAt)}`
      meta.append(label)
      li.append(meta)
      return li
    })
  )
  if (rows.length > 0) scrollFeedToEnd()
}

function statusWord(status) {
  if (status === 'queued') return 'Waiting for signal'
  if (status === 'done') return 'Delivered'
  if (status === 'failed') return 'Failed'
  if (status === 'stale') return 'Too old to run'
  return 'Sending'
}

/**
 * Delivery ack: stamp `seenAt` on replies we have actually painted.
 *
 * Client time on purpose — this is "the phone showed it", and the phone is the
 * only thing that knows when that happened. Forge never writes this field,
 * which is what makes it an ack rather than a second copy of `createdAt`.
 */
function ackReplies() {
  if (!state.openId) return
  for (const [id, item] of Object.entries(state.outbox)) {
    if (!item || item.seenAt) continue
    item.seenAt = Date.now()
    patch(paths.outbox(uid(), state.openId, id), { seenAt: item.seenAt }).catch(() => {
      // Not worth queueing: an unacked reply is cosmetic, and the next render
      // will try again.
      delete item.seenAt
    })
  }
}

/* ---------------------------------------------------------------- sending */

async function sendMessage() {
  const text = el.composerInput.value.trim()
  if (!text || !state.openId) return
  el.composerInput.value = ''
  autosize()
  // Clearing the box programmatically fires no `input` event, so the send
  // button has to be told — otherwise it sits there looking armed with nothing
  // to send.
  syncSend()
  await queue({
    kind: 'message',
    text,
    createdAt: SERVER_TIMESTAMP,
    origin: 'phone',
    status: 'pending'
  })
}

async function sendImages(files) {
  if (!state.openId) return
  for (const file of files) {
    let packed
    try {
      packed = await packImage(file)
    } catch (err) {
      toast(err?.message || "That image couldn't be sent")
      continue
    }
    await queue({
      kind: 'image',
      name: packed.name,
      mime: packed.mime,
      data: packed.dataUrl,
      createdAt: SERVER_TIMESTAMP,
      origin: 'phone',
      status: 'pending'
    })
  }
}

/**
 * Durable send: IndexedDB first, network second.
 *
 * The optimistic row appears from `state.queued`, so the message is on screen
 * before any request is made and stays there — marked "waiting for signal" —
 * until the server has it.
 */
async function queue(value) {
  const projectId = safeKey(state.openId)
  const id = sortableId()
  await enqueue({ path: paths.inbox(uid(), projectId, id), value, projectId, id })
  await refreshQueued()
  renderFeed()
  await runFlush()
}

async function refreshQueued() {
  state.queued = (await queuePending()).map((e) => ({ id: e.id, projectId: e.projectId, value: e.value }))
}

let flushing = false

async function runFlush() {
  if (flushing) return
  flushing = true
  try {
    await idToken()
  } catch (err) {
    flushing = false
    if (isSignedOutError(err)) handleSignedOut()
    else setLink('offline')
    return
  }
  try {
    await flush(async (entry) => {
      await patch(entry.path, entry.value)
    })
  } catch (err) {
    console.warn('[companion] flush failed', err)
  } finally {
    flushing = false
  }
  await refreshQueued()
  const left = await queueCount()
  if (left > 0) setLink('queued', `${left} queued`)
  else if (state.link === 'queued') setLink('live')
  renderFeed()
}

/* ------------------------------------------------------------- dictation */

/**
 * Voice note → text, on the phone.
 *
 * The Web Speech API does the transcription where the microphone already is,
 * which means nothing has to upload audio, wait for the desktop's Parakeet
 * model, and come back. It is Chrome/Android and Safari/iOS only — hence the
 * capability check and the hidden button. Steve's phone has it; a browser that
 * does not simply never sees a mic.
 */
function wireDictation() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Recognition) return
  el.micBtn.hidden = false

  let rec = null
  el.micBtn.addEventListener('click', () => {
    if (rec) {
      rec.stop()
      return
    }
    rec = new Recognition()
    rec.lang = navigator.language || 'en-GB'
    rec.interimResults = true
    rec.continuous = false
    const before = el.composerInput.value

    rec.onresult = (e) => {
      let text = ''
      for (const result of e.results) text += result[0].transcript
      el.composerInput.value = (before ? `${before} ` : '') + text
      autosize()
      syncSend()
    }
    rec.onerror = (e) => {
      toast(e.error === 'not-allowed' ? 'Microphone blocked for this site' : "Didn't catch that")
    }
    rec.onend = () => {
      rec = null
      el.micBtn.classList.remove('listening')
      el.composerInput.focus({ preventScroll: true })
    }
    el.micBtn.classList.add('listening')
    rec.start()
  })
}

/* ------------------------------------------------------------------- glue */

function wireUi() {
  el.authBtn.addEventListener('click', doSignIn)
  el.authPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSignIn()
  })
  el.back.addEventListener('click', showProjects)
  el.sendBtn.addEventListener('click', sendMessage)
  el.composerInput.addEventListener('input', () => {
    autosize()
    syncSend()
  })
  el.composerInput.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a newline. On a phone the on-screen keyboard's
    // "send" key produces a plain Enter, which is exactly what we want.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  })
  el.imageBtn.addEventListener('click', () => el.imageInput.click())
  el.imageInput.addEventListener('change', () => {
    const files = [...el.imageInput.files]
    el.imageInput.value = ''
    void sendImages(files)
  })
  el.statusCapsule.addEventListener('click', () => {
    if (!signedIn()) return
    toast(linkSentence())
  })
  addEventListener('popstate', () => {
    if (state.openId) showProjects()
  })
  wireDictation()
  syncSend()
}

const COMPOSER_MAX_H = 140

/**
 * Grow the composer with its content, up to a limit, and only then let it
 * scroll. Measuring needs the height reset to `auto` first, otherwise
 * `scrollHeight` never shrinks back after a long message is sent.
 */
function autosize() {
  const box = el.composerInput
  box.style.height = 'auto'
  const wanted = box.scrollHeight
  box.style.height = `${Math.min(COMPOSER_MAX_H, wanted)}px`
  box.classList.toggle('overflowing', wanted > COMPOSER_MAX_H)
}

/**
 * Pin the feed to the newest message.
 *
 * `scrollIntoView` is the obvious call and the wrong one here: the composer is
 * `position: fixed`, so "in view" includes the strip underneath it and the last
 * bubble ends up behind the send button. Scrolling the document to its own
 * bottom, against a pane whose padding already clears the composer, puts the
 * message where you expect it.
 */
function scrollFeedToEnd() {
  requestAnimationFrame(() => {
    scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
  })
}

function syncSend() {
  el.sendBtn.disabled = el.composerInput.value.trim().length === 0
}

function setLink(state_, label) {
  state.link = state_
  el.statusCapsule.dataset.state = state_
  el.statusText.textContent = label || state_
  el.body.classList.toggle('link-live', state_ === 'live')
}

function linkSentence() {
  if (state.link === 'live') return 'Connected to Forge'
  if (state.link === 'queued') return 'Saved on this phone — will send when there is signal'
  if (state.link === 'connecting') return 'Connecting…'
  return 'No connection — anything you send is saved until there is'
}

let toastTimer = null

function toast(message) {
  el.toast.textContent = message
  el.toast.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600)
}

/** "4m", "2h", "3d" — a glance, not a date. */
function ago(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const s = Math.max(0, Math.round((Date.now() - n) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// Re-render the relative times once a minute so "now" does not sit there for
// an hour. Cheap: two small lists of DOM nodes.
setInterval(() => {
  if (!el.authPane.hidden) return
  renderProjects()
  if (state.openId) renderProjectHeader()
}, 60_000)

void boot()
