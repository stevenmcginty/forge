/**
 * telegram:check — the Telegram plugin, offline.
 *
 *  - Long replies split at blank lines, then lines, then spaces; never an empty message.
 *  - Pairing: a right code pairs at once; only wrong codes are counted; five
 *    drop the code; an expired code pairs nothing.
 *  - Once paired, only that chat is heard. Commands, text, voice notes and
 *    photos reach Forge Brain with the [Telegram] prefix; replies come back split.
 *  - Report-backs go out only while no ask is in flight, without repeats.
 *  - Confirms become a Yes/No card; the answer edits it; a question answered
 *    elsewhere edits it too.
 *  - The bot token is in no status and no log line.
 *
 * A fake Bot API and a fake brain: no network, no Electron.
 *
 *   node scripts/telegram-check.mjs
 */
import assert from 'node:assert/strict'
import './ts-hooks.mjs'

const { splitForTelegram } = await import('../electron/telegram/split.ts')
const { TelegramChannel, TG_TEXT, TELEGRAM_ASK_MS } = await import('../electron/telegram/channel.ts')
const { createTelegramApi } = await import('../electron/telegram/api.ts')
const { TELEGRAM_PAIR_MAX_WRONG, TELEGRAM_PAIR_TTL_MS } = await import('../shared/telegram.ts')

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`)
  }
}

const TOKEN = '123456:SECRET-TOKEN-abc'
const STEVE = 42
const STRANGER = 99

/** Let queued promise work run. */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

async function until(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

function fakeApi() {
  let nextId = 100
  const api = {
    sent: [],
    actions: [],
    edits: [],
    answers: [],
    downloads: [],
    getMeResults: [],
    getMe: async () => api.getMeResults.shift() ?? { ok: true, result: { id: 1, is_bot: true, username: 'ForgeTestBot' } },
    deleteWebhook: async () => ({ ok: true, result: true }),
    // Long poll that only ends on abort: the check feeds updates to handleUpdate itself.
    getUpdates: (_params, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve({ ok: false, status: 0, description: 'Aborted.' })
        signal?.addEventListener('abort', () => resolve({ ok: false, status: 0, description: 'Aborted.' }), { once: true })
      }),
    sendMessage: async (chatId, text, keyboard) => {
      const message_id = nextId++
      api.sent.push({ chatId, text, keyboard, message_id })
      return { ok: true, result: { message_id, chat: { id: Number(chatId) } } }
    },
    sendChatAction: async (_chatId, action) => {
      api.actions.push(action)
      return { ok: true, result: true }
    },
    getFile: async (fileId) => ({ ok: true, result: { file_id: fileId, file_path: `files/${fileId}` } }),
    downloadFile: async (path) => {
      api.downloads.push(path)
      return { ok: true, result: new Uint8Array([1, 2, 3]) }
    },
    answerCallbackQuery: async (id, text) => {
      api.answers.push({ id, text })
      return { ok: true, result: true }
    },
    editMessageText: async (_chatId, messageId, text) => {
      api.edits.push({ messageId, text })
      return { ok: true, result: true }
    }
  }
  return api
}

function fakeBrain() {
  const statusListeners = new Set()
  const saysListeners = new Set()
  const brain = {
    asks: [],
    answers: [],
    fresh: 0,
    freshResult: { ok: true, by: 'brain' },
    reply: async () => ({ ok: true, text: 'Brain reply.' }),
    st: {
      enabled: true,
      engine: 'claude',
      state: 'idle',
      paneId: 'brain-pane',
      projectId: 'brain',
      sessionId: null,
      queued: 0,
      error: null,
      unavailable: {},
      confirms: []
    },
    ask: async (text, ms) => {
      brain.asks.push({ text, ms })
      return brain.reply(text)
    },
    send: () => ({ ok: true, queued: false }),
    status: () => brain.st,
    onStatus: (cb) => {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    onSays: (cb) => {
      saysListeners.add(cb)
      return () => saysListeners.delete(cb)
    },
    answerConfirm: ({ id, allow }) => {
      if (!brain.st.confirms.some((c) => c.id === id)) return false
      brain.answers.push({ id, allow })
      brain.setConfirms(brain.st.confirms.filter((c) => c.id !== id))
      return true
    },
    freshStart: async () => {
      brain.fresh++
      return brain.freshResult
    },
    setConfirms(list) {
      brain.st = { ...brain.st, confirms: list }
      for (const cb of statusListeners) cb(brain.st)
    },
    say(text) {
      for (const cb of saysListeners) cb({ id: 's', text, speak: true, at: 0 })
    }
  }
  return brain
}

async function setup({ paired = false } = {}) {
  let clock = 1_700_000_000_000
  const settings = {
    telegramEnabled: true,
    telegramBotToken: TOKEN,
    telegramChatId: paired ? String(STEVE) : '',
    telegramChatName: paired ? 'Steve' : '',
    brainEnabled: true
  }
  const api = fakeApi()
  const brain = fakeBrain()
  const writes = []
  const saved = []
  const transcribed = []
  const logs = []
  const statuses = []
  const ch = new TelegramChannel({
    api: (token) => {
      assert.equal(token, TOKEN)
      return api
    },
    brain,
    settings: {
      get: () => settings,
      set: (patch) => {
        writes.push(patch)
        Object.assign(settings, patch)
      }
    },
    transcribe: async (bytes, mime) => {
      transcribed.push({ length: bytes.length, mime })
      return { ok: true, text: 'open the car harness' }
    },
    saveInboxFile: (name) => {
      saved.push(name)
      return `C:\\inbox\\${name}`
    },
    now: () => clock,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    sleep: async () => {}
  })
  ch.onStatus((s) => statuses.push(s))
  ch.apply()
  await until(() => ch.status().state === (paired ? 'ready' : 'pairing'), 'the bot to start')
  let updateId = 1
  const message = (chatId, fields) => ({
    update_id: updateId++,
    message: { message_id: updateId, chat: { id: chatId, first_name: 'Steve' }, from: { id: chatId, first_name: 'Steve' }, ...fields }
  })
  return {
    ch,
    api,
    brain,
    settings,
    writes,
    saved,
    transcribed,
    logs,
    statuses,
    advance: (ms) => {
      clock += ms
    },
    clock: () => clock,
    text: (chatId, text) => ch.handleUpdate(message(chatId, { text })),
    send: (chatId, fields) => ch.handleUpdate(message(chatId, fields)),
    callback: (fromId, data, messageId) =>
      ch.handleUpdate({
        update_id: updateId++,
        callback_query: { id: `q${updateId}`, from: { id: fromId }, data, message: { message_id: messageId, chat: { id: fromId } } }
      })
  }
}

const texts = (api) => api.sent.map((s) => s.text)

/* ------------------------------------------------------------------ split */

console.log('\nsplit')

await check('short text is one chunk, trimmed', () => {
  assert.deepEqual(splitForTelegram('  hello there \n'), ['hello there'])
})

await check('blank or empty text gives no chunks', () => {
  assert.deepEqual(splitForTelegram(''), [])
  assert.deepEqual(splitForTelegram('   \n\n  \n '), [])
})

await check('long text splits at blank lines first, every chunk within the limit', () => {
  const para = 'word '.repeat(150).trim() // 749 chars
  const text = Array.from({ length: 12 }, () => para).join('\n\n')
  const chunks = splitForTelegram(text, 4000)
  assert.ok(chunks.length >= 3, `${chunks.length} chunks`)
  for (const c of chunks) {
    assert.ok(c.length <= 4000 && c.length > 0)
    assert.ok(c.startsWith('word') && c.endsWith('word'), 'cut at a paragraph edge')
    assert.equal(c.split('\n\n').every((p) => p === para), true)
  }
  assert.equal(chunks.join('\n\n'), text)
})

await check('falls back to a newline, then a space', () => {
  assert.deepEqual(splitForTelegram('aaaa\nbbbb', 6), ['aaaa', 'bbbb'])
  assert.deepEqual(splitForTelegram('aaaa bbbb', 6), ['aaaa', 'bbbb'])
})

await check('a run with no breaks is cut hard at the limit', () => {
  const chunks = splitForTelegram('x'.repeat(9000), 4000)
  assert.deepEqual(chunks.map((c) => c.length), [4000, 4000, 1000])
})

await check('no empty chunks from runs of blank lines', () => {
  const chunks = splitForTelegram(`a\n\n\n\n\n\n${'b'.repeat(10)}\n\n\n\n`, 5)
  assert.ok(chunks.length > 0)
  for (const c of chunks) assert.ok(c.length > 0 && c.length <= 5, JSON.stringify(c))
})

/* ------------------------------------------------------------------- api */

console.log('\nthe Bot API client')

await check('a network error never carries the token', async () => {
  const api = createTelegramApi(TOKEN, async (url) => {
    throw new Error(`connect failed for ${url}`)
  })
  const r = await api.getMe()
  assert.equal(r.ok, false)
  assert.equal(r.status, 0)
  assert.ok(!r.description.includes(TOKEN), r.description)
})

await check('a 429 carries retry_after; a 401 its status', async () => {
  const replies = [
    { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } },
    { ok: false, error_code: 401, description: 'Unauthorized' }
  ]
  const calls = []
  const api = createTelegramApi(TOKEN, async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    const body = replies.shift()
    return new Response(JSON.stringify(body), { status: body.error_code })
  })
  const a = await api.sendMessage('42', 'hi', [[{ text: 'Yes', callback_data: 'c:1:y' }]])
  assert.deepEqual(a, { ok: false, status: 429, description: 'Too Many Requests', retryAfter: 7 })
  assert.deepEqual(calls[0].body, { chat_id: '42', text: 'hi', reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'c:1:y' }]] } })
  assert.ok(calls[0].url.endsWith('/sendMessage'))
  const b = await api.getMe()
  assert.equal(b.ok, false)
  assert.equal(b.status, 401)
})

/* ---------------------------------------------------------------- poller */

console.log('\nthe poller')

await check('a refused token stops with a plain error', async () => {
  const t = await setup({ paired: true })
  t.api.getMeResults.push({ ok: false, status: 401, description: 'Unauthorized' })
  t.ch.setEnabled(false)
  assert.equal(t.ch.status().state, 'off')
  t.ch.setEnabled(true)
  await until(() => t.ch.status().state === 'error', 'error state')
  assert.equal(t.ch.status().error, TG_TEXT.tokenRefused)
  t.ch.dispose()
})

await check('network failures say error after three in a row, and it keeps trying', async () => {
  const t = await setup({ paired: true })
  t.ch.setEnabled(false)
  for (let i = 0; i < 3; i++) t.api.getMeResults.push({ ok: false, status: 0, description: 'fetch failed' })
  t.ch.setEnabled(true)
  await until(() => t.ch.status().state === 'ready', 'ready after retries')
  assert.ok(t.statuses.some((s) => s.state === 'error' && /Cannot reach Telegram/.test(s.error ?? '')))
  t.ch.dispose()
})

await check('no token and switched off are their own states; setEnabled writes the setting', async () => {
  const t = await setup({ paired: true })
  t.ch.setEnabled(false)
  assert.deepEqual(t.writes.at(-1), { telegramEnabled: false })
  assert.equal(t.ch.status().state, 'off')
  assert.equal(t.ch.status().enabled, false)
  t.settings.telegramBotToken = ''
  t.ch.setEnabled(true)
  assert.equal(t.ch.status().state, 'no-token')
  t.ch.dispose()
})

/* --------------------------------------------------------------- pairing */

console.log('\npairing')

await check('Pair arms a six-digit code with an expiry', async () => {
  const t = await setup()
  const s = t.ch.pair()
  assert.match(s.pairCode, /^\d{6}$/)
  assert.equal(s.pairCodeExpiresAt, t.clock() + TELEGRAM_PAIR_TTL_MS)
  assert.equal(s.state, 'pairing')
  t.ch.dispose()
})

await check('without an armed code every message is ignored', async () => {
  const t = await setup()
  await t.text(STEVE, '123456')
  assert.equal(t.api.sent.length, 0)
  assert.equal(t.writes.length, 0)
  t.ch.dispose()
})

await check('a wrong code is ignored without a reply; a right one pairs and writes settings', async () => {
  const t = await setup()
  const code = t.ch.pair().pairCode
  const wrong = code === '000000' ? '111111' : '000000'
  await t.text(STEVE, wrong)
  await t.text(STEVE, 'hello bot')
  assert.equal(t.api.sent.length, 0)
  assert.equal(t.settings.telegramChatId, '')
  await t.text(STEVE, ` ${code} `)
  assert.deepEqual(t.writes.at(-1), { telegramChatId: String(STEVE), telegramChatName: 'Steve' })
  assert.deepEqual(texts(t.api), [TG_TEXT.paired])
  const s = t.ch.status()
  assert.equal(s.state, 'ready')
  assert.equal(s.paired, true)
  assert.equal(s.pairedName, 'Steve')
  assert.equal(s.pairCode, null)
  t.ch.dispose()
})

await check('/start CODE pairs', async () => {
  const t = await setup()
  const code = t.ch.pair().pairCode
  await t.text(STEVE, '/start')
  assert.equal(t.settings.telegramChatId, '')
  await t.text(STEVE, `/start ${code}`)
  assert.equal(t.settings.telegramChatId, String(STEVE))
  assert.equal(t.ch.status().state, 'ready')
  t.ch.dispose()
})

await check(`${TELEGRAM_PAIR_MAX_WRONG} wrong codes drop the code`, async () => {
  const t = await setup()
  const code = t.ch.pair().pairCode
  const wrong = code === '000000' ? '111111' : '000000'
  for (let i = 0; i < TELEGRAM_PAIR_MAX_WRONG; i++) await t.text(STRANGER, wrong)
  const s = t.ch.status()
  assert.equal(s.pairCode, null)
  assert.equal(s.state, 'pairing')
  assert.equal(s.error, TG_TEXT.tooManyWrong)
  await t.text(STEVE, code)
  assert.equal(t.settings.telegramChatId, '', 'the dropped code no longer pairs')
  assert.equal(t.api.sent.length, 0)
  t.ch.dispose()
})

await check('an expired code is refused and cleared', async () => {
  const t = await setup()
  const code = t.ch.pair().pairCode
  t.advance(TELEGRAM_PAIR_TTL_MS + 1)
  await t.text(STEVE, code)
  assert.equal(t.settings.telegramChatId, '')
  assert.equal(t.ch.status().pairCode, null)
  assert.equal(t.api.sent.length, 0)
  t.ch.dispose()
})

await check('unpair forgets the chat and waits for Pair', async () => {
  const t = await setup({ paired: true })
  const s = t.ch.unpair()
  assert.deepEqual(t.writes.at(-1), { telegramChatId: '', telegramChatName: '' })
  assert.equal(s.state, 'pairing')
  assert.equal(s.paired, false)
  t.ch.dispose()
})

/* --------------------------------------------------------------- routing */

console.log('\nrouting')

await check('a chat that is not the paired one is dropped silently', async () => {
  const t = await setup({ paired: true })
  await t.text(STRANGER, 'hello')
  await t.text(STRANGER, '/status')
  assert.equal(t.api.sent.length, 0)
  assert.equal(t.brain.asks.length, 0)
  t.ch.dispose()
})

await check('/status is one line: brain state, queue, engine, bot', async () => {
  const t = await setup({ paired: true })
  t.brain.st = { ...t.brain.st, queued: 2 }
  await t.text(STEVE, '/status')
  assert.deepEqual(texts(t.api), ['Forge Brain: ready. Queued: 2. Engine: claude. Bot: @ForgeTestBot.'])
  t.ch.dispose()
})

await check('/fresh runs a fresh start and says how it went', async () => {
  const t = await setup({ paired: true })
  await t.text(STEVE, '/fresh')
  assert.equal(t.brain.fresh, 1)
  t.brain.freshResult = { ok: false, error: 'Forge Brain is off.' }
  await t.text(STEVE, '/fresh@ForgeTestBot')
  assert.deepEqual(texts(t.api), [TG_TEXT.freshDone, 'Forge Brain is off.'])
  t.ch.dispose()
})

await check('/help lists the three commands and what else works', async () => {
  const t = await setup({ paired: true })
  await t.text(STEVE, '/help')
  const [help] = texts(t.api)
  for (const cmd of ['/status', '/fresh', '/help']) assert.ok(help.includes(cmd), cmd)
  assert.ok(help.includes('Anything else goes to Forge Brain. Voice notes and photos work.'))
  t.ch.dispose()
})

await check('text goes to the brain with the [Telegram] prefix; the reply comes back', async () => {
  const t = await setup({ paired: true })
  await t.text(STEVE, '  what is open?  ')
  assert.deepEqual(t.brain.asks, [{ text: '[Telegram] what is open?', ms: TELEGRAM_ASK_MS }])
  assert.equal(TELEGRAM_ASK_MS, 5 * 60_000)
  assert.ok(t.api.actions.includes('typing'))
  assert.deepEqual(texts(t.api), ['Brain reply.'])
  assert.ok(t.ch.status().lastMessageAt !== null && t.ch.status().lastSentAt !== null)
  t.ch.dispose()
})

await check('a long reply is split into Telegram-sized messages', async () => {
  const t = await setup({ paired: true })
  t.brain.reply = async () => ({ ok: true, text: 'x'.repeat(9000) })
  await t.text(STEVE, 'long one')
  assert.deepEqual(texts(t.api).map((s) => s.length), [4000, 4000, 1000])
  t.ch.dispose()
})

await check('late and error replies are worded plainly', async () => {
  const t = await setup({ paired: true })
  t.brain.reply = async () => ({ ok: false, error: 'It is taking a while.', late: true })
  await t.text(STEVE, 'big job')
  t.brain.reply = async () => ({ ok: false, error: 'Forge Brain is starting. Try again in a moment.' })
  await t.text(STEVE, 'again')
  assert.deepEqual(texts(t.api), [TG_TEXT.late, 'Forge Brain is starting. Try again in a moment.'])
  t.ch.dispose()
})

await check('Brain off: says so and never asks', async () => {
  const t = await setup({ paired: true })
  t.brain.st = { ...t.brain.st, enabled: false, state: 'off' }
  await t.text(STEVE, 'hello')
  assert.equal(t.brain.asks.length, 0)
  assert.deepEqual(texts(t.api), [TG_TEXT.brainOff])
  t.ch.dispose()
})

await check('messages reach the brain one at a time, in order', async () => {
  const t = await setup({ paired: true })
  const first = deferred()
  t.brain.reply = async (text) => (text.endsWith('one') ? first.promise : { ok: true, text: 'reply two' })
  const a = t.text(STEVE, 'one')
  const b = t.text(STEVE, 'two')
  await settle()
  assert.deepEqual(t.brain.asks.map((x) => x.text), ['[Telegram] one'])
  first.resolve({ ok: true, text: 'reply one' })
  await Promise.all([a, b])
  assert.deepEqual(t.brain.asks.map((x) => x.text), ['[Telegram] one', '[Telegram] two'])
  assert.deepEqual(texts(t.api), ['reply one', 'reply two'])
  t.ch.dispose()
})

await check('stickers and documents get the short list of what works', async () => {
  const t = await setup({ paired: true })
  await t.send(STEVE, { sticker: { file_id: 'st' } })
  assert.deepEqual(texts(t.api), [TG_TEXT.otherKinds])
  t.ch.dispose()
})

/* ---------------------------------------------------------- voice, photo */

console.log('\nvoice notes and photos')

await check('a voice note is transcribed, echoed as Heard:, then asked', async () => {
  const t = await setup({ paired: true })
  await t.send(STEVE, { voice: { file_id: 'v1', duration: 3, mime_type: 'audio/ogg' } })
  assert.deepEqual(t.api.downloads, ['files/v1'])
  assert.deepEqual(t.transcribed, [{ length: 3, mime: 'audio/ogg' }])
  assert.deepEqual(t.brain.asks.map((x) => x.text), ['[Telegram] open the car harness'])
  assert.deepEqual(texts(t.api), ['Heard: "open the car harness"', 'Brain reply.'])
  t.ch.dispose()
})

await check('a photo: the largest size is fetched, saved, and its path is in the prompt', async () => {
  const t = await setup({ paired: true })
  const photo = [
    { file_id: 'small', width: 90, height: 90 },
    { file_id: 'large', width: 1280, height: 960 },
    { file_id: 'mid', width: 320, height: 240 }
  ]
  await t.send(STEVE, { photo, caption: 'what is this part?' })
  assert.deepEqual(t.api.downloads, ['files/large'])
  const name = `${t.clock()}.jpg`
  assert.deepEqual(t.saved, [name])
  assert.deepEqual(t.brain.asks.map((x) => x.text), [`[Telegram] what is this part? Photo file: C:\\inbox\\${name}`])
  await t.send(STEVE, { photo: [photo[0]] })
  assert.equal(t.brain.asks[1].text, `[Telegram] ${TG_TEXT.photoAsk} Photo file: C:\\inbox\\${name}`)
  t.ch.dispose()
})

/* --------------------------------------------------------- report-backs */

console.log('\nreport-backs')

await check('a report-back goes out when idle, once per 5 s', async () => {
  const t = await setup({ paired: true })
  t.brain.say('car-harness finished.')
  await settle()
  t.brain.say('car-harness finished.')
  await settle()
  assert.deepEqual(texts(t.api), ['car-harness finished.'])
  t.advance(6_000)
  t.brain.say('car-harness finished.')
  await settle()
  assert.deepEqual(texts(t.api), ['car-harness finished.', 'car-harness finished.'])
  t.ch.dispose()
})

await check('a report-back during an ask is left to the ask', async () => {
  const t = await setup({ paired: true })
  const reply = deferred()
  t.brain.reply = () => reply.promise
  const done = t.text(STEVE, 'go')
  await settle()
  t.brain.say('a line folded into the reply')
  await settle()
  assert.deepEqual(texts(t.api), [])
  reply.resolve({ ok: true, text: 'a line folded into the reply' })
  await done
  // ...and the same line repeated right after the reply is not sent twice.
  t.brain.say('a line folded into the reply')
  await settle()
  assert.deepEqual(texts(t.api), ['a line folded into the reply'])
  t.ch.dispose()
})

await check('no report-backs before pairing', async () => {
  const t = await setup()
  t.brain.say('hello?')
  await settle()
  assert.equal(t.api.sent.length, 0)
  t.ch.dispose()
})

/* -------------------------------------------------------------- confirms */

console.log('\nconfirms')

const ask = (id, summary = 'close the tab Zeb', risk = 'medium') => ({ id, tool: 'run_app_action', summary, risk, at: 0 })

await check('a confirm becomes a card with Yes and No, posted once', async () => {
  const t = await setup({ paired: true })
  t.brain.setConfirms([ask('abc')])
  await settle()
  t.brain.setConfirms([ask('abc')])
  await settle()
  assert.equal(t.api.sent.length, 1)
  const card = t.api.sent[0]
  assert.equal(card.text, 'Forge Brain wants to: close the tab Zeb\nRisk: medium')
  assert.deepEqual(card.keyboard, [[{ text: 'Yes', callback_data: 'c:abc:y' }, { text: 'No', callback_data: 'c:abc:n' }]])
  t.ch.dispose()
})

await check('Yes answers the brain true and edits the card', async () => {
  const t = await setup({ paired: true })
  t.brain.setConfirms([ask('abc')])
  await settle()
  const card = t.api.sent[0]
  await t.callback(STEVE, 'c:abc:y', card.message_id)
  await settle()
  assert.deepEqual(t.brain.answers, [{ id: 'abc', allow: true }])
  assert.deepEqual(t.api.answers.map((a) => a.text), ['Yes'])
  assert.deepEqual(t.api.edits, [{ messageId: card.message_id, text: 'close the tab Zeb\nYou said: Yes' }])
  t.ch.dispose()
})

await check('No answers false; a stranger\'s tap does nothing', async () => {
  const t = await setup({ paired: true })
  t.brain.setConfirms([ask('abc')])
  await settle()
  const card = t.api.sent[0]
  await t.callback(STRANGER, 'c:abc:y', card.message_id)
  assert.deepEqual(t.brain.answers, [])
  await t.callback(STEVE, 'c:abc:n', card.message_id)
  await settle()
  assert.deepEqual(t.brain.answers, [{ id: 'abc', allow: false }])
  assert.deepEqual(t.api.edits, [{ messageId: card.message_id, text: 'close the tab Zeb\nYou said: No' }])
  t.ch.dispose()
})

await check('a question that vanishes without our answer edits its card', async () => {
  const t = await setup({ paired: true })
  t.brain.setConfirms([ask('def', 'delete the branch old')])
  await settle()
  const card = t.api.sent[0]
  t.brain.setConfirms([])
  await settle()
  assert.deepEqual(t.api.edits, [{ messageId: card.message_id, text: `delete the branch old\n${TG_TEXT.answeredElsewhere}` }])
  t.ch.dispose()
})

/* ---------------------------------------------------------------- secret */

console.log('\nthe token')

await check('the token is in no status and no log line', async () => {
  const t = await setup()
  const code = t.ch.pair().pairCode
  await t.text(STRANGER, '000001')
  await t.text(STEVE, code)
  await t.text(STRANGER, 'hello')
  const r = await t.ch.test()
  assert.deepEqual(r, { ok: true })
  assert.ok(texts(t.api).includes(TG_TEXT.test))
  for (const s of [...t.statuses, t.ch.status()]) assert.ok(!JSON.stringify(s).includes(TOKEN))
  for (const line of t.logs) assert.ok(!line.includes(TOKEN), line)
  assert.ok(t.logs.length > 0)
  t.ch.dispose()
})

await check('Test explains itself when not paired', async () => {
  const t = await setup()
  const r = await t.ch.test()
  assert.equal(r.ok, false)
  assert.match(r.error, /Not paired yet/)
  t.ch.dispose()
})

console.log(`\ntelegram:check ${passed}/${failed}`)
process.exit(failed === 0 ? 0 : 1)
