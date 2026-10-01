/**
 * brain-confirm:check — Forge Brain by voice, offline.
 *
 *  - A yes or a no to the confirm gate is one of a short fixed list, whole:
 *    "Yeah." allows, "yes but wait" is not an answer and goes to the brain.
 *  - A half-sentence is held for what follows; a whole sentence is not.
 *  - Held phrases reach the brain as one message, in the order said.
 *  - The wiring: the gate is answered in runPhrase, by code, and no voice
 *    tool can reach it.
 *
 *   node scripts/brain-confirm-check.mjs
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import './ts-hooks.mjs'

const V = await import('../src/lib/brainConfirmVoice.ts')

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`)
  }
}

console.log('\nthe gate: yes / no')

check('every yes on the list allows', () => {
  for (const said of ['yes', 'yeah', 'yep', 'yes please', 'do it', 'go ahead', 'allow', 'allow it']) {
    assert.equal(V.parseConfirmAnswer(said), 'yes', said)
  }
})

check('every no on the list refuses', () => {
  for (const said of ['no', 'nope', 'no thanks', "don't", 'do not', 'cancel', 'stop']) {
    assert.equal(V.parseConfirmAnswer(said), 'no', said)
  }
})

check('as the recogniser writes them: capitals, punctuation, spaces', () => {
  assert.equal(V.parseConfirmAnswer('Yeah.'), 'yes')
  assert.equal(V.parseConfirmAnswer('  Yes, please! '), 'yes')
  assert.equal(V.parseConfirmAnswer('Go ahead.'), 'yes')
  assert.equal(V.parseConfirmAnswer('No.'), 'no')
  assert.equal(V.parseConfirmAnswer('Don’t!'), 'no')
  assert.equal(V.parseConfirmAnswer('DO NOT'), 'no')
})

check('anything longer or different is not an answer', () => {
  for (const said of [
    'yes but wait',
    'no I meant the other one',
    'yesterday',
    '',
    '   ',
    '?!',
    'yes yes',
    'yes no',
    'okay',
    'allow it all',
    'stop listening',
    'nobody',
    'please close the tab for me'
  ]) {
    assert.equal(V.parseConfirmAnswer(said), null, JSON.stringify(said))
  }
})

console.log('\nthe gate: which question a spoken answer hits')

const T0 = 1_000_000

check('a question that was never spoken is not answered by voice', () => {
  assert.equal(V.voiceConfirmTarget(['a'], new Map(), T0), null)
  assert.equal(V.voiceConfirmTarget(['a', 'b'], new Map([['gone', T0 - 1000]]), T0), null)
  assert.equal(V.voiceConfirmTarget([], new Map([['a', T0 - 1000]]), T0), null)
})

check('spoken 5 s ago: answered', () => {
  assert.equal(V.voiceConfirmTarget(['a'], new Map([['a', T0 - 5000]]), T0), 'a')
})

check('spoken 25 s ago: not answered — the window is 20 s, at the edge and not past it', () => {
  assert.equal(V.CONFIRM_VOICE_WINDOW_MS, 20_000)
  assert.equal(V.voiceConfirmTarget(['a'], new Map([['a', T0 - 25_000]]), T0), null)
  assert.equal(V.voiceConfirmTarget(['a'], new Map([['a', T0 - 20_000]]), T0), 'a')
  assert.equal(V.voiceConfirmTarget(['a'], new Map([['a', T0 - 20_001]]), T0), null)
})

check('two spoken: the later one, not the oldest', () => {
  const spoken = new Map([
    ['a', T0 - 9000],
    ['b', T0 - 3000]
  ])
  assert.equal(V.voiceConfirmTarget(['a', 'b'], spoken, T0), 'b')
  // Re-spoken after the other was answered: it is the later one now.
  assert.equal(V.voiceConfirmTarget(['a'], new Map([...spoken, ['a', T0 - 1000]]), T0), 'a')
  // Both past the window: neither.
  assert.equal(
    V.voiceConfirmTarget(
      ['a', 'b'],
      new Map([
        ['a', T0 - 40_000],
        ['b', T0 - 21_000]
      ]),
      T0
    ),
    null
  )
  // One spoken, one not: the spoken one, wherever it is in the list.
  assert.equal(V.voiceConfirmTarget(['a', 'b'], new Map([['a', T0 - 3000]]), T0), 'a')
  assert.equal(V.voiceConfirmTarget(['a', 'b'], new Map([['b', T0 - 3000]]), T0), 'b')
})

check('not armed: the line points at the screen and no voice record is made', () => {
  const off = V.confirmQuestion('close the tab Zeb', false)
  assert.equal(off.line, 'Forge Brain asks: close the tab Zeb. Press Yes or No on screen.')
  assert.equal(off.byVoice, false)
  const on = V.confirmQuestion('close the tab Zeb.', true)
  assert.equal(on.line, 'Forge Brain asks: close the tab Zeb. Say yes or no.')
  assert.equal(on.byVoice, true)
  assert.equal(V.confirmQuestion('  ', true).line, 'Forge Brain asks: an action. Say yes or no.')
})

console.log('\nthe gather: hold a half-sentence')

check('a whole sentence is not held: 5+ words ending . ? or !', () => {
  assert.equal(V.shouldHold('Open the browser on the left.'), false)
  assert.equal(V.shouldHold('What is the brain doing right now?'), false)
  assert.equal(V.shouldHold('Close that tab for me now!'), false)
  assert.equal(V.shouldHold('one two three four five.'), false)
})

check('short, or with no end to it, is held', () => {
  assert.equal(V.shouldHold('has uh agents'), true)
  assert.equal(V.shouldHold('But um'), true)
  assert.equal(V.shouldHold('But um.'), true)
  assert.equal(V.shouldHold('one two three four.'), true)
  assert.equal(V.shouldHold('I was thinking we could build a site that'), true)
  assert.equal(V.shouldHold('I was thinking we could build a site that,'), true)
})

check('nothing said is nothing to hold', () => {
  assert.equal(V.shouldHold(''), false)
  assert.equal(V.shouldHold('   '), false)
})

check('held phrases join as one message, in order', () => {
  assert.equal(V.joinPhrases(['has uh agents', 'But um']), 'has uh agents But um')
  assert.equal(V.joinPhrases(['  one  ', '', '   ', 'two']), 'one two')
  assert.equal(V.joinPhrases(['only this']), 'only this')
  assert.equal(V.joinPhrases([]), '')
})

check('a full stop put where he only paused is dropped', () => {
  assert.equal(
    V.joinPhrases(["Site using chat GPT images. It's a virtual world that.", 'has uh agents', 'But um']),
    "Site using chat GPT images. It's a virtual world that has uh agents But um"
  )
  // A real sentence end stays: the next phrase starts a new one.
  assert.equal(V.joinPhrases(['Open the browser.', 'Then close it.']), 'Open the browser. Then close it.')
  assert.equal(V.joinPhrases(['Is it done?', 'and the tests']), 'Is it done? and the tests')
  assert.equal(V.joinPhrases(['and so...', 'yes']), 'and so... yes')
})

console.log('\nthe gather: how long')

const clock = (over) => ({ last: 'has uh agents', sinceLast: 0, sinceVoice: null, pauseMs: 800, ...over })

check('a whole sentence goes at once, whatever the mic hears', () => {
  assert.equal(V.gatherWait(clock({ last: 'Open the browser on the left.' })), 0)
  assert.equal(V.gatherWait(clock({ last: 'Open the browser on the left.', sinceVoice: 0 })), 0)
})

check('a half-sentence waits out the hold window, then goes', () => {
  assert.equal(V.GATHER_HOLD_MS, 900)
  assert.equal(V.gatherWait(clock({ sinceLast: 0 })), 900)
  assert.equal(V.gatherWait(clock({ sinceLast: 400 })), 500)
  assert.equal(V.gatherWait(clock({ sinceLast: 900 })), 0)
  assert.equal(V.gatherWait(clock({ sinceLast: 5000 })), 0)
})

check('he is speaking again: held until that phrase can land', () => {
  // Voice right now, long after the hold window: still held.
  assert.equal(V.gatherWait(clock({ sinceLast: 3000, sinceVoice: 0 })), 800 + V.GATHER_LAND_MS)
  assert.ok(V.gatherWait(clock({ sinceLast: 3000, sinceVoice: 500 })) > 0)
  // Quiet for longer than a pause plus the landing: sent.
  assert.equal(V.gatherWait(clock({ sinceLast: 5000, sinceVoice: 800 + V.GATHER_LAND_MS })), 0)
})

check('never held past the limit, even in a room that never goes quiet', () => {
  assert.equal(V.gatherWait(clock({ sinceLast: V.GATHER_MAX_MS, sinceVoice: 0 })), 0)
  assert.equal(V.gatherWait(clock({ sinceLast: V.GATHER_MAX_MS - 100, sinceVoice: 0 })), 100)
})

console.log('\nwiring')

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

check('runPhrase answers the gate after the echo guard, before the commands and the brain', () => {
  const agent = read('src/state/VoiceAgent.tsx')
  const echo = agent.indexOf('speaker.heardItself(said)')
  const gate = agent.indexOf('parseConfirmAnswer(said)')
  const grammar = agent.indexOf('parseUtterance(said, ctx)')
  assert.ok(echo > 0 && gate > echo, 'the gate is checked after the echo guard')
  assert.ok(grammar > gate, 'and before the command grammar')
})

check('a spoken answer goes through the voice target; the record is made only by a question said in full, armed', () => {
  const agent = read('src/state/VoiceAgent.tsx')
  assert.ok(agent.includes('voiceConfirmTarget('), 'runPhrase picks the question with voiceConfirmTarget')
  const records = agent.split('confirmSpokenAt.current.set(').length - 1
  assert.equal(records, 1, 'one place makes a voice record')
  assert.ok(/if \(spoke && question\.byVoice\) confirmSpokenAt\.current\.set\(/.test(agent), 'and only once the mouth says it spoke')
  assert.ok(agent.includes('next.heard?.(said.spoke && !interrupted)'), 'talked over is not heard')
  assert.ok(agent.includes('confirmQuestion(speakable(what, 240), armedRef.current)'), 'the line follows the mic: armed or not')
})

check('no model can answer the gate: no voice tool reaches the confirm', () => {
  const dir = new URL('../src/lib/realtime/', import.meta.url)
  const tools = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [f, readFileSync(new URL(f, dir), 'utf8')])
  tools.push(['agenttools.ts', read('src/lib/agenttools.ts')])
  for (const [name, source] of tools) {
    assert.ok(!/brain\??\.confirm|brain-confirm|brainConfirm/.test(source), name)
  }
})

check('Forge Web sends the answer on the wire that already exists', () => {
  assert.ok(read('web/src/lib/client.ts').includes("kind: 'brain-confirm'"))
  assert.ok(read('shared/web.ts').includes("kind: 'brain-confirm'"))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
