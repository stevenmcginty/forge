/**
 * chat-tools:check — agents handing off to the chat tabs (shared/chat-tools.ts).
 *
 *   node scripts/chat-tools-check.mjs
 *
 * Five parts:
 *  1. The words: bridge/chat-tools.mjs (what pane agents see) agrees with
 *     shared/chat-tools.ts word for word, and every road carries the tools.
 *  2. Which chat a call means (electron/chat-panes/agent-ops.ts `resolve`):
 *     an id, a bot's name in the caller's project, then on screen, then any —
 *     and a new tab, opened in the caller's project without taking the screen,
 *     through the real layout engine.
 *  2b. The same calls over the real pipe: the bridge's own handlers, the real
 *     link server (electron/browser-panes/link.ts), the calling pane's id.
 *  3. The refusals that keep Steve's own words his: a half-written message in
 *     the box is never typed over or sent.
 *  4. The page scripts (electron/chat-panes/page-scripts.ts), run in a real
 *     Chromium against stand-in pages shaped like each site's selectors: type,
 *     send (button and Enter), wait out a streamed reply, read it back. Skipped
 *     when no Chromium is at hand. The real sites are NOT exercised here.
 */
import './ts-hooks.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

let passed = 0
let failed = 0
function ok(cond, label, detail) {
  if (cond) {
    passed++
    console.log(`  ok  ${label}`)
  } else {
    failed++
    console.error(`  FAIL ${label}${detail !== undefined ? `\n       ${String(detail).slice(0, 600)}` : ''}`)
  }
}

const shared = await import('../shared/chat-tools.ts')
const bots = await import('../shared/chatbots.ts')
const { ChatAgentOps, openChatTabQuietly } = await import('../electron/chat-panes/agent-ops.ts')
const { LayoutEngine } = await import('../electron/layout-engine.ts')
const { makeTab } = await import('../shared/workspace.ts')

/* ------------------------------------------------------------- 1. the words */

console.log('the words: the bridge copy agrees with shared/chat-tools.ts')
const bridge = await import('../bridge/chat-tools.mjs')
ok(bridge.CHAT_INSTRUCTION_LINE === shared.CHAT_INSTRUCTION_LINE, 'the instruction line, word for word')
ok(
  JSON.stringify(bridge.CHAT_TOOLS.map((t) => t.name)) === JSON.stringify([...shared.CHAT_TOOL_NAMES]),
  'the same three tools, in the same order',
  JSON.stringify(bridge.CHAT_TOOLS.map((t) => t.name))
)
for (const spec of shared.CHAT_TOOL_SPECS) {
  const copy = bridge.CHAT_TOOLS.find((t) => t.name === spec.name)
  ok(copy?.description === spec.description, `${spec.name}: description word for word`, copy?.description)
  ok(JSON.stringify(copy?.inputSchema) === JSON.stringify(spec.parameters), `${spec.name}: schema matches`, JSON.stringify(copy?.inputSchema))
}
ok(Object.keys(bridge.CHAT_HANDLERS).sort().join() === [...shared.CHAT_TOOL_NAMES].sort().join(), 'a handler per tool')

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
ok(/\.\.\.CHAT_TOOLS\b/.test(read('bridge/gemini-bridge.mjs')) && /\.\.\.CHAT_HANDLERS\b/.test(read('bridge/gemini-bridge.mjs')), 'forge-bridge lists and answers them')
ok(/CHAT_TOOLS/.test(read('bridge/share-bridge.mjs')) && /CHAT_HANDLERS/.test(read('bridge/share-bridge.mjs')), 'forge-share carries them for the CLIs whose only server it is')
ok(/brainChatTools\(\)/.test(read('electron/voice-agent/host.ts')) && /BRAIN_CHAT_ALLOWED/.test(read('electron/voice-agent/host.ts')), 'the brain has them, and they are allowed')
ok(/CHAT_REALTIME_TOOLS/.test(read('src/lib/realtime/tools.ts')) && /runChatHubTool/.test(read('src/lib/realtime/tools.ts')), 'the realtime voice brains have them')
ok(/CHAT_TOOL_SPECS/.test(read('electron/foreman/host.ts')) && /runChatTool/.test(read('electron/foreman/ipc.ts')), 'Foreman has them')
ok(/chatOp: runChatOp/.test(read('electron/browser-panes/ipc.ts')), 'the browser link routes them to the chat tabs')
const reg = await import('../electron/bridge/cli-register.ts')
ok(reg.BROWSER_INSTRUCTION_LINE.includes(shared.CHAT_INSTRUCTION_LINE), "every CLI's instructions line carries the chat line")

console.log('bots from words')
for (const [words, want] of [
  ['gemini', 'gemini'],
  ['Gemini', 'gemini'],
  ['bard', 'gemini'],
  ['ChatGPT', 'chatgpt'],
  ['chat gpt', 'chatgpt'],
  ['gpt', 'chatgpt'],
  ['openai', 'chatgpt'],
  ['claude', 'claude'],
  ['claude.ai', 'claude'],
  ['grok', null],
  ['', null]
]) {
  ok(bots.chatBotFromWords(words) === want, `"${words}" → ${want}`, bots.chatBotFromWords(words))
}
for (const id of bots.CHATBOT_ORDER) {
  const d = bots.CHATBOTS[id].drive
  ok(['composer', 'send', 'busy', 'reply', 'user'].every((k) => Array.isArray(d[k]) && d[k].length > 0), `${id}: every drive list has a selector`)
}

/* ------------------------------------------------------ 2. which chat it is */

console.log('which chat: ids, names, projects, and a new tab when there is none')

/** A layout engine over three in-memory projects. */
function makeLayout(seed) {
  const saved = new Map(Object.entries(seed))
  const engine = new LayoutEngine({
    load: (id) => saved.get(id) ?? null,
    save: (id, ws) => saved.set(id, ws),
    projects: () => [{ id: 'bet' }, { id: 'forge' }, { id: 'home' }]
  })
  return { engine, saved }
}

const shell = makeTab('pwsh', [], 0)
const chatTab = (bot, id) => ({ id: `tab-${id}`, title: bot, root: { type: 'chat', id, bot, title: bot }, activePaneId: id })
const seed = {
  bet: { tabs: [shell.tab], activeTabId: shell.tab.id, viewMode: 'tabs' },
  forge: { tabs: [chatTab('gemini', 'chat-forge-gem')], activeTabId: 'tab-chat-forge-gem', viewMode: 'tabs' },
  home: { tabs: [chatTab('gemini', 'chat-home-gem'), chatTab('chatgpt', 'chat-home-gpt')], activeTabId: 'tab-chat-home-gem', viewMode: 'tabs' }
}

/** A page that is always ready and answers reads with what it is told to. */
function staticPage(state) {
  return {
    alive: () => true,
    url: () => state.url ?? 'https://example.test/',
    settled: async () => {},
    load: async () => {},
    insertText: async () => {},
    pressEnter: () => {},
    run: async (script) => {
      if (script.includes('composer: !!box')) {
        return { composer: state.composer !== false, draft: state.draft ?? '', canSend: true, busy: false, replies: 1, users: 1, lastReply: 'An old reply.', title: 'Chat' }
      }
      if (script.includes('compareDocumentPosition')) {
        return { messages: [{ role: 'user', text: 'Hi' }, { role: 'bot', text: 'An old reply.' }], page: '' }
      }
      state.touched = (state.touched ?? 0) + 1
      return null
    }
  }
}

function makeOps(layout, pageState = {}) {
  const pages = []
  const ops = new ChatAgentOps({
    projects: () => [
      { id: 'bet', name: 'Bet365' },
      { id: 'forge', name: 'Forge' },
      { id: 'home', name: 'Home' }
    ],
    workspace: (id) => layout.engine.workspace(id),
    openChatTab: (id, bot) => openChatTabQuietly(layout.engine, id, bot),
    page: (leafId, bot) => {
      pages.push({ leafId, bot })
      return staticPage(pageState)
    },
    openPage: () => null,
    signedIn: async () => true,
    sleep: async () => {}
  })
  return { ops, pages }
}

{
  const layout = makeLayout(structuredClone(seed))
  const { ops, pages } = makeOps(layout)

  const list = await ops.run('chat_list', {}, { project: 'bet', screenProject: 'forge' })
  ok(list.ok && /chat-forge-gem: Gemini, project Forge/.test(list.text) && /chat-home-gpt: ChatGPT, project Home/.test(list.text), 'chat_list names every chat, its bot and project', list.text)

  let r = await ops.run('chat_read', { chat: 'chat-home-gem' }, { project: 'bet', screenProject: 'forge' })
  ok(r.ok && pages.at(-1)?.leafId === 'chat-home-gem', 'an id is exact, whatever project it is in', r.text)
  ok(/latest reply:\n\nAn old reply\./.test(r.text), 'chat_read with no count is the latest reply', r.text)

  r = await ops.run('chat_read', { chat: 'gemini' }, { project: 'home', screenProject: 'forge' })
  ok(pages.at(-1)?.leafId === 'chat-home-gem', "by name, the caller's own project first", pages.at(-1)?.leafId)

  r = await ops.run('chat_read', { chat: 'Gemini' }, { project: 'bet', screenProject: 'forge' })
  ok(pages.at(-1)?.leafId === 'chat-forge-gem', 'then the project on screen (Steve opened Gemini in another project)', pages.at(-1)?.leafId)

  r = await ops.run('chat_read', { chat: 'chatgpt' }, { project: 'bet', screenProject: 'forge' })
  ok(pages.at(-1)?.leafId === 'chat-home-gpt', 'then any project', pages.at(-1)?.leafId)

  r = await ops.run('chat_read', { chat: 'claude' }, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok && /no Claude tab open/.test(r.text), 'chat_read never opens a tab', r.text)

  r = await ops.run('chat_read', { chat: 'grok' }, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok && /no chat called "grok"/.test(r.text) && /Chats open now/.test(r.text), 'an unknown chat is refused, with the list', r.text)

  r = await ops.run('chat_read', { chat: 'home', messages: 5 }, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok, 'a project name is not a chat', r.text)

  r = await ops.run('chat_read', { chat: 'chat-home-gem', messages: 5 }, { project: 'bet', screenProject: 'forge' })
  ok(r.ok && /User:\nHi\n\nGemini:\nAn old reply\./.test(r.text), 'chat_read with messages gives both sides, named', r.text)

  // chat_send with a bot that has no tab anywhere: one opens in the caller's project.
  const before = layout.engine.workspace('bet')
  r = await ops.run('chat_send', { chat: 'claude', text: 'Hello', wait: false }, { project: 'bet', screenProject: 'forge' })
  const after = layout.engine.workspace('bet')
  const added = after.tabs.find((t) => t.root?.type === 'chat')
  ok(!!added && added.root.bot === 'claude', "a Claude tab is added to the caller's project", JSON.stringify(after.tabs.map((t) => t.root?.type)))
  ok(after.activeTabId === before.activeTabId, 'and the tab Steve was on stays on screen', `${before.activeTabId} → ${after.activeTabId}`)
  ok(layout.saved.get('bet')?.tabs.length === 2, 'and it is saved (so the desk and phone are told)')
  ok(pages.at(-1)?.leafId === added?.root.id, 'and the new chat is the one driven')
}

{
  // Tab limit: a project already holding its tabs is refused in words.
  const { MAX_TABS_PER_PROJECT } = await import('../shared/ipc.ts')
  const full = structuredClone(seed)
  let cursor = 0
  full.bet.tabs = []
  for (let i = 0; i < MAX_TABS_PER_PROJECT; i++) {
    const made = makeTab('pwsh', full.bet.tabs, cursor)
    cursor = made.cursor
    full.bet.tabs.push(made.tab)
  }
  full.bet.activeTabId = full.bet.tabs[0].id
  const layout = makeLayout(full)
  const { ops } = makeOps(layout)
  const r = await ops.run('chat_send', { chat: 'claude', text: 'Hello' }, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok && /could not be opened/.test(r.text) && /Nothing was sent/.test(r.text), 'a full project is refused, and says nothing was sent', r.text)
}

/* ------------------------------------------- 2b. over the real pipe, end to end */

console.log("over the real pipe: a pane agent's bridge tool → Forge's link → the chat ops")
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { BrowserLink } = await import('../electron/browser-panes/link.ts')
  const dir = mkdtempSync(join(tmpdir(), 'chat-tools-'))
  const layout = makeLayout(structuredClone(seed))
  const { ops, pages } = makeOps(layout)
  const callers = []
  // What electron/browser-panes/service.ts does with a chat op: the pane's own project, and the one on screen.
  const link = new BrowserLink(dir, async (op, args, caller) => {
    callers.push(caller.id)
    return ops.run(op, args, { project: caller.id === 'pane:zeb-1' ? 'home' : '', screenProject: 'forge' })
  })
  await link.listen()
  const env = { ...process.env }
  process.env.FORGE_BROWSER_LINK_FILE = link.linkFile
  process.env.FORGE_PANE_ID = 'zeb-1'
  try {
    const listed = await bridge.CHAT_HANDLERS.chat_list({})
    ok(!listed.isError && /chat-home-gpt: ChatGPT, project Home/.test(listed.content[0].text), 'chat_list comes back over the pipe', JSON.stringify(listed))
    const got = await bridge.CHAT_HANDLERS.chat_read({ chat: 'gemini' })
    ok(!got.isError && callers.at(-1) === 'pane:zeb-1', 'the calling pane arrives as the caller', callers.at(-1))
    ok(pages.at(-1)?.leafId === 'chat-home-gem', "and its own project's Gemini is the one read", pages.at(-1)?.leafId)
    const refused = await bridge.CHAT_HANDLERS.chat_send({ chat: 'grok', text: 'hi' })
    ok(refused.isError === true && /no chat called "grok"/.test(refused.content[0].text), 'a refusal comes back as a tool error, in words', JSON.stringify(refused))
    process.env.FORGE_BROWSER_LINK_FILE = join(dir, 'missing.json')
    const gone = await bridge.CHAT_HANDLERS.chat_send({ chat: 'gemini', text: 'hi' })
    ok(gone.isError === true && /not reachable/.test(gone.content[0].text) && /Nothing was sent/.test(gone.content[0].text), 'Forge not running is said so, nothing sent', gone.content[0].text)
  } finally {
    for (const k of ['FORGE_BROWSER_LINK_FILE', 'FORGE_PANE_ID']) {
      if (env[k] === undefined) delete process.env[k]
      else process.env[k] = env[k]
    }
    link.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------ 3. refusals */

console.log("refusals: Steve's own words stay his")
{
  const layout = makeLayout(structuredClone(seed))
  const state = { draft: 'Remember to buy milk' }
  const { ops } = makeOps(layout, state)
  let r = await ops.run('chat_send', { chat: 'chat-forge-gem', text: 'Track my bet' }, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok && /already holds unsent words/.test(r.text) && /Remember to buy milk/.test(r.text), 'a half-written message is never typed over', r.text)
  ok(!state.touched, 'and nothing was typed or pressed')

  state.draft = ''
  state.composer = false
  r = await ops.run('chat_send', { chat: 'chat-forge-gem', text: 'Track my bet' }, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok && /shows no message box/.test(r.text) && /Nothing was sent/.test(r.text), 'no message box (sign-in, a "verify you are human") is said so, nothing sent', r.text)

  r = await ops.run('chat_send', { chat: 'gemini', text: '   ' }, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok && /empty/.test(r.text), 'an empty message is refused')
  r = await ops.run('chat_send', { chat: 'gemini', text: 'x'.repeat(shared.CHAT_SEND_MAX + 1) }, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok && /over the/.test(r.text), 'an over-long message is refused')
  r = await ops.run('chat_wipe', {}, { project: 'bet', screenProject: 'forge' })
  ok(!r.ok, 'an unknown op is refused')
}

/* ------------------------------------------------ 4. the scripts, in Chromium */

console.log('the page scripts, in a real Chromium, against stand-in pages')

/**
 * Stand-ins for the three sites: the elements each bot's drive selectors name,
 * and just enough behaviour — a send that is disabled while the box is empty,
 * a Stop button while the reply streams in, the reply arriving in pieces.
 * Claude's has no send button, so its message goes by Enter.
 */
const STREAM = `
  function stream(target, words, onDone) {
    let i = 0
    const tick = () => {
      target.textContent += (i ? ' ' : '') + words[i++]
      if (i < words.length) setTimeout(tick, 120)
      else onDone()
    }
    setTimeout(tick, 300)
  }
  const replyTo = (text) => ('Got it: ' + text.replace(/\\s+/g, ' ').trim()).split(' ')
`
const PAGES = {
  chatgpt: `<!doctype html><title>ChatGPT</title><main id="thread"></main>
    <form><div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
    <button type="button" data-testid="send-button" disabled>Send</button></form>
    <script>${STREAM}
      const box = document.getElementById('prompt-textarea')
      const send = document.querySelector('[data-testid="send-button"]')
      box.addEventListener('input', () => { send.disabled = !box.innerText.trim() })
      send.addEventListener('click', () => {
        const text = box.innerText
        const u = document.createElement('div'); u.dataset.messageAuthorRole = 'user'; u.textContent = text; thread.append(u)
        box.innerHTML = ''; send.disabled = true
        const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; stop.textContent = 'Stop'; document.body.append(stop)
        const a = document.createElement('div'); a.dataset.messageAuthorRole = 'assistant'; thread.append(a)
        stream(a, replyTo(text), () => stop.remove())
      })
    </script>`,
  gemini: `<!doctype html><title>Gemini</title><div id="chat"><user-query><div class="query-text">Earlier question</div></user-query>
    <model-response><message-content>Earlier answer</message-content></model-response></div>
    <rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
    <button class="send-button" aria-label="Send message">Send</button>
    <script>${STREAM}
      const box = document.querySelector('.ql-editor')
      const send = document.querySelector('.send-button')
      send.addEventListener('click', () => {
        if (send.classList.contains('stop')) return
        const text = box.innerText
        if (!text.trim()) return
        const q = document.createElement('user-query'); q.innerHTML = '<div class="query-text"></div>'; q.firstChild.textContent = text; chat.append(q)
        box.innerHTML = ''
        send.classList.add('stop')
        const r = document.createElement('model-response'); const c = document.createElement('message-content'); r.append(c); chat.append(r)
        stream(c, replyTo(text), () => send.classList.remove('stop'))
      })
    </script>`,
  claude: `<!doctype html><title>Claude</title><div id="thread"></div>
    <div class="ProseMirror" contenteditable="true"></div>
    <script>${STREAM}
      const box = document.querySelector('.ProseMirror')
      box.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return
        e.preventDefault()
        const text = box.innerText
        if (!text.trim()) return
        const u = document.createElement('div'); u.dataset.testid = 'user-message'; u.textContent = text; thread.append(u)
        box.innerHTML = ''
        const wrap = document.createElement('div'); wrap.dataset.isStreaming = 'true'
        const r = document.createElement('div'); r.className = 'font-claude-response'; wrap.append(r); thread.append(wrap)
        stream(r, replyTo(text), () => { wrap.dataset.isStreaming = 'false' })
      })
    </script>`
}

async function launchChromium() {
  let chromium
  try {
    ;({ chromium } = await import('playwright-core'))
  } catch (err) {
    return { skip: `no browser driver (${String(err?.message ?? err).split('\n')[0]})` }
  }
  const paths = [process.env.FORGE_CHROMIUM, '/opt/pw-browsers/chromium'].filter((p) => p && existsSync(p))
  const tries = [{ channel: 'chrome' }, ...paths.map((executablePath) => ({ executablePath }))]
  for (const opts of tries) {
    try {
      return { browser: await chromium.launch(opts) }
    } catch {
      /* the next one */
    }
  }
  return { skip: 'no Chromium to drive (set FORGE_CHROMIUM to one)' }
}

const launched = await launchChromium()
if (launched.skip) {
  console.log(`  --  ${launched.skip}; the in-page half is skipped`)
} else {
  const browser = launched.browser
  try {
    for (const bot of bots.CHATBOT_ORDER) {
      const tab = await browser.newPage()
      await tab.setContent(PAGES[bot])
      const page = {
        alive: () => !tab.isClosed(),
        url: () => tab.url(),
        settled: async () => {},
        load: async () => {
          await tab.setContent(PAGES[bot])
        },
        insertText: (text) => tab.keyboard.insertText(text),
        pressEnter: () => void tab.keyboard.press('Enter'),
        run: (script) => tab.evaluate(script)
      }
      const leafId = `chat-${bot}`
      const ops = new ChatAgentOps({
        projects: () => [{ id: 'p', name: 'Bet365' }],
        workspace: () => ({ tabs: [chatTab(bot, leafId)], activeTabId: `tab-${leafId}`, viewMode: 'tabs' }),
        openChatTab: () => ({ ok: false, error: 'not in this check' }),
        page: () => page,
        openPage: () => ({ url: tab.url(), title: bot }),
        signedIn: async () => true
      })
      const name = bots.CHATBOTS[bot].name
      const message = 'Track my treble YK5618858711I.\nLeg 1: Armenia v Montenegro over 1.5.'
      const r = await ops.run('chat_send', { chat: bot, text: message }, { project: 'p', screenProject: 'p' })
      ok(r.ok, `${name}: chat_send sends`, r.text)
      ok(new RegExp(`${name} replied:\\n\\nGot it: Track my treble YK5618858711I\\. Leg 1: Armenia v Montenegro over 1\\.5\\.$`).test(r.text), `${name}: and returns the whole reply, once it stopped streaming`, r.text)
      const box = await tab.evaluate(`(${JSON.stringify(bots.CHATBOTS[bot].drive.composer)}).map((s) => document.querySelector(s)).find(Boolean).innerText.trim()`)
      ok(box === '', `${name}: the box is empty afterwards`, JSON.stringify(box))
      const users = await tab.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(bots.CHATBOTS[bot].drive.user.at(-1))})).map((e) => e.innerText)`)
      ok(users.at(-1)?.includes('Leg 1: Armenia'), `${name}: the whole message arrived, second line included`, JSON.stringify(users))

      const again = await ops.run('chat_read', { chat: bot, messages: 2 }, { project: 'p', screenProject: 'p' })
      ok(again.ok && /User:\nTrack my treble/.test(again.text) && new RegExp(`${name}:\\nGot it:`).test(again.text), `${name}: chat_read gives both sides back`, again.text)

      const quick = await ops.run('chat_send', { chat: bot, text: 'Second message', wait: false }, { project: 'p', screenProject: 'p' })
      ok(quick.ok && /Not waiting for the reply/.test(quick.text), `${name}: wait false answers once it is sent`, quick.text)
      await tab.waitForTimeout(3500)
      const later = await ops.run('chat_read', { chat: bot }, { project: 'p', screenProject: 'p' })
      ok(later.ok && /latest reply:\n\nGot it: Second message$/.test(later.text), `${name}: chat_read collects the reply later`, later.text)
      await tab.close()
    }
  } finally {
    await browser.close()
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
