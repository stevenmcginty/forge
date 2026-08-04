/** Smoke-test the GPT-5.6 Luna voice route through Forge's real host. */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (!((context?.parentURL ?? '').includes('/node_modules/')) && spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
      return next(`${spec}.ts`, context)
    }
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { VoiceAgentHost } = await import('../electron/voice-agent/host.ts')
const events = []
const host = new VoiceAgentHost({
  sendEvent(event) {
    events.push(event)
    if (event.type === 'assistant') console.log(`reply: ${event.text}`)
  },
  sendToolRequest() {},
  getModel: () => 'gpt-5.6-luna'
})

const result = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Luna did not answer within 90 seconds')), 90_000)
  const check = () => {
    const event = events.find((item) => item.type === 'result')
    if (!event) return setTimeout(check, 50)
    clearTimeout(timer)
    resolve(event)
  }
  check()
})

host.start({ cwd: process.cwd() })
host.sendUtterance('Reply with exactly: FORGE_LUNA_VOICE_OK')
const event = await result
host.dispose()

if (!event.ok || !/FORGE_LUNA_VOICE_OK/.test(event.text)) {
  throw new Error(`Unexpected Luna result: ${JSON.stringify(event)}`)
}
console.log('GPT-5.6 Luna voice route passed')
