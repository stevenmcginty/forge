# Forge Mobile — your terminals, from your phone

Forge Mobile is Forge's own phone app: the real projects, the real tabs, the
real terminals, driven from a handset. Not the Claude app, not a session list —
Forge, with a keyboard.

All of it is built: the desktop half, the phone app, the installable APK, and a
tunnel that comes up on its own so the two find each other from anywhere with
no address to retype. **`docs/MOBILE-SETUP.md` is the once-only setup** — the
ngrok account, the two fields to paste, the first install on the handset.

The same app is still reachable from phone Chrome at the desktop's address,
which is how the APK gets debugged and what to fall back to if a build ever
misbehaves.

---

## Why this is not the Companion

Forge already has a phone link — see `companion/README.md`. It carries project
summaries, photos and messages over Firebase RTDB, and its best property is that
**both ends dial out**: neither the phone nor the desktop has to be reachable,
so it works from a car park on mobile data with no port forwarding anywhere.

That property is worth keeping. The transport is not, for terminals:

- **Echo lag.** A keystroke would go phone → RTDB → desktop → PTY → RTDB →
  phone. Two round-trips through Google's servers before the character appears.
  Fine for "send a message to the agent"; unusable for typing in a shell.
- **Volume.** `electron/pty-host.ts` flushes every 12 ms. A redrawing TUI is
  tens of writes a second, billed per byte, against a database whose per-path
  write rate was never meant for it.

So the job is split rather than the pattern abandoned. **The socket in
`electron/mobile/` carries terminal bytes. The Companion channel carries
rendezvous** — the desktop publishes where it can be reached right now, the
phone reads it and connects directly. No-NAT discovery, socket-grade latency.

The two features are complements and neither replaces
[Remote Control](REMOTE.md), which is Anthropic's, covers Claude panes only, and
is left exactly as it was.

---

## What exists

| Path | What it is |
| --- | --- |
| `shared/mobile.ts` | The wire protocol. Dependency-free; main, renderer and the phone all compile against **this** file. |
| `electron/mobile/auth.ts` | Pairing, device tokens, revocation, lockout. Electron-free. |
| `electron/mobile/server.ts` | The WebSocket server + static host. Electron-free, everything injected. |
| `electron/mobile-host.ts` | The Electron wiring: settings, the PTY sink, op forwarding, power-save. |
| `electron/mobile-tunnel.ts` | The supervised ngrok agent: one permanent public address, capped backoff, refuse-don't-retry. |
| `mobile/` | The phone app. React + xterm.js, built by Vite, importing `@shared/*`. |
| `mobile/android/` | The Capacitor shell that makes it an APK. Generated, and regenerable — `scripts/apk-init.mjs` patches it idempotently. |
| `mobile/native/*.kt` | The updater's native half, kept here as the source of truth and copied into the android tree; `apk:check` fails if the two drift. |
| `mobile/version.json` | The one place a version number is written. Vite defines and `build.gradle` are both stamped from it, so web and native cannot disagree. |
| `src/components/settings/MobileSection.tsx` | Settings › Forge Mobile: the switch, the address, the tunnel, pairing, devices. |
| `scripts/mobile-smoke.mjs` | 62 checks against the real server, real auth, real PTY, real socket — including the whole approval handshake. |
| `scripts/apk-*.mjs` | Init, build, publish, check. Signing keys live outside the repo — see below. |

`companion/`'s protocol lives in two hand-kept files and its README lists that
as known gap #7 — a field only one side reads is a bug nothing catches. Forge
Mobile does not repeat it: the phone app has a build step, so it imports
`shared/mobile.ts` directly and the compiler polices the wire.

### How output reaches the phone

`electron/pty-host.ts` gained a **sink list**. The renderer window is still the
primary consumer; `mobile-host` registers a second sink, fed from the *same*
coalesced 12 ms flush. A phone therefore cannot make the desktop chattier — it
rides the batching that already existed. A sink that throws is isolated, so one
bad consumer can never stop the window receiving output.

The 192 KB per-session **replay buffer** — the thing that stops a reloading
renderer staring at a blank window onto a live shell — is now exported as
`getReplay(id)`. A phone connecting from a train is exactly that case, so it
gets exactly that answer rather than a second mechanism that could disagree.

### How tabs get created

The phone never says "run this command". It sends an `op` frame naming a
*profile id* and a *project id*; the desktop resolves both against its own
settings. Nothing on the wire chooses a cwd or an executable.

`mobile-host` forwards the op to the renderer (`IPC.mobileCommand`) and waits
for a verdict, because the renderer owns the split tree and persists the
workspace. The phone joins the same code path a local click takes instead of
growing a parallel one in main that could disagree with it.

**Consequence worth knowing:** Forge minimised is fine; Forge with its window
closed is not. Layout ops then fail with a sentence saying so, rather than
silently doing nothing. Driving an existing terminal still works either way.

---

## The phone app

Three screens: **projects → tabs → a terminal**. Splits are deliberately not
rendered as splits — a pane tree that reads well on a 27" monitor is four
unreadable slivers on a phone, so a tab's layout is flattened to its leaves in
reading order and each becomes a row. The desktop's split structure is
untouched; this is a lens, not an edit.

A pane's id *is* its PTY session id (`PaneLeaf` in `shared/types.ts`), which is
what lets the list match layout to live sessions with a lookup rather than a
join, and what makes "not running" an honest label rather than a guess.

### The keyboard, which is the whole problem

A terminal on a phone lives or dies by its keyboard, and Android's is not a
keyboard — it is an input method that *composes*. GBoard sends autocorrect
suggestions, swipe input arrives as whole words, and predictive text can rewrite
characters already sent. xterm's hidden textarea was written for hardware keys.

Three mitigations, in `mobile/src/lib/term.ts` and the key bar:

1. Every autocorrect affordance is switched off on xterm's helper textarea,
   re-applied after `open()` because xterm creates that element itself. Without
   it GBoard capitalises the first letter of every command and turns flags into
   words.
2. A **key bar** supplies what no phone keyboard has: Esc, Tab, arrows, the
   punctuation a shell needs constantly, and **sticky Ctrl/Alt** — tap Ctrl,
   then C, and it sends `\x03`. They clear after one press like a shift key, and
   double-tap to lock, because you cannot hold one key while pressing another on
   glass.
3. A **compose row** (the ⌨︎ button): type a line into a real text field and
   send it whole. This is the escape hatch for the day the IME wins, and it is
   the better input for prompting an agent anyway — you get to read the sentence
   back before it is sent.

`inputmode` is deliberately *not* forced to `none`: on some Android versions
that hides the keyboard entirely, which is worse than composition.

Rendering is **canvas, not WebGL**. The WebGL addon is the desktop's default,
but loses its context whenever Android backgrounds the app and comes back blank.

### Resize, and why it is debounced

The soft keyboard opening is the most common resize this app will ever see. It
is watched through `visualViewport` (not just `window.resize`, because on some
Android versions only the visual viewport changes) and **debounced to the end of
the animation** — otherwise the slide would fire a `pty:resize` per frame and a
shell would reflow its prompt a dozen times on every tap. `fit()` also refuses
to run against a container with no height, which is what stops a mid-layout
measurement resizing the real PTY to nonsense.

### Reconnecting

Subscriptions are held on the phone and re-sent after every `hello-ok`, and each
is answered with the replay buffer — so a dropped socket repaints itself instead
of leaving a dead terminal on screen. Close codes 4001–4003 mean the desktop
said no, and are *not* retried: looping against a door that will not open is how
a phone's battery disappears.

### Running it

```
npm run mobile:build    # bundle to mobile/dist, which the desktop then serves
npm run mobile:dev      # or Vite on :5175, reachable from the phone over wifi
```

With a checkout, `mobile/dist` is served automatically at
`http://<desktop>:8420`. A packaged Forge ships `out/**` and nothing else, so
there it serves nothing until `FORGE_MOBILE_WEB` points at a built bundle — by
then the APK is the real client anyway.

---

## Security

Be honest about the shape of this. The protocol has no "execute" frame, but
`write` types into a live shell, so **a valid credential is a shell as Steve.**
Constraining the frames limits what an accident does; it does nothing about an
attacker holding a token. Everything therefore defends the credential, and the
network posture defends the fact that the port exists at all.

1. **Off by default.** `mobileEnabled` is `false`. Nothing binds a port, mints a
   token or accepts a connection until it is switched on — the same posture as
   the Companion.
2. **The address allowlist.** `isAllowedSource` accepts loopback, RFC1918 LAN,
   link-local, Tailscale's `100.64.0.0/10`, and unique-local IPv6. Anything else
   is closed before a byte is read, so a mis-forwarded router port is not a
   public shell. `cloudflared` is unaffected: it runs on this machine and dials
   from loopback.
3. **Tokens, not passwords.** Pairing mints a **single-use** token with a
   **5-minute TTL**, shown as a QR on the desktop screen — possession of the
   screen is the trust root. The phone exchanges it once for a 256-bit device
   token.
3a. **Approval pairing keeps that trust root and drops the typing.** A phone
   whose APK was stamped with this desktop's address can ask to be let in
   (`requestPair`) instead of carrying a code. What it gets is not entry: the
   desktop refuses outright unless Steve has armed **Accept new phones** — which
   self-disarms after ten minutes — and even armed it mints nothing until he
   taps Allow. Refused, the answer is byte-identical to any other unpaired
   phone's, so the flag cannot be used to probe whether the feature exists.

   The **word pair** shown on both screens is what makes the tap safe. With the
   tunnel up the doorbell faces the internet, so a stranger who found the
   address can ring it while it is armed; what they cannot do is guess which two
   words the phone in Steve's hand is displaying. Mismatch means Deny.

   Two limits exist because a prompt is a thing a human clicks without reading:
   **at most one approval pending**, and **at most one prompt per 60 seconds**.
   And every path that is not an explicit Allow — timeout, no window, shutdown,
   the phone hanging up — resolves to *deny*. The OS notification is a doorbell
   with no buttons: it can only bring the real prompt to the front.

   Both routes mint through the same `mintDevice`, so an approved phone is
   indistinguishable from a coded one afterwards, and the only-hashes-persist
   invariant lives in one routine rather than two that might drift.
4. **Only hashes on disk.** `settings.json` holds SHA-256 of each device token
   and never the token. The smoke test records everything ever handed to
   persistence and fails if the raw token appears in any of it.
5. **Constant-time compares** over fixed-width digests, so a wrong token leaks
   nothing about how wrong it was. A record whose `tokenHash` is not exactly 64
   hex characters is dropped by the store normaliser rather than carried into a
   comparison it would make throw.
6. **Lockout.** Five failures from one source, then 60 seconds of refusal.
7. **Revocation hangs up.** Removing a device closes its live socket
   immediately — otherwise "revoked" would only mean "revoked next time".
8. **Unauthenticated sockets are dropped**, not merely ignored: a frame before
   `hello` closes the connection, and a socket that never says `hello` is
   dropped after 10 seconds.

### If the phone is lost

Two independent kill switches. Revoke the device in Settings (its hash is
deleted and its socket closed), **or** turn `mobileEnabled` off, which closes
the server and every socket at once. On a tailnet, removing the phone from the
Tailscale admin console is a third, outside Forge entirely.

---

## Reaching the desktop from outside the house

Phase 1 works on the home LAN with no setup: switch it on, read the address off
Settings, type it into the phone.

For mobile data the built-in answer is the **ngrok tunnel** in Settings ›
Forge Mobile — see `electron/mobile-tunnel.ts`. A free ngrok account comes with
one permanent dev domain (auto-assigned, on the dashboard under Domains), so
the setup is once: paste the authtoken and that domain, switch the tunnel on,
and the phone keeps the same `wss://<domain>` address forever. Forge runs the
ngrok agent as a supervised child process, restarts it with backoff when it
drops, and refuses to retry the failures that will never succeed (bad token,
someone else's domain, no session allowance left). While the tunnel is live,
pairing hands out the tunnel URL instead of a LAN IP. Free-tier honesty: 1 GB
of transfer a month, and terminal output is the payload — fine for typing and
reading, not for tailing a firehose all day.

The alternatives keep working and nothing about them changed:

- **Cloudflare quick tunnel** — `npm run mobile:tunnel`. Zero-account, but the
  URL changes every run, which is exactly what the ngrok setting exists to end.
- **Tailscale** — a stable `100.64.0.0/10` address reachable anywhere,
  WireGuard-encrypted, already on the allowlist. Costs the phone's VPN slot.

Whichever carries it, set `mobileBindHost` to `127.0.0.1` if the tunnel should
be the *only* way in — left at `0.0.0.0`, the LAN can still reach the port
directly, and the Settings card says so rather than rewriting the choice.
Either way the socket, the protocol and the auth are identical — the transport
decision does not reach into the app.

An earlier plan had the desktop publish its current address through the
Companion's Firebase channel, so a phone could rediscover a tunnel URL that had
changed underneath it. A permanent domain removes the problem rather than
solving it: there is no moving address to announce, so that rendezvous is not
built and should not be. It becomes worth revisiting only if the transport ever
goes back to being ephemeral.

---

## Limits

- **The desktop must be awake and running.** A power-save blocker is held while
  a phone is connected, so the machine will not suspend mid-session — but
  nothing here can wake a PC that was already asleep, and if Forge is not
  running there are no sessions to attach to. Same limit Remote Control has.
- **Layout ops need the Forge window to exist** (minimised is fine). See above.
- **The limits are shared** — tabs the phone creates count against the same
  8-tab-per-project cap as tabs created at the desk, and panes against the same
  app-wide `MAX_SESSIONS` backstop.
- **One desktop.** Nothing distinguishes two machines on one account yet.
- **Last write wins** if the phone and the desktop change the same workspace at
  the same moment. One user, one desktop; stated rather than solved.

---

## Checking it

```
npm run mobile:smoke    # 62 checks: the address rules, pairing expiry and
                        # lockout release on a fake clock, refusal, pairing
                        # over the wire, replay-before-live, a real keystroke
                        # into a real pwsh and back, resize, late subscribers,
                        # ops both accepted and refused, revocation, and that
                        # no raw token is ever persisted
npm run tunnel:check    # the ngrok supervisor against a scripted fake agent:
                        # binary resolution, the exact command line, authtoken
                        # redaction, log parsing, backoff and its reset, the
                        # refuse-don't-retry rule, and that pairing hands out
                        # the tunnel URL with no port appended
npm run apk:check       # 48 checks on the APK half: version comparison, the
                        # manifest rejection matrix, a SHA-256 known-answer
                        # vector and corruption detection, the permission and
                        # FileProvider in the real AndroidManifest.xml, that
                        # build.gradle agrees with version.json, that the
                        # native templates have not drifted from the copies
                        # in the android tree, and that no key material is
                        # anywhere in the repo
npm run pty:smoke       # the sink refactor must not have touched the renderer
npm run build           # includes tsconfig.mobile.json — the phone app is
                        # typechecked against the same shared/ the desktop is
```

`mobile:smoke` proves everything a script can. It cannot prove the phone —
that the app connects over a real network and feels good to type into. That
needs a real handset, and is the one part only Steve can sign off.
