# Remote Control — driving a Forge pane from your phone

Claude Code has a research-preview feature called **Remote Control**. A session
launched with `--remote-control "<name>"` keeps running on this PC, in this
pane, with this filesystem — but it also becomes visible *and drivable* from the
Claude app on your phone (Code tab) and from claude.ai/code in a browser.

Forge turns it on for Claude panes automatically. You start something in a pane,
walk away from the desk, and pick it up on the bus.

---

## What Forge does

Every pane is a real `pwsh` session, and its agent profile is *typed into* that
shell (see `electron/pty/session-manager.ts`). Every launch command passes
through one place — `electron/pty-host.ts` — where two transforms are applied,
in this order:

```
claude
  → claude --remote-control 'Forge — Claude Code'          (bridge/remote-control.ts)
  → claude --remote-control 'Forge — Claude Code' --mcp-config "…\mcp.json"   (bridge/mcp-config.ts)
```

The order matters: `--mcp-config <configs...>` is variadic, so it has to stay
last or it would swallow whatever followed it.

The name is `"<project> — <pane title>"`, composed by `remoteControlName()` in
`shared/remote.ts` and single-quoted for PowerShell. That is exactly the label
you look for in the phone's session list.

Forge only adds the flag when all of these hold:

- the app-wide **`remoteControlDefault`** setting is `true` (it is, by default);
- the pane's agent profile has **`remoteControl: true`** (the built-in *Claude
  Code* profile does; nothing else does);
- the profile's command really is Claude Code — `claude`, `claude --resume`,
  `C:\tools\claude.exe`, all fine; anything else is left completely alone, so
  renaming a profile's command to another tool degrades to a plain launch
  rather than to a broken one;
- the command does not already say `--remote-control` / `--rc`, and is not a
  one-shot `-p` / `--print` run (there is no session to drive).

Both settings live in `%APPDATA%\Forge\settings.json` and can be edited by hand.

---

## What you need

- A **claude.ai login** — Pro, Max, Team or Enterprise. Remote Control is an
  OAuth-only feature; an API key cannot do it.
- The **Claude mobile app** (Code tab), or claude.ai/code in any browser.
- On Team/Enterprise, an owner has to enable the Remote Control toggle in the
  organisation's Claude Code admin settings.
- Claude Code **v2.1.181+** for the presence marker below; the flag itself and
  the `/remote-control` slash command have been there longer. Verified against
  **v2.1.220**, which is what `npm run remote:check` probes.

### Environment variables that silently kill it

Seven variables switch Remote Control off with no error message. Four of them
disable the feature-flag evaluation that gates the research preview; three
change how Claude authenticates, and Remote Control only exists for a claude.ai
login talking to `api.anthropic.com`:

```
DISABLE_TELEMETRY                          ANTHROPIC_API_KEY
DO_NOT_TRACK                               CLAUDE_CODE_OAUTH_TOKEN
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC   ANTHROPIC_BASE_URL   (non-default)
DISABLE_GROWTHBOOK
```

Steve has some of these set globally, so **Forge strips them out of every pane's
environment** — see `ENV_DENYLIST` in `electron/pty/session-manager.ts`, which
also strips `ANTHROPIC_AUTH_TOKEN`, the Claude session markers (`CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, …) so a pane is never
mistaken for a child of the session that launched Forge, and Electron's own
injections. `npm run pty:smoke` asserts every one of them is absent from a
spawned pane even when the parent process is carrying it.

The consequence worth knowing: **a Forge pane always authenticates with your
claude.ai login.** If you need a pane running on an API key or against a
gateway, set the variable inside that pane (or from a wrapper script the profile
command points at) rather than in the environment Forge inherits.

---

## The presence marker — why your phone stays quiet

Claude Code reads `CLAUDE_CLIENT_PRESENCE_FILE`. While that file exists, it
holds back the push notifications it would otherwise send to your phone.

Forge points every pane at one shared marker, `%APPDATA%\Forge\presence`, and
runs it off window focus (`electron/presence.ts`):

| you                              | the marker      | your phone |
| -------------------------------- | --------------- | ---------- |
| have a Forge window focused      | exists          | silent     |
| alt-tab to a browser for 3s      | still exists    | silent     |
| walk away (5s+ with no focus)    | deleted         | buzzes     |
| come back                        | recreated       | silent     |

The five-second grace period is deliberate: without it every window switch would
open and close the push gate, which reads as a phone buzzing at random. Focus is
claimed *immediately* — being pinged about something you are already looking at
is the worse failure.

A marker left behind by a crash is a "user is here" claim with no expiry, so it
would mute your phone forever. Forge deletes any stale marker on start, and its
own on quit.

---

## Using it

1. Open a Claude pane in Forge. The pane header shows a small phone glyph. It
   goes volt once Claude has actually connected.
2. Click it: the popover tells you the exact name the session appears under.
3. On the phone, open the Claude app → **Code** tab. The session is listed under
   that name. Tap it and you are driving the pane on your PC.
4. The button in the popover opens **this session** in your default browser —
   see below — or the session list if Claude has not connected yet.

Renaming a pane afterwards does **not** rename its remote session — Claude was
told the name once, at launch. The popover therefore reports the name the
session was actually started with, not the pane's current title.

### How Forge knows the session URL

When Remote Control connects, Claude prints this into the pane:

```
/remote-control is active · Continue here, on your phone, or at
https://claude.ai/code/session_01DVNvj8NnRwAL2C38MWhGcj
```

Forge reads that URL **off the pane's own screen** — `scanForRemoteUrl` in
`src/lib/terminals.ts` watches the PTY stream (with a short overlap, because a
URL can straddle two chunks) and hands it to the pane's popover.

That is deliberately the cheapest possible capture. The id also exists as
`CLAUDE_CODE_BRIDGE_SESSION_ID` inside the Claude process, but reading it would
mean a `SessionStart` hook, and a hook means writing into a settings file —
Forge will not put hooks in anyone's project folder. Claude announces the URL
on screen, and Forge *is* the terminal, so no hook is needed.

The link is discarded and re-learned whenever a pane relaunches, because a new
Claude process is a new session with a new id. Until it appears — not signed in,
still starting, no network — the button falls back to `https://claude.ai/code`,
the session list, which is never wrong, only less direct.

---

## Limits

- **The local process must stay alive.** Close the pane, quit Forge or reboot,
  and the remote session ends with it. There is no cloud copy.
- **One remote session per interactive Claude process.** One pane, one session.
- An extended network outage (~10 minutes) disconnects the session for good.
- Some things are local-only from the phone — `/plugin`, `/resume`, `/mcp` and
  `/config` are degraded or unavailable, and you cannot switch a session into a
  bypass permission mode from the app.
- Starting ultraplan disconnects Remote Control; both use the same interface.
- The session URL shape (`https://claude.ai/code/session_<id>`) is not
  documented — Forge reads it from what the CLI prints, which is a contract
  Anthropic could change. If it ever stops matching, the popover quietly falls
  back to the session list; nothing else breaks. The pattern lives in one place,
  `findRemoteSessionUrl` in `shared/remote.ts`.
- Per-open overrides ("open *this* pane without Remote Control") are not wired
  into the agent chooser yet. The hook is ready: pass a flag through
  `CreateSessionRequest` and short-circuit `wantsRemoteControl` in
  `electron/bridge/remote-control.ts`.

---

## Checking it

```
npm run remote:check    # naming, composition, the presence marker's life,
                        # the exact argv a pane hands Claude, and whether the
                        # installed CLI accepts the flag we compose
npm run pty:smoke       # includes the pane-environment audit
```

`remote:check` proves everything a script can. It cannot prove the phone: that
the session appears in the app, under the right name, and drives the pane —
that needs a real account, a real phone and a real network, and is the one part
of this feature only you can sign off.
