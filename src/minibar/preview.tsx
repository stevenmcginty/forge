import { createRoot } from 'react-dom/client'
import '@/theme/global.css'
import { fakeApi, scene } from './fixtures'
import { MB_MAX_W, MB_MIN_W, MB_PAD_X, MiniBarView } from './MiniBarView'

/**
 * Design preview: the mini bar's transparent window, drawn over a desktop
 * that is deliberately busy — a wallpaper, a white web page and a dark code
 * editor under the bar — so its edge can be judged on light and dark at once.
 * `?scene=` picks a fixture (fixtures.ts SCENES), `&light=1` the Paper theme.
 */

const params = new URLSearchParams(location.search)
const name = params.get('scene') ?? 'idle'
const state = scene(name, params.get('light') === '1')
const api = fakeApi((line) => {
  const w = window as unknown as { __mbLog?: string[] }
  ;(w.__mbLog ??= []).push(line)
})

const TASKBAR = 48
const barW = Math.min(MB_MAX_W, Math.max(MB_MIN_W, Math.round(window.innerWidth * 0.94)))
const winW = barW + 2 * MB_PAD_X

const host = document.getElementById('root')!
host.style.cssText = 'position:fixed;inset:0;'

createRoot(host).render(
  <>
    <Desktop />
    {/* The window: bottom-centred, 12px over the taskbar (less its shadow room). */}
    <div
      id="mb-window"
      style={{
        position: 'absolute',
        left: `calc(50% - ${winW / 2}px)`,
        width: winW,
        bottom: TASKBAR - 8,
        height: `calc(100% - ${TASKBAR}px)`,
        pointerEvents: 'auto'
      }}
    >
      <MiniBarView state={state} api={api} />
    </div>
  </>
)

function Desktop(): React.ReactNode {
  const lines = (n: number, seed: number): number[] => Array.from({ length: n }, (_, i) => 38 + ((i * 37 + seed * 13) % 55))
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background:
          'radial-gradient(60% 70% at 18% 22%, #f2a65a 0%, rgba(242,166,90,0) 60%), radial-gradient(50% 60% at 82% 78%, #3f7fd6 0%, rgba(63,127,214,0) 62%), radial-gradient(40% 45% at 60% 20%, #e8e1c8 0%, rgba(232,225,200,0) 70%), linear-gradient(135deg, #1d3247 0%, #6a4a7d 55%, #e07a5f 100%)'
      }}
    >
      {/* A white web page: the bar must hold its shape on near-white. */}
      <div style={{ position: 'absolute', left: '3%', top: '5%', width: '60%', height: '86%', background: '#ffffff', borderRadius: 8, boxShadow: '0 10px 40px rgba(0,0,0,.35)', overflow: 'hidden', fontFamily: 'Segoe UI, sans-serif' }}>
        <div style={{ height: 36, background: '#dfe3e8', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
          <span style={{ width: 180, height: 22, background: '#fff', borderRadius: '8px 8px 0 0', marginTop: 14 }} />
          <span style={{ width: 140, height: 22, background: '#cfd4da', borderRadius: '8px 8px 0 0', marginTop: 14 }} />
        </div>
        <div style={{ height: 38, borderBottom: '1px solid #e3e6ea', display: 'flex', alignItems: 'center', padding: '0 14px' }}>
          <span style={{ flex: 1, height: 24, borderRadius: 12, background: '#f1f3f4' }} />
        </div>
        <div style={{ height: 120, background: 'linear-gradient(90deg,#1a73e8,#4f9cf9)', margin: 24, borderRadius: 10 }} />
        <div style={{ padding: '0 24px', color: '#202124' }}>
          <div style={{ fontSize: 26, fontWeight: 700, marginBottom: 14 }}>Planning applications near St Albans</div>
          {lines(14, 1).map((w, i) => (
            <div key={i} style={{ height: 10, width: `${w}%`, background: i % 5 === 0 ? '#1a73e8' : '#c9ccd1', borderRadius: 5, margin: '12px 0' }} />
          ))}
        </div>
      </div>
      {/* A dark code editor: the bar must lift off near-black too. */}
      <div style={{ position: 'absolute', right: '2%', top: '12%', width: '38%', height: '80%', background: '#1e1e1e', borderRadius: 8, boxShadow: '0 10px 40px rgba(0,0,0,.5)', overflow: 'hidden', padding: '40px 18px', fontFamily: 'Cascadia Mono, Consolas, monospace' }}>
        {lines(24, 3).map((w, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, margin: '9px 0' }}>
            <span style={{ width: 18, height: 8, background: '#3c3c3c', borderRadius: 3 }} />
            <span style={{ height: 8, width: `${w * 0.5}%`, marginLeft: (i % 4) * 14, background: ['#569cd6', '#ce9178', '#9cdcfe', '#c586c0', '#6a9955'][i % 5], borderRadius: 3, opacity: 0.85 }} />
          </div>
        ))}
      </div>
      {/* The taskbar. */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: TASKBAR, background: 'rgba(32,32,32,.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        {['#0078d4', '#f3f3f3', '#e8a33d', '#3c9a5f', '#c74634', '#8a5cf6'].map((c) => (
          <span key={c} style={{ width: 26, height: 26, borderRadius: 6, background: c, opacity: 0.9 }} />
        ))}
      </div>
    </div>
  )
}
