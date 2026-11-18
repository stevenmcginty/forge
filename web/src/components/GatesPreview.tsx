import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { ChatLeaf } from '@shared/types'
import { WEB_PROTO, type WebPasskeyRequestOptions } from '@shared/web'
import { useDeckTheme } from '../deck/theme'
import { ForgeContext, type ForgeActions, type ForgeState, type Picture } from '../state'
import { ChatMirror } from './ChatMirror'
import { Connecting, PinPrompt, Refused, VersionSkew } from './Connection'
import { Mirror } from './Mirror'
import { SignIn } from './SignIn'
import { Unpaired } from './Unpaired'

/**
 * `?preview=gates&phone` on the dev server: the screens met before the
 * workspace — sign-in, connecting, the PIN, every refusal — and the two mirror
 * views, on a fixture `ForgeContext`, so they can be looked at with no desktop
 * on the other end. Compiled out of every `vite build` by the `__DEV_SERVER__`
 * gate in main.tsx. No harness bar: the page is the phone.
 *
 * URL params:
 *  `screen=`  signin · signin-error · connecting · asleep (the connecting screen
 *             after its 5 s "still trying" turn; it arrives on its own) · pin ·
 *             pin-wrong · pin-locked · passkey · refused · busy · skew ·
 *             unpaired · mirror (the screen viewer; it asks for 15 s, then says
 *             the desktop has not answered) · chat (a chat tab's mirror)
 *  `theme=<id>` one of the eight themes
 *
 * Every action is a no-op: these are the real components, drawn, not driven.
 */

function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name)
}

/** A challenge that names nobody: the auto-try fails in a headless page, which is the "declined" look. */
const PASSKEY: WebPasskeyRequestOptions = {
  challenge: 'AAAA',
  rpId: location.hostname,
  allowCredentials: [],
  userVerification: 'required',
  timeout: 60_000
}

const CHAT: ChatLeaf = { type: 'chat', id: 'c1', bot: 'chatgpt', title: 'ChatGPT' } as ChatLeaf

export function GatesPreview(): ReactNode {
  const { themeId, setTheme } = useDeckTheme(true)
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    const first = param('theme')
    if (first && first !== themeId) setTheme(first)
  }

  const screen = param('screen') ?? 'signin'
  const inApp = screen === 'mirror' || screen === 'chat'

  const actions = useMemo(
    () =>
      new Proxy({} as ForgeActions, {
        get: (_target, key) => {
          const name = String(key)
          if (name === 'request') return () => Promise.resolve({ kind: 'failed', message: 'This is the preview.' })
          if (name.startsWith('on')) return () => () => undefined
          if (name === 'signIn') return () => new Promise(() => undefined)
          return () => undefined
        }
      }),
    []
  )

  const state = useMemo(() => {
    const picture: Picture | null = inApp
      ? {
          desktopName: 'STEVE-LAPTOP',
          appVersion: '0.0.0',
          projects: [],
          profiles: BUILTIN_AGENT_PROFILES,
          workspaces: {},
          sessions: [],
          projectsRoot: '',
          foreman: {},
          handoff: {},
          brain: null
        }
      : null
    const fixture = {
      stage: { kind: 'connected' },
      connection: { state: 'live' },
      session: { email: 'steve@example.com', created: screen === 'unpaired' },
      config: null,
      picture,
      cached: { desktopName: 'STEVE-LAPTOP' },
      projectId: null,
      git: {},
      asking: new Set(),
      busy: new Set(),
      prompts: {},
      waiting: [],
      notice: '',
      desktopRecovering: '',
      remoteYes: { enabled: false, uac: false, address: '', port: 21118 },
      warm: true,
      offlineMode: 'frozen',
      notifyPermission: 'default',
      pushActive: false,
      askBanner: null,
      brainConfirms: []
    }
    return fixture as unknown as ForgeState
  }, [inApp, screen])
  const value = useMemo(() => ({ state, actions }), [state, actions])

  // The page behind the overlays: the phone's own ground, edge to edge.
  useEffect(() => {
    document.body.style.margin = '0'
  }, [])

  return (
    <ForgeContext.Provider value={value}>
      {inApp ? (
        <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ height: '100%' }}>
          {screen === 'mirror' ? (
            <Mirror onClose={() => undefined} />
          ) : (
            <div style={{ position: 'absolute', inset: 0 }}>
              <ChatMirror leaf={CHAT} onScreen />
            </div>
          )}
        </div>
      ) : (
        <Gate screen={screen} />
      )}
    </ForgeContext.Provider>
  )
}

function Gate({ screen }: { screen: string }): ReactNode {
  switch (screen) {
    case 'signin-error':
      return <SignIn error="That email and password do not match an account." />
    case 'connecting':
    case 'asleep':
      return <Connecting attempt={0} />
    case 'pin':
      return <PinPrompt message="Enter the 4-to-8 digit PIN set on the desktop." invalid={false} />
    case 'pin-wrong':
      return <PinPrompt message="That PIN was not accepted." invalid />
    case 'pin-locked':
      return <PinPrompt message="That PIN was not accepted." invalid retryAfterMs={42_000} />
    case 'passkey':
      return <PinPrompt message="Enter the 4-to-8 digit PIN set on the desktop." invalid={false} passkey={PASSKEY} />
    case 'refused':
      return (
        <Refused
          reason="wrong-account"
          message="This desktop belongs to a different Forge account."
        />
      )
    case 'busy':
      return <Refused reason="busy" message="This desktop is not set up for Forge Web yet." retryAfterMs={60_000} />
    case 'skew':
      return (
        <VersionSkew record={{ host: 'x.example', proto: WEB_PROTO - 1, app: '0.9.1', name: 'STEVE-LAPTOP', at: Date.now() }} />
      )
    case 'unpaired':
      return <Unpaired message="No desktop has published a link for this account." />
    default:
      return <SignIn error="" />
  }
}
