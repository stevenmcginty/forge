/**
 * A chat tab on a phone: the pure half of the wire.
 *
 *   node scripts/chat-mirror-check.mjs
 *
 * shared/chat-mirror.ts is what stands between a socket and an offscreen chat
 * page on the desktop, so what a `chat:*` frame is allowed to say is decided in
 * one function (`readChatClientFrame`) and checked here: every shape it accepts,
 * the clamps it applies, and the garbage it refuses. The other pure part is
 * where a tap on the phone's picture lands on the page (`mapToPage`), including
 * the letterbox bars when the picture and the box are different shapes.
 *
 * Driven through node:module's type-stripping hook, the same trick
 * scripts/layout-engine-check.mjs uses, so the shipped file is what runs.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const {
  CHAT_MAX_DPR,
  CHAT_MAX_HEIGHT,
  CHAT_MAX_WIDTH,
  CHAT_MIN_SIDE,
  MAX_CHAT_SCROLL,
  MAX_CHAT_TEXT,
  mapToPage,
  readChatClientFrame,
  scaleToPage
} = await import('../shared/chat-mirror.ts')
const { parseFrame } = await import('../shared/web.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (frame) => readChatClientFrame(frame)

console.log('message shapes')
{
  const watch = read({ type: 'chat:watch', leafId: 'chat-1', width: 390.4, height: 700, dpr: 3 })
  ok(
    same(watch, { type: 'chat:watch', leafId: 'chat-1', width: 390, height: 700, dpr: CHAT_MAX_DPR }),
    'a watch is read, rounded, and its dpr held at the ceiling',
    JSON.stringify(watch)
  )
  const tiny = read({ type: 'chat:watch', leafId: 'chat-1', width: 1, height: 99999, dpr: 0 })
  ok(
    tiny?.width === CHAT_MIN_SIDE && tiny?.height === CHAT_MAX_HEIGHT && tiny?.dpr === 1,
    'a watch size is clamped into the limits',
    JSON.stringify(tiny)
  )
  ok(read({ type: 'chat:watch', leafId: 'chat-1', width: 'wide', height: 700 }) === null, 'a watch without numbers is refused')
  ok(read({ type: 'chat:watch', width: 390, height: 700 }) === null, 'a frame without a leaf id is refused')
  ok(read({ type: 'chat:watch', leafId: 'x'.repeat(129), width: 390, height: 700 }) === null, 'an overlong leaf id is refused')
  ok(same(read({ type: 'chat:unwatch', leafId: 'chat-1', extra: 1 }), { type: 'chat:unwatch', leafId: 'chat-1' }), 'an unwatch is read, extras dropped')
  ok(
    same(read({ type: 'chat:focusComposer', leafId: 'chat-1' }), { type: 'chat:focusComposer', leafId: 'chat-1' }),
    'a focusComposer is read'
  )

  const tap = read({ type: 'chat:input', leafId: 'chat-1', kind: 'tap', x: 10.6, y: -5 })
  ok(same(tap, { type: 'chat:input', leafId: 'chat-1', kind: 'tap', x: 11, y: 0 }), 'a tap is rounded and held on the page', JSON.stringify(tap))
  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'tap', x: 10 }) === null, 'a tap without both coordinates is refused')
  const far = read({ type: 'chat:input', leafId: 'chat-1', kind: 'tap', x: 1e9, y: 1e9 })
  ok(far?.x === CHAT_MAX_WIDTH && far?.y === CHAT_MAX_HEIGHT, 'a tap off the edge is held at the largest page')

  const scroll = read({ type: 'chat:input', leafId: 'chat-1', kind: 'scroll', x: 5, y: 5, dy: -1e9 })
  ok(scroll?.dy === -MAX_CHAT_SCROLL, 'a scroll is clamped', JSON.stringify(scroll))
  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'scroll', x: 5, y: 5, dy: 0 }) === null, 'a scroll of nothing is refused')
  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'scroll', x: 5, y: 5, dy: Number.NaN }) === null, 'a NaN scroll is refused')

  ok(
    same(read({ type: 'chat:input', leafId: 'chat-1', kind: 'text', text: 'hello' }), {
      type: 'chat:input',
      leafId: 'chat-1',
      kind: 'text',
      text: 'hello'
    }),
    'text is read as sent'
  )
  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'text', text: '' }) === null, 'empty text is refused')
  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'text', text: 'x'.repeat(MAX_CHAT_TEXT + 1) }) === null, 'overlong text is refused')
  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'text', text: 42 }) === null, 'non-string text is refused')

  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'key', key: 'Enter' })?.key === 'Enter', 'Enter is a key')
  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'key', key: 'F12' }) === null, 'a key outside the list is refused')
  ok(read({ type: 'chat:input', leafId: 'chat-1', kind: 'click', x: 1, y: 1 }) === null, 'an unknown kind is refused')
  ok(read({ type: 'chat:frame', leafId: 'chat-1' }) === null, 'a desk-to-browser type is not a browser frame')
  ok(read(null) === null && read([]) === null && read('chat:watch') === null, 'non-objects are refused')

  for (const type of ['chat:watch', 'chat:unwatch', 'chat:input', 'chat:focusComposer']) {
    ok(parseFrame(JSON.stringify({ type, leafId: 'chat-1' }))?.type === type, `parseFrame admits ${type}`)
  }
  ok(parseFrame(JSON.stringify({ type: 'chat:frame', leafId: 'chat-1' })) === null, 'parseFrame does not admit chat:frame from a browser')
}

console.log('tap scaling')
{
  const page = { width: 390, height: 700 }
  ok(same(mapToPage({ x: 195, y: 350 }, page, page), { x: 195, y: 350 }), 'same size: a point is itself')
  ok(same(mapToPage({ x: 0, y: 0 }, page, page), { x: 0, y: 0 }), 'the top-left corner is the page origin')
  ok(same(mapToPage({ x: 390, y: 700 }, page, page), { x: 389, y: 699 }), 'the far corner is held inside the page')

  // Drawn at half size in a box of the same shape.
  const half = { width: 195, height: 350 }
  ok(same(mapToPage({ x: 100, y: 50 }, half, page), { x: 200, y: 100 }), 'a half-size picture maps to twice the distance')

  // A wider box than the page: bars left and right. scale = 700/700 = 1, bars of (600-390)/2 = 105px.
  const wide = { width: 600, height: 700 }
  ok(mapToPage({ x: 50, y: 300 }, wide, page) === null, 'a tap in the left bar is on no part of the page')
  ok(mapToPage({ x: 560, y: 300 }, wide, page) === null, 'a tap in the right bar is on no part of the page')
  ok(same(mapToPage({ x: 105, y: 300 }, wide, page), { x: 0, y: 300 }), 'the bar edge is the page edge')
  ok(same(mapToPage({ x: 300, y: 10 }, wide, page), { x: 195, y: 10 }), 'the middle of the box is the middle of the page')

  // A taller box: bars top and bottom. scale = 390/390 = 1, bars of (900-700)/2 = 100px.
  const tall = { width: 390, height: 900 }
  ok(mapToPage({ x: 100, y: 50 }, tall, page) === null, 'a tap in the top bar is refused')
  ok(same(mapToPage({ x: 100, y: 150 }, tall, page), { x: 100, y: 50 }), 'below the top bar lands 100px higher on the page')

  ok(mapToPage({ x: 1, y: 1 }, { width: 0, height: 0 }, page) === null, 'an unmeasured box maps nowhere')
  ok(mapToPage({ x: 1, y: 1 }, page, { width: 0, height: 0 }) === null, 'before the first frame, nowhere')

  ok(scaleToPage(100, half, page) === 200, 'a finger travel on a half-size picture is twice as far on the page')
  ok(scaleToPage(-30, page, page) === -30, 'a travel keeps its sign')
  ok(scaleToPage(10, page, { width: 0, height: 0 }) === 0, 'no page yet: no scroll')
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
