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

Paste the three values you just used to build the client:

| Field | Value |
| ----- | ----- |
| Firebase project | `forge-sync-aadafc` |
| Web API key | the `apiKey` from step 4 |
| Database URL | the `databaseURL` from step 4 |

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

### Getting in — the two optional locks

Off by default, and the default is real usability, not a placeholder: a
verified Firebase token for the account you signed in as **is** the
credential. Two further locks live under Settings › Forge Web › **"Getting
in"**, and neither is required to use any of the above:

- **Require approval at this desk** — a browser Forge has never seen has to be
  allowed by hand, comparing a word pair, exactly like pairing a phone. The
  price is that this cannot be answered from anywhere but this chair.
- **A TOTP code** — set up from the same card: scan the QR with an
  authenticator app, type the six digits it shows to confirm, and write down
  the recovery codes shown once. "Trust this browser for 30 days" is offered
  per browser after that, so you are not asked for a code every time.

Every browser that has ever signed in is listed at the bottom of the panel,
with **Revoke** (drops it now, refuses it if it comes back) and **Forget**
(clears the row — a fresh start, not a lock).

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
| The browser can never find the desktop, even though everything looks on | The database rules were never deployed against the *live* project — step 2 above proves them against the emulator, not against `forge-sync-aadafc`. Run `firebase deploy --only database --project forge-sync-aadafc` from the repo root. |
| A deploy command says it cannot find `firebase.json` / deploys the wrong thing | You ran it from `companion/`. The deploy config moved to the repo root — run `firebase deploy …` and `firebase target:apply …` from there. `companion/firebase.json` is the *emulator* config now (`--config companion/firebase.json`, used by the check scripts), not the deploy one. |
| Tunnel error mentioning **the authtoken** | Paste a fresh one from the ngrok dashboard. Forge stops rather than retrying — a rejected token is not a network blip. |
| **`ERR_NGROK_334` — "the endpoint … is already online"** | The endpoint it names is almost certainly Forge Mobile's reserved domain. A free ngrok account gets **one** static domain, and leaving Forge Web's domain blank does *not* mint a throwaway address — it uses that same account default, so the two links fight over one domain. Observed on the first live run. Either stop Forge Mobile's tunnel, or — better — set Forge Web's tunnel to **cloudflared**, which needs no account, no token and no domain, and runs happily beside ngrok. |
| Tunnel error mentioning **agent sessions** (`ERR_NGROK_108`) | All of the account's concurrent agent sessions are spent — usually a stranded `ngrok.exe` from a previous run. End it in Task Manager and switch the tunnel off and on again. |
| Tunnel card says **"Paste your ngrok authtoken below first"** or **"Turn Forge Web on first"** | The tunnel toggle is on with nothing for it to carry — the authtoken field is empty, or "Let browsers reach this desktop" itself is still off. Fill in the missing half; the tunnel starts on its own once it can. |
| Sign-in in Settings refuses immediately | The account card's three fields are blank — "Set the Firebase API key and database URL for Forge Web first" is the exact refusal. Fill in the project id, API key and database URL from step 4 before trying again. |
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
