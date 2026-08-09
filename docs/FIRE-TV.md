# Forge TV — the Fire Stick setup

Forge TV is the same Forge, on the television: a glanceable wall of every
project's running sessions, sitting beside YouTube in a native split so the
TV can play something while the wall keeps working. It is not driven from the
couch — the phone (or the desktop) still does the typing and the tab-opening;
the television just shows what is happening and lets a remote zoom into a
pane or reach for the video next to it.

This file is the whole of getting it onto a Fire TV Stick and keeping it
there. `docs/MOBILE-SETUP.md` is the phone-side equivalent and worth reading
first if you have not paired a phone yet — the pairing step here is the same
mechanism.

---

## 1. Router prep — give the laptop a fixed address

The Fire TV app has this desktop's LAN IP **baked into the APK itself** at
build time (`scripts/apk-tv-build.mjs`; `electron/mobile-tv.ts` bakes it as
`FORGE_BAKED_ORIGIN`). There is no tunnel on a television the way there is
for the phone — it is three metres away on the same wifi, so a plain
`http://<laptop-ip>:8420` is the whole address, and that address only means
anything for as long as it stays correct.

A router hands out DHCP leases however it feels like it, and a laptop that
sleeps, reboots, or just sits idle long enough can come back with a different
one. If that happens, every APK already built points at a dead address, and
the television just shows the Connect screen with nothing behind it.

So before doing anything else: open your router's admin page and add a
**DHCP reservation** (some routers call it a static lease) for your laptop's
MAC address, pinning it to its current LAN IP. Write that IP down — it is
`your laptop's LAN IP` everywhere below, and you will use it twice: once
building the app, once typing it into the television.

---

## 2. The Fire Stick — one-time setup

Developer options are hidden by default, and are only needed to unlock the
Downloader app below — nothing here needs ADB debugging for a normal
install, so leave it off unless you are actively developing against the
device.

1. **Settings → My Fire TV → About**, then click on the device name
   (`Fire TV Stick`) **seven times**. It counts down and unlocks
   **Developer options** one level up.
2. Optional, development only: **Settings → My Fire TV → Developer
   options**, turn **ADB debugging** on. A normal sideload from Downloader
   does not need this at all — skip it unless you are debugging the app
   itself.
3. Install **Downloader** from the Amazon Appstore (search for it from the
   Fire TV home screen, or **Apps → Downloader**).
4. Open Downloader, and in the URL field type:

   ```
   http://<laptop-ip>:8420/forge-tv.apk
   ```

   (the desktop serves that exact path — `electron/mobile/server.ts` answers
   `/forge-tv.apk` with whatever was last built, or a plain-text 404 telling
   you to build it first if nothing has been).
5. Select **Install**. The first time, Android/Fire OS will refuse and offer
   a settings screen to allow installs from Downloader — approve it, then
   install again. This is the one-time price of an app that does not come
   from an appstore, same as the phone.

---

## 3. Building and updating the app

**On the desktop:** Settings → **Forge Mobile**, scroll to the **Forge TV**
card at the bottom. It shows a **Build the TV app** button (labelled
**Rebuild** once something has been built), and once a build exists, a
**Type this on the TV** row with the exact URL to enter in Downloader and a
Copy button.

**From the command line, the same thing:**

```
node scripts/apk-tv-build.mjs http://<laptop-ip>:8420
```

(the port defaults to 8420 if you leave it off the address). Either route
signs the build with the same release key as the phone app and writes it to
`dist-apk/forge-tv.apk`, overwriting whatever was there — that stable name
and path is what lets the desktop serve one fixed URL forever.

**Updating is the same two steps, deliberately, every time:** rebuild on the
desktop (button or command), then open Downloader on the television and
enter the URL again. **The TV build does not check for updates on its own —
that is on purpose.** The phone app's OTA feed describes the phone package;
offering it to a television would hand it the wrong app and raise an Android
install dialog nobody could answer with a remote, so the TV build ships with
no manifest URL at all and its own update-checking code is told not to ask.
A fresh install over the old one, signed with the same key, is the entire
update mechanism — and it is also how a router's new DHCP lease gets
corrected, since the address is baked in at build time, not read at runtime.

---

## 4. First run — pairing the television

1. On the desktop: **Settings → Forge Mobile**, arm **Accept new phones**.
   (Same switch the phone uses — it stays armed for ten minutes.)
2. On the television: open **Forge**. Because the app already knows this
   desktop's address (it was baked in when it was built), it opens straight
   to a one-button screen — press **Connect**.
3. Back on the desktop, a prompt appears showing two words. Check they are
   the ones the television is showing, then **Allow**.

Nothing is typed on either end. Once paired, the television stores its own
device token and reconnects on its own from then on — Settings → Forge
Mobile lists it with the phones, and revoking it there is the kill switch.

---

## 5. Remote controls

**Current as of tonight's build** — a further control pass is still landing,
so treat this table as a snapshot rather than a promise.

| Press | Does |
| --- | --- |
| D-pad (any direction) | Move focus around the dashboard |
| Enter / D-pad centre | Open the focused pane |
| Back | Close the zoomed pane and return to the wall (sent to the page as Escape) |
| Menu | Cycle panel modes — Forge split → YouTube split → YouTube full → Forge alone |
| Rewind | Jump to the Forge panel |
| Fast Forward | Jump to the YouTube panel |
| Play / Pause | Controls the YouTube video |
| Down, while watching **The screen** | Show or hide the mirror's own measurements — see below |

**Signing in to YouTube** never opens a Google login page on the television —
the leanback interface offers an **activation code** instead. It shows the
code on screen; type it into `youtube.com/activate` on your phone or a
computer to finish signing in. There is no other way in, because a
television with only a D-pad cannot type a password.

---

## 6. Proving the mirror's picture

A soft picture on the television has four causes that look identical from the
sofa, and each wants a different fix. Press **Down** while watching **The
screen** and the mirror says which one it is: a sentence naming the finding,
and two columns of evidence under it — what left the desk, and what this
television actually decoded. Press **Down** again to put it away.

| Reading | What it means |
| --- | --- |
| **Captured** 2560×1440, **Encoded** 1920×1080 | Normal. The desktop caps what it sends at 1080p, because the television is 1080p. |
| **Encoded** noticeably smaller than 1920 wide | The encoder is scaling the picture down to fit a budget. **Limited by** names which budget. |
| **Limited by** `bandwidth` | The wifi is the ceiling. The single biggest cause is a Fire Stick on the 2.4GHz band — check the router, because no setting in Forge beats a slow hop. |
| **Limited by** `cpu` | The desktop cannot encode its own screen any faster. Close what is busy on it. |
| **Limited by** `none` | Nothing is holding the encoder back. If the picture still looks soft, the remaining suspects are the television's own sharpness settings and the distance to the sofa. |
| **Decoder** reading like a software library rather than `OMX…` / `c2…` | The stream negotiated a codec this dongle has no silicon for. Bitrate cannot rescue that; the desktop asks for H.264 first precisely to avoid it. |
| **Frozen** climbing while **Encoded** stays 1920 | Packet loss, not resolution. Look at **Lost** and **Jitter** in the same column. |

The desktop sends these numbers once a second down the same channel that
carries the WebRTC signalling, so the two halves are always describing the same
moment. A desktop older than this feature sends none, and the overlay says so
rather than showing zeroes.

---

## 7. Giving it to somebody else

Everything above builds a television app for *this* house: the desktop's LAN
address is baked into the APK, which is exactly what makes it useless to
anybody else. Their network hands out different addresses, and a friend has no
Android SDK, no JDK and no signing key to build their own with.

So there is a second app, and it is the one to share.

**The shared build has no address inside it.** On first run it asks the local
network — one UDP broadcast on port 8421 — and every Forge on that wifi with
its phone link switched on answers with its name and where to dial it. The
television lists what answered, you press OK on the right one, and the desktop
raises the same two-word pairing prompt it raises for a phone. Nothing is
typed. If the search finds nothing (a guest VLAN, broadcast disabled, a desktop
on ethernet behind a switch that will not carry it), the last row on that
screen is still **Type the address instead**.

**For your friend, from a plain install of Forge:**

1. Settings → **Forge Mobile**, switch the phone link on.
2. Same page, **Forge TV** card → **Download the TV app**. About twenty
   megabytes, no build tools involved. The desktop verifies the download's
   SHA-256 against the published release before it will serve it to anything.
3. Type the address that appears into **Downloader** on their Fire Stick, the
   same as step 2 above.
4. On the television, Forge finds their desktop and asks to pair. They press
   **Allow** at the desk.

**Publishing a new shared build** (only from this checkout, and only by whoever
holds the signing key):

```
npm run apk:tv:release            # builds --shared, then publishes it
npm run apk:tv:release -- --no-build
```

It goes to `stevenmcginty/forge-tv-releases` — its own repo, because
`releases/latest/download/…` resolves to whichever release in a repo is newest,
and sharing one with the phone feed would make each app's release hide the
other's manifest.

**A note on the firewall.** Discovery answers on **UDP 8421**, beside the
link's TCP 8420. Windows' "allow this app" prompt covers the program rather
than a single port, so a Forge that has already been allowed through will
answer; a rule written by hand for TCP only will not, and the television will
find nothing while everything else works.

---

## When it does not work

| What you see | What it is |
| --- | --- |
| Television shows the **Connect** screen and nothing happens | The desktop app is not running, or **Allow phones to connect** is off in Settings → Forge Mobile. Both must be true for the television to have anything to dial. |
| "Cannot connect" right after restarting the desktop | Give Forge a moment to bind the port and come back to **Listening** in Settings → Forge Mobile, then press Connect again on the television. |
| Downloader gives a 404, or the address just does not answer | Your laptop's LAN IP changed. Confirm the DHCP reservation from step 1 is still applied, then **rebuild** the TV app (button or CLI) and **re-download** it in Downloader on the television — the address is baked in, so nothing short of a rebuild fixes it. |
| `adb` reports **unauthorized** | The Fire Stick's own "Allow USB debugging" dialog was never accepted (or was dismissed). Re-trigger it and accept the prompt on the television's screen. Only relevant if you turned ADB debugging on for development. |
| The app is not on the home screen after installing | Fire TV files apps that declare themselves TV-ready under **Your Apps & Channels**, not the main row automatically — the Forge TV build is leanback-enabled, so check there before assuming the install failed. |
| Install fails with a signature error | A copy signed with a different key is already on the device — uninstall it first. Both the phone and TV builds share one release keystore, so a rebuilt TV app should always install over the previous one cleanly. |
| **The screen** says *the mirror ended* as soon as it opens | Press **OK** on that screen to ask again — it retries in place. Opening a desktop capture can take longer than the television's six-second patience, and the retry is the supported answer. If every attempt ends instantly with the same sentence, the desktop half is what to look at: it is the only end that can refuse, and `npm run mirror:check` is the script that covers it. |
| The mirror says the desktop *didn't answer* | Forge on the desktop is older than the mirror feature, or its window is closed — a minimised Forge can share its screen, a Forge with no window open cannot. Restart it and try again. |
| The shared app searches and finds **nothing** | Three things must all be true: Forge is running, its phone link is on (Settings → Forge Mobile), and the television is on the same wifi — not a guest network, which usually blocks devices from seeing each other. If all three hold, the firewall is the next suspect (UDP 8421, see section 7). The **Type the address instead** row works regardless. |
| The search lists a desktop as **different Forge version** | The two ends speak different protocol numbers, so pairing would fail at hello. Update the older one — usually the desktop. |

Checks that prove the parts a script can (run from the desktop checkout):

```
npm run apk:check       # the APK half: versions, manifest, hashing, key hygiene
npm run mobile:smoke    # the server, auth, protocol and a real PTY
npm run mirror:check    # the desktop half of the screen mirror against a held-
                        # open capture: which attempt is allowed to speak when
                        # a retry overtakes a slow one
npm run discovery:check # the "is there a Forge here?" responder against real
                        # datagrams: what earns an answer, what is ignored, and
                        # that a stopped link answers nothing
npm run tv-fetch:check  # the downloaded TV app: that nothing failing its size
                        # or SHA-256 is ever put where a television could
                        # install it
```
