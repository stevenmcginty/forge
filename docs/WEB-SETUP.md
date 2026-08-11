# Forge Web — go live

Everything below is for **you** to run, Steve. Nothing in this repo has created
a Firebase project, registered a hosting site, or deployed anything — the code
was built and tested against the Firebase emulator suite and a scripted ngrok
process. `docs/forge-web.md` explains *why* every part is shaped the way it is.
This file only tells you what to do.

Verified against the `firebase` CLI in this worktree: **15.25.0**
(`firebase --version`). Every flag below was checked against `--help` on that
version, and every `npm run …` below is a script in `package.json`.

Forge Web shares its Firebase project with Forge Companion (decision 2 in
`docs/forge-web.md`) but not its session — it signs in on its own, into its own
fields in Settings. If you already went through `companion/GO-LIVE.md`, you
have a project, a database and email/password sign-in already; skip to
**3. Two hosting sites**. Steve's own project, used as the worked example
throughout, is **`forge-sync-aadafc`** — plain `forge-sync` was taken, exactly
as `companion/GO-LIVE.md` warns it might be.

Run everything from the **repo root** unless a step says otherwise. That is a
change from `companion/GO-LIVE.md`: the deploy config used to live in
`companion/`, and now lives at the repo root — see "When it does not work"
below if a deploy command refuses to find `firebase.json`.

---

## Giving Forge to a friend

Everything below this point is for standing up your **own** deployment — a new
Firebase project, a new hosting site, keys you copy in by hand. Most people
handing Forge to somebody else don't need any of it: Steve's own deployment
ships baked into the app as the default (`electron/store.ts`,
`WEB_DEFAULT_PROJECT_ID` and friends), so a friend's install already has the
four account-card fields in step 6a filled in.

A friend just needs to:

1. Install Forge.
2. Open **Settings › Forge Web** and sign in with a **new** email — typing an
   email that doesn't exist yet creates the account in Steve's project, the
   same as it does for Steve.
3. Flip **"Let browsers reach this desktop"** and **"Keep the tunnel up"**
   (step 6b/6c below — cloudflared needs no account, no domain, no authtoken).
4. Open **https://forge-web-aadafc.web.app** in any browser and sign in with
   that same email.

No Firebase CLI, no ngrok account, no Cloudflare account, nothing pasted. The
API key that ships in the defaults is not a secret — see step 4 below for why
— and the database's security rules gate every read and write by the
signed-in uid, so a friend on Steve's deployment only ever sees their own
session. Somebody who wants their *own* Firebase project instead of sharing
Steve's follows the rest of this document and overwrites the four fields in
step 6a with their own values.

---

## 0. Preflight

```powershell
firebase --version
firebase login
```

If it says you are already logged in, you are done with this step.

---

## 1. The Firebase project

Skip this and step 2 if `companion/GO-LIVE.md` is already done — Forge Web
reads the same project.

Starting fresh, follow `companion/GO-LIVE.md` steps 1–3: create the project
(`firebase projects:create`), create the Realtime Database in `europe-west1`,
and turn on email/password sign-in **[console]** — there is no CLI for the
last one.

---

## 2. Deploy the security rules

**Before** anything can write, from the repo root:

```powershell
firebase deploy --only database --project forge-sync-aadafc
```

`companion/database.rules.json` is the rules file both apps share — the root
`firebase.json` points at it (`"database": { "rules": "companion/database.rules.json" }`)
so there is nothing under `companion/` to `cd` into any more. It carries the
`host` block Forge Web's rendezvous record needs, and it is proved against the
emulator by `npm run web:rendezvous` — but the emulator is not the project.
Until this runs, the live database refuses the write and no browser can ever
find the desktop. See "When it does not work" below for exactly what that
looks like.

---

## 3. Two hosting sites

One project, two Firebase Hosting sites, kept apart by target names so a
deploy of one cannot overwrite the other — `companion/web` (the phone PWA) and
`web/dist` (Forge Web) are siblings, and Firebase refuses a `public` path
outside the directory holding `firebase.json`, which is the whole reason the
deploy config moved to the repo root.

Every project gets one default site, named after the project id — that one is
already yours for Companion (`forge-sync-aadafc.web.app`). Add one more for
Forge Web:

```powershell
firebase hosting:sites:create forge-web-aadafc --project forge-sync-aadafc
```

Site ids are globally unique and become the URL — pick your own if
`forge-web-aadafc` is taken. Steve's landed at
**https://forge-web-aadafc.web.app**.

Then, once, from the repo root, point the target names the root `firebase.json`
already declares at your two real sites:

```powershell
firebase target:apply hosting companion forge-sync-aadafc --project forge-sync-aadafc
firebase target:apply hosting web       forge-web-aadafc  --project forge-sync-aadafc
```

That writes a root `.firebaserc` (gitignored — it names your project and your
site ids, not the repo's). After it, each site deploys on its own:

```powershell
npm run web:deploy                                    # Forge Web only — builds, then ships web/dist
firebase deploy --only hosting:companion --project forge-sync-aadafc   # the phone PWA
```

---

## 4. Register a web app and fill in the config

```powershell
firebase apps:create WEB "Forge Web" --project forge-sync-aadafc
firebase apps:sdkconfig WEB --project forge-sync-aadafc
```

If that project already has more than one WEB app (Companion may have its
own), `apps:sdkconfig` needs the app id to disambiguate — `firebase apps:list
--project forge-sync-aadafc` shows them, and you pass the id as a third
argument: `firebase apps:sdkconfig WEB <appId> --project forge-sync-aadafc`.

The command prints a config block. You need exactly two values from it:
`apiKey` and `databaseURL` — the same two `companion/GO-LIVE.md` step 5 asks
for, and **not secrets**: a Firebase web API key names the project and
authorises nothing, which is why it is safe to serve beside the bundle rather
than baked into it.

Copy `web/config.example.json` to `web/public/config.json` and fill them in:

```json
{
  "apiKey": "AIza…",
  "databaseUrl": "https://forge-sync-aadafc-default-rtdb.europe-west1.firebasedatabase.app"
}
```

`web/public/config.json` is gitignored — it is Steve's project's keys, not the
repo's — and it must exist **before** you build, because the bundle fetches it
at runtime (`GET /config.json`, `cache: 'no-store'`) rather than baking it in.
A build without it still succeeds; the deployed page just answers "This
deployment is not configured yet."

---

## 5. Build and deploy the client

```powershell
npm run web:deploy
```

That is `npm run web:build && firebase deploy --only hosting:web` — see
`package.json`. It lands at **https://forge-web-aadafc.web.app**.

There is no service-worker cache to bump here, unlike Companion's PWA
(`companion/GO-LIVE.md` step 6): Forge Web's Hosting headers set
`Cache-Control: no-cache` on every path, so a reload always fetches the
current bundle rather than serving a stale one out of a cache.

Want to look at it without deploying first? `npm run web:dev` serves the same
client on `http://localhost:5174`, pointed at a desktop by setting `_devHost`
in `web/public/config.json` to `127.0.0.1:8421` (Forge Web's own port — see
step 6b, below) — that field is honoured only by the dev server and is
compiled out of every real build.

---

## 6. The desktop side

Open Forge → **Settings › Forge Web**. Everything from here is in that one
panel; nothing needs DevTools the way Companion's early sign-in did.

### 6a. The account card

These four fields now ship pre-filled with Steve's own deployment
(`WEB_DEFAULT_PROJECT_ID` and friends in `electron/store.ts`), so on a fresh
install — or an existing one that has never had its own values pasted in —
there is nothing to do here. Touch this card only if you are pointing Forge
at a **different** deployment: paste the four values you just used to build
the client:

| Field | Value |
| ----- | ----- |
| Firebase project | `forge-sync-aadafc` |
| Hosting site | `forge-web-aadafc` |
| Web API key | the `apiKey` from step 4 |
| Database URL | the `databaseURL` from step 4 |

**The project and the site are different names, and step 3 is where they came
apart.** The project is `forge-sync-aadafc`; the site you created there for
Forge Web is `forge-web-aadafc`, and that is the one in the address bar. The
project id is what tokens are checked against; the Hosting site is the only
thing that decides which *page* may open a socket to this desktop. Leave the
site blank only if you skipped step 3 and deployed to the project's own default
site.

Get it wrong and there is exactly one symptom, which is not the one you would
guess from it: sign-in works, the tunnel is live, the desktop publishes its
address, the browser finds it — and every connection is refused during the
WebSocket handshake, where there is no socket to explain it on. The page says
*"Reconnecting to the desktop (attempt 6)…"* forever. The desktop says which
address it turned away, in red, at the top of "The link" card; that sentence
names the value this field wants.

Then sign in — email and password, in the card itself. **Typing an email that
does not exist yet creates the account**, exactly as it does on Companion's
first sign-in; if you already have a Companion account, sign in with the
same one. Signing in does **not** switch the link on — those are two separate
acts on purpose, so the panel never puts a shell behind a public address as a
side effect of saying who may reach it.

If the account fields are blank, sign-in refuses with *"Set the Firebase API
key and database URL for Forge Web first"* rather than doing nothing — that is
the exact sentence to expect, not a bug.

### 6b. Turn the link on

**"Let browsers reach this desktop"** — the toggle at the top of "The link"
card. It binds `127.0.0.1:8421` (loopback only — there is no bind-host choice
here the way Forge Mobile has one, because the tunnel is the only intended way
in). Nothing listens, publishes or reads a credential until both this switch
and sign-in are done.

### 6c. The tunnel

**"Reach it from anywhere"** card. Paste an **ngrok authtoken** — the same one
Forge Mobile uses is fine, from `https://dashboard.ngrok.com/get-started/your-authtoken`.
That is the only required field. Leave the domain blank: ngrok will hand out a
new address on every start, which costs nothing here, because the browser
reads the desktop's current address out of the Firebase rendezvous record
before it dials — that record is the entire reason a fixed address is optional
for this feature (Forge Mobile still needs one, because a phone that scanned a
QR keeps the literal address it was given).

Switch **"Keep the tunnel up"** on. The chip on the card goes `starting` →
`live`, and "This desktop's address" on the link card above fills in with the
`wss://…` URL a signed-in browser will dial.

If you do want a steady address anyway, reserve a **second** domain on the
ngrok dashboard — Forge Mobile's domain cannot be reused, because one domain
forwards to one port — and paste it into "Forge Web's ngrok domain".

---

## 7. Sign in from a browser

Open **https://forge-web-aadafc.web.app** on any machine. Sign in with the
same account you signed the desktop in with in step 6a. It lands on the
workspace — the same projects, the same tabs, the same terminals, mirrored
live over the tunnel.

Reload the page, or come back to it days later on the same browser: it signs
you back in with nothing typed. That is the account-only default working as
intended, not a bug — see "Getting in", next.

### Getting in — the one optional lock

Off by default, and the default is real usability, not a placeholder: a
verified Firebase token for the account you signed in as **is** the
credential. One further lock lives under Settings › Forge Web › **"Getting
in"**, and it is not required to use any of the above:

- **An unlock PIN** — four to twelve digits, set once from the same card.
  Don't reuse anything guessable; it is short by design, and the thing that
  makes it defensible is that Forge locks out an address after a handful of
  wrong guesses, not the length of the PIN itself. Once it is set, every
  browser types it at sign-in — not just the first time, and not just new
  ones — and it also gates screen control: a browser cannot be handed the
  mouse at all on a desktop with no PIN set, and starting to watch the screen
  asks for the PIN fresh even on a browser already signed in. There are no
  recovery codes to keep. Forget the PIN and there is nothing to recover — walk
  to the desktop and set a new one from this same card, which replaces the old
  one outright. Clear it to fall back to the account alone.

The bottom of the panel says how many browsers are connected right now, and
that is all it says about them. There used to be a list of every browser that
had ever signed in, with a Revoke button on each row; it was removed because it
never actually stopped anybody — a browser holding a valid sign-in and the PIN
got in whether or not it was on the list, so the buttons implied a lock that
was not there. To end access, clear or change the PIN, or sign Forge Web out
from this card. Both end it for every browser at once, which is the truth about
a door whose key is one account.

---

## 8. GitHub mode — when the desktop is off

With the PC powered off, the browser has no terminal and no agent — there is
no computer to run one — but the repository is still reachable. Opening the
page shows *"Forge is asleep"* and offers to open the repo from GitHub
instead.

There is no OAuth button — GitHub's token endpoints send no
`Access-Control-Allow-Origin`, so a browser cannot complete that exchange, and
Forge Web deliberately has no server to exchange through on its behalf. Create
a token instead:

1. **https://github.com/settings/personal-access-tokens** → Generate new
   token (fine-grained).
2. Repository access: **only select repositories** — name the one(s) you want
   to reach from the browser.
3. Permissions: **Contents — Read and write**. Nothing else.
4. The shortest expiry you can live with.

Paste it into the browser when it asks. It stays in that browser only — never
sent to the desktop, never in the offline cache, forgettable at any time from
the same screen. Edits from GitHub mode commit to a `forge-web/*` branch,
never to your default branch; the desktop shows a banner offering the pull
once it wakes up.

---

## When it does not work

| What you see | What it is |
| --- | --- |
| **"Reconnecting to the desktop (attempt N)…" forever, with the tunnel live and the desktop signed in** | The **Hosting site** field does not match the address the page is served from, so every browser is refused during the WebSocket upgrade — where there is no socket to say so on, which is why the page can only sit there retrying. Look at "The link" card on the desktop: it names the address it turned away, and the site name inside it is what the field wants. Observed on the first live run: the site is `forge-web-aadafc` and the project is `forge-sync-aadafc`, and only the project had ever been asked for. |
| The browser can never find the desktop, even though everything looks on | The database rules were never deployed against the *live* project — step 2 above proves them against the emulator, not against `forge-sync-aadafc`. Run `firebase deploy --only database --project forge-sync-aadafc` from the repo root. |
| A deploy command says it cannot find `firebase.json` / deploys the wrong thing | You ran it from `companion/`. The deploy config moved to the repo root — run `firebase deploy …` and `firebase target:apply …` from there. `companion/firebase.json` is the *emulator* config now (`--config companion/firebase.json`, used by the check scripts), not the deploy one. |
| Tunnel error mentioning **the authtoken** | Paste a fresh one from the ngrok dashboard. Forge stops rather than retrying — a rejected token is not a network blip. |
| **`ERR_NGROK_334` — "the endpoint … is already online"** | The endpoint it names is almost certainly Forge Mobile's reserved domain. A free ngrok account gets **one** static domain, and leaving Forge Web's domain blank does *not* mint a throwaway address — it uses that same account default, so the two links fight over one domain. Observed on the first live run. Either stop Forge Mobile's tunnel, or — better — set Forge Web's tunnel to **cloudflared**, which needs no account, no token and no domain, and runs happily beside ngrok. |
| Tunnel error mentioning **agent sessions** (`ERR_NGROK_108`) | All of the account's concurrent agent sessions are spent — usually a stranded `ngrok.exe` from a previous run. End it in Task Manager and switch the tunnel off and on again. |
| Tunnel card says **"Paste your ngrok authtoken below first"** or **"Turn Forge Web on first"** | The tunnel toggle is on with nothing for it to carry — the authtoken field is empty, or "Let browsers reach this desktop" itself is still off. Fill in the missing half; the tunnel starts on its own once it can. |
| Sign-in in Settings refuses immediately | The account card's project, API key and database URL are blank — "Set the Firebase API key and database URL for Forge Web first" is the exact refusal. Fill them in from step 4 before trying again. (The Hosting site is not part of sign-in and never blocks it — see the first row.) |
| The browser says **"That desktop is asleep"** and you know the PC is on | This is a tunnel or publishing problem, not a sign-in one — the browser only reads what the desktop last published. On the desktop's Settings card, check the tunnel state (`live`, not `error` or `off`) and the line under "Reach it from anywhere" that says what was published and when. A live tunnel with nothing published usually means Forge Web is signed out — see `session.detail` on the same card. |
| The client loads to a blank page saying **"This deployment is not configured yet"** | `web/public/config.json` never made it into the deployed bundle — it has to exist *before* `npm run web:build` runs, not be added to `web/dist` afterwards. Redo step 4, then step 5. |

Checks that prove the parts a script can, all against the real code with no
mocked server:

```powershell
npm run web:rendezvous   # the rendezvous record, against a real Firebase emulator
npm run web:auth         # every admission and refusal path, injected JWKS, no network
npm run web:smoke        # the web host over a real socket and a real PTY, no Electron
npm run web:check        # the on/off lifecycle, and that closing the window survives it
npm run web:e2e          # a real browser against a real Forge, end to end
npm run web:offline      # GitHub mode with the host deliberately down
```
