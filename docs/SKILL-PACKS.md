# Skill packs — giving your skills to somebody else

Open the Skills flyout, hit the **send** button, tick what goes in, save. Two
formats come out of the same sheet, and which one you want depends entirely on
what the other person runs.

| | Send it when | They do |
| --- | --- | --- |
| **Zip** | Always, unless you know they run Forge | Unzip into `~/.claude/skills`. No Forge, no software, no steps. |
| **Pack** (`.forgepack`) | Forge to Forge | **+** → *Install from a pack…*, read the preview, one click. |

The zip is the primary button because it is the one that works for the larger
audience. A `.forgepack` is the richer file — it previews, it validates, it
installs in a click — and it is completely useless to somebody without Forge,
which is most people a skill gets sent to.

A zip carries a **README.md** naming the destination folder on each platform
(somebody who was sent a zip has no interface telling them what to do with it)
and, when asked for, a **PLUGINS.md** with the recipes.

---

## The split that shapes everything

A pack carries two different things, because they *are* two different things.

| | Travels as | Why |
| --- | --- | --- |
| **Your library skills** | The files themselves | They are in `%APPDATA%\Forge\skills`, they are yours, and giving them away is the point. |
| **Installed plugins** | A `/plugin` recipe | Marketplace, name, version, and the two commands that reproduce the install. |

Copying somebody else's plugin out of `~/.claude/plugins` and posting it to a
colleague is republishing their work under your name, and it also strips them of
the update path the marketplace exists to provide. The recipe is both the honest
option and the more useful one: the recipient gets the current version, and
every version after it.

The same reasoning is why the share sheet offers **only the library**. Skills in
`~/.claude/skills` are folders Forge never wrote and cannot attribute — a "share
everything" button that quietly redistributed someone else's work is exactly the
failure this feature is shaped to avoid. Copy one into the library first (the
row already has that action), which is a moment to think about whether it is
yours to send.

A marketplace installed from a local directory comes through as
`source: local`. It is still listed — "you have this and your recipient cannot
get it this way" is worth saying — but it yields no commands, because there is
no honest command to offer.

---

## Why plain JSON, and not a zip

A skill is *instructions an agent will follow*. A pack should therefore be
something you can open in Notepad and read before you trust it, and an opaque
binary that installs agent instructions is exactly the habit not to build.

So: JSON, two-space indented, `SKILL.md` first in each skill's file list. Text
files stay text; base64 appears only for genuinely binary files, decided by
re-encoding the bytes rather than by looking at the extension — a `.md` saved as
UTF-16 is not text as far as a pack is concerned, and a `.dat` full of ASCII is.

The cost is size. `PACK_MAX_BYTES` is 8MB, which is where a pack stops being a
document and starts being a payload.

---

## What stops a pack doing something you did not agree to

Importing a pack takes files from someone else and puts them where every
`claude` session on the machine can read them. Be clear about which parts of
that are solved and which are not.

**Solved, and tested in `npm run pack:check`:**

- **Path containment.** `isSafePackPath` in `shared/skillpack.ts` refuses
  traversal (`..` anywhere, including behind a real-looking segment),
  absolute paths, drive letters, backslashes, empty segments, trailing dots and
  spaces (Windows strips them, so `foo. ` and `foo` are the same file),
  alternate data streams (`a:stream`), control characters, Windows device names
  (`nul`, `COM1`, and those with any extension), and anything over eight levels
  deep. Then `installPack` checks the **resolved absolute path** again at write
  time — so the defence does not depend on that first function being exhaustive.
- **No overwriting.** A name already in the library is refused, never replaced.
  Losing a skill you wrote to an incoming name clash is not a bug anyone gets to
  apologise for afterwards.
- **Nothing half-written.** Files land in a `.importing` folder renamed into
  place at the end, so a pack that fails mid-write leaves nothing behind.
- **Size caps** on the pack, each file, the file count and the skill count.
- **A short extension refusal:** `.exe`, `.lnk`, `.msi`, `.reg`, `.vbs` and
  friends. Deliberately *not* a list of "things that can run code" — refusing
  `.py` or `.sh` would break real skills while stopping nothing, since a pack
  meaning harm would say so in the SKILL.md prose. The line is narrower: files
  that execute **on a double-click in Explorer**, because "Open folder" is a
  button in the flyout and a stranger's pack must not put a booby-trapped icon
  under it.
- **Plugin names are pattern-matched**, not escaped, before they appear in a
  command you are invited to run. There is no legitimate plugin name with a
  space or a semicolon in it.

**Not solved, and not solvable:**

> A skill's whole purpose is to instruct an agent, and prose is not something a
> validator can clear. Nothing above tells you whether the instructions inside
> are a good idea.

Two decisions follow, and they are the ones that matter:

1. **An imported skill lands disabled.** `installPack` never touches the enabled
   list. Nothing an imported skill says reaches an agent until you turn it on in
   the flyout, on a row that names it.
2. **The pack is readable, and the preview is shown first.** The import sheet
   lists every skill, its description, every plugin recipe, and everything the
   validator dropped on the way in — before a byte is written. "Read it, then
   turn it on" is advice you can actually follow.

Forge never runs the `/plugin` commands for you either. That tree belongs to
Claude Code's plugin manager, and installing a stranger's plugin should cost a
deliberate keystroke in a pane somebody is looking at. The sheet offers the
commands for copying and gets out of the way.

---

## The other route: publish a marketplace

For skills you wrote and intend to keep maintaining, a pack is the wrong shape —
it is a snapshot, and the recipient never hears about your next edit.

Claude Code's own mechanism is a git repo with a `.claude-plugin/marketplace.json`
in it. Others run:

```
/plugin marketplace add <you>/<your-repo>
/plugin install <your-plugin>@<your-repo>
```

No Forge needed on the receiving end — it works in bare Claude Code — and Forge
picks the result up automatically, because `listPlugins` already reads
`~/.claude/plugins/cache`. Use a pack for "here, have these"; use a marketplace
for "these are mine and I keep them current".

---

## Files

| Path | What it is |
| --- | --- |
| `shared/skillpack.ts` | The format, the caps, `isSafePackPath`, `parsePack`, `pluginRecipe`. Pure — no `node:`, no DOM. |
| `electron/skill-pack.ts` | `buildPack`, `installPack`, `readPackFile`, `readPluginRecipes`. The half that touches disk. |
| `electron/zip.ts` | A ZIP writer in ~100 lines. No dependency — same call the repo made writing its own PNG encoder. |
| `src/components/SkillPack.tsx` | The share sheet and the import preview. |
| `scripts/pack-check.mjs` | 99 checks. |

## Checking it

```
npm run pack:check      # 121 checks: the traversal matrix (24 refusals, each a
                        # shape that beats a naive implementation), the parser
                        # against malformed and hostile packs, a real
                        # build/install round trip through a temp library
                        # including a binary file through base64, the
                        # no-overwrite rule, a pack that never met the parser
                        # being refused at write time, the `.importing`
                        # prefix trap, plugin recipes off a real plugins tree,
                        # that a plugins-only pack carries no plugin file
                        # content, and that the real ~/.claude/skills was
                        # never touched. Then the zip half — built archives are
                        # opened by **Windows' own Expand-Archive**, not by this
                        # repo's decoder, because an archive only ever read back
                        # by the thing that wrote it is one nobody has proved is
                        # a zip. Contents are compared byte-for-byte against the
                        # library, and a zip built with plugin recipes is
                        # searched for plugin file content that must not be in
                        # it
npm run skills:smoke    # the library itself, and that all twelve channels wire
```
