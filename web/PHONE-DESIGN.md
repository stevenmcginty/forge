# Forge mobile browser — design contract

The one design language for the phone face (`.app[data-mobile]`). Tokens: `web/src/phone-tokens.css` (`--p-*`). Primitives: `web/src/phone-ui.css` (`.pu-*`, inert until a component uses them). Icons: `web/src/components/PhoneIcon.tsx`. Haptics: `web/src/lib/haptics.ts`. Motion numbers for JS: `web/src/lib/motion.ts`. Reference build: the head (TopBar + TabStrip), seen at `/?preview=shell&phone` (params: `tabs=1|3|7 active=N waiting=0|1 name=long link=live|quiet|reconnecting|asleep pct=N theme=ID`).

**Name: Quiet Instrument.** Calm, exact, quick. The theme's ground (WhatsApp's deep green-black by default) with everything on it in one neutral graphite family; no slabs; one accent used rarely; amber only when something needs Steve; shape + word on every state. Remove chrome before you decorate it: fewer boxes, no outlines, more air, one thing per fact.

## 1. Rules (all of them, always)
1. **Surfaces by tone, not outlines.** Ground `--p-bg` (pages, chat, the head: `--p-chrome` IS the ground on a phone) < surface `--p-surface` (+7%: cards, inline wells) < raised `--p-raised` (+10%: sheets, menus, banners, toasts) < pressed `--p-press` (+14%). On dark themes these are the theme's ground mixed with its own ink in oklab (a neutral graphite ladder, not the theme's teal/blue panels); light themes keep their derived panels. Ink: `--p-ink`, `--p-ink-2` (68%), `--p-ink-3` (50%). Nothing else. No cards inside cards, no slab bars.
2. **Hairline (`--p-line`) only** between list rows/sections (`.pu-divider`) and on text fields. Never on buttons, chips, pills, tabs or cards at rest. No thick one-side borders, no glows, no gradients on chrome.
3. **Shadow only on what floats over content:** `--p-shadow-float` (menus, toasts), `--p-shadow-sheet`, `--p-shadow-banner`, always with `--p-rim`. No `backdrop-filter` on large or scrolling layers.
4. **Colour roles.** Neutral ink for everything by default. `--p-act` (theme accent; WhatsApp green), used rarely: the ONE primary action on a surface, sent/done ticks, a switch that is on. A normal, healthy state (live link, idle pane) is NOT accented — it is a neutral shape. `--p-attn` (amber): waiting on you. `--p-danger`: destroys or failed. `--p-dict` violet: your dictation. `--p-agent` lime: the voice agent. Blue: only the read ticks and the Listen round. Tints for fills: `--p-act-tint --p-attn-tint --p-danger-tint`. Ink on solid fills: `--p-act-ink --p-attn-ink --p-danger-ink`.
5. **Never colour alone** (Steve is red-green colourblind). Each state = shape + word: waiting `!` disc (`.pu-bang`) + "Waiting"; working = clock / spinner + "Working"; done = tick + "Done"; failed = triangle + what failed; live = filled core in ring; quiet = empty ring + "Quiet"; reconnecting = broken ring + "Reconnecting"; asleep = moon + "Asleep".
6. **Selected (a choice among options)** = `--p-selected` fill + `--p-ink` + weight 600 + a shape (`.pu-check` tick in lists/chips; the filled thumb in a segmented control). Mark it with `aria-selected`, `aria-checked` or `aria-pressed`; the primitives style those attributes. **Open (where you are, navigation)** = full ink + weight 600 + a 3px `--p-ink` bar on the hairline under it (the open tab). Never show selection with an outline, an accent colour or a lime lens.
7. **Pressed** = `--p-pressed` under the thing; buttons and tiles also scale to `--p-press-scale` (0.97) in `--p-dur-instant`. **Focus** = 2px `--p-focus` ring (`outline`, offset 2px; inset on full-width rows). **Disabled** = opacity `--p-disabled`, no press, and say why in the row's note.
8. **Size.** Hit ≥ `--p-hit` 44px (draw smaller, extend with `::before`). Rows `--p-row` 56. Bar `--p-bar` 56, tab strip `--p-tabs` 44, avatar/tile `--p-avatar` 34, compact control `--p-control` 36, icons `--p-icon` 20 / `--p-icon-sm` 16.
9. **Radius:** `--p-r-sm` 8 (badges, keys) · `--p-r-row` 12 (rows, fields, segmented) · `--p-r-card` 16 (menus, banners, toasts, cards) · `--p-r-sheet` 20 (sheet tops) · `--p-r-pill` (buttons, chips, pills). Nothing else.
10. **Space:** 4px grid `--p-1`…`--p-10` (4 8 12 16 20 24 32 40). Screen gutter `--p-gutter` 16. Sheet side padding 20 for headings, 8 + row padding 12 for rows. Group with space first; divide with a line only when space is not enough.
11. **Type (system font `--p-font`):** display 22/650 · title `--p-t-title` 17/650 · body `--p-t-body` 16/400 (row titles 500) · chrome 15/500–600 (tabs) · label `--p-t-label` 14/500–600 (buttons, chips, notices) · small `--p-t-small` 13 (notes, captions) · micro `--p-t-micro` 12/600 (counts, badges — the floor). Line-height `--p-lh` 1.4, reading `--p-lh-read` 1.55, tight 1.2. Sentence case. No letter-spaced caps. **Mono (`--p-mono`) only** for code, paths, commands, terminal text and keyboard keys — never labels or badges.
12. **Layers:** `--p-z-float` (pills/toasts inside the display) < `--p-z-head` < `--p-z-drawer` < `--p-z-side` < `--p-z-sheet` < `--p-z-banner` < `--p-z-toast` < `--p-z-modal`. Nothing floats over text Steve is reading: if it must float, it sits in a margin or the bar.
13. **Themes:** never a raw hex outside token files. Check every screen in `whatsapp-dark` (default), `whatsapp-light`, `volt`, `paper`.

## 2. Primitives (class · tokens · usage · don't)
**Button** `.pu-btn` (tonal, `--p-fill`) + `--primary` (accent, one per surface) · `--quiet` (text only) · `--danger` (danger tint) · `--wide` · `--sm` (36 drawn, 44 hit). Icon-only: `.pu-icon-btn` (44 round, bare; `aria-expanded`/`aria-pressed` = selected fill).
```html
<button class="pu-btn pu-btn--primary">Send</button> <button class="pu-btn pu-btn--quiet">Cancel</button>
<button class="pu-icon-btn" aria-label="More"><PhoneIcon name="more"/></button>
```
Don't: outline a button; put two primaries side by side; make a danger action primary-coloured; icon-only without `aria-label`.

**Sheet** `.pu-sheet` > `.pu-sheet__handle`, `.pu-sheet__head` (`.pu-sheet__titles` > `.pu-sheet__title` + `.pu-sheet__sub`, then an optional `.pu-icon-btn` close/back), `.pu-sheet__body` (scrolls) > `.pu-section` > `.pu-section__label` + rows, `.pu-sheet__foot` (equal-width `.pu-btn`s). Behaviour (drag, Back, scrim, focus trap) stays in `BottomSheet.tsx`; give its markup these classes.
```html
<div class="pu-sheet"><span class="pu-sheet__handle"></span><div class="pu-sheet__head"><div class="pu-sheet__titles"><h2 class="pu-sheet__title">Model</h2><p class="pu-sheet__sub">Claude Code · forge</p></div></div>
<div class="pu-sheet__body"><section class="pu-section"><span class="pu-section__label">Effort</span>…rows…</section></div></div>
```
Don't: a second header style, a bordered card inside the sheet, a title over 1 line, tracked-caps section labels.

**Row / picker row** `.pu-row` (button, a or label; div when static) > `.pu-row__icon` (36 slot, bare glyph) · `.pu-row__text` > `.pu-row__title` + `.pu-row__note` · `.pu-row__trail` (value text, chevron, `.pu-switch` or `.pu-check`). `data-tone="danger"`. Options in a picker: `role="option" aria-selected` (or `menuitemradio aria-checked`) and always include `.pu-check`.
```html
<button class="pu-row" role="option" aria-selected="true"><span class="pu-row__text"><span class="pu-row__title">Opus 5.5</span><span class="pu-row__note">Best for hard work</span></span><PhoneIcon name="check" className="pu-check"/></button>
```
Don't: grid-of-cells pickers (model / effort / mode are rows or a segmented control, never a cell grid); ticks AND fills AND outlines together; icon tiles with coloured backgrounds.

**Menu / pop-over** `.pu-menu` (raised card, pops from `--pu-origin`, e.g. `style="--pu-origin: top right"`) > `.pu-menu__item` (48 tall, glyph + label, `data-tone="danger"`) · `.pu-menu__sep`. For 2–6 actions anchored to a control; more than 6 or anything with notes → a sheet.
Don't: invent another overlay look (fan, frosted card, bright-outlined pop-over). Every overlay is a sheet, a menu, a banner or a toast.

**Segmented control** `.pu-seg` > `.pu-seg__opt` (`aria-pressed`/`aria-checked`/`aria-selected`). 2–5 short options (view switch Chat · Cards · Terminal, effort Low…Max). Icons optional.
```html
<div class="pu-seg" role="radiogroup"><button class="pu-seg__opt" role="radio" aria-checked="true">Chat</button><button class="pu-seg__opt" role="radio" aria-checked="false">Terminal</button></div>
```
Don't: more than 5 options (use picker rows); labels over one word or two short ones.

**Chip** `.pu-chip` (36 drawn, 44 hit, `--p-fill`; selected = fill + 600 + optional leading `.pu-check`). Filters, quick replies, pane chips. **Badge** `.pu-badge` (22 tall, 12/600; `data-tone="attn|danger|live"`, a word inside). **Count** `.pu-count` (solid amber disc with a number; `--pu-edge` = the surface it sits on). **Marks:** `.pu-bang` ("!" disc), `.pu-dot` (live), `.pu-spinner`, `.pu-state[data-state="waiting|working|done|failed"]` = shape + word.
Don't: a badge without a word or number; colour as the only difference between two badges.

**Switch** `.pu-switch` on a `button role="switch" aria-checked`. On = accent track, knob right. Put it in a `.pu-row__trail`; the row's tap toggles it. **Text field** `.pu-field` > `.pu-field__label` + `.pu-input` (16px text, hairline, `aria-invalid`) + `.pu-field__hint` (`data-tone="danger"` for the error sentence).

**Banner** (heads-up, top, interrupts) `.pu-banner[data-tone]` > `.pu-banner__mark` (shape) · `.pu-banner__text` > `.pu-banner__title` (1 line) + `.pu-banner__body` (≤2 lines) · `.pu-banner__actions`. Position: fixed, top `calc(env(safe-area-inset-top) + 8px)`, sides 8px, `z-index: var(--p-z-banner)`. **Toast** (feedback, bottom, above the composer) `.pu-toast[data-tone="done|danger"]` > `__mark __text __actions`. **Inline notice** (in the flow, never floats) `.pu-notice[data-tone="attn|danger"]` > `__mark __text` > `__title` + `__body`.
```html
<div class="pu-banner" role="status" data-tone="attn"><span class="pu-banner__mark"><span class="pu-bang">!</span></span><div class="pu-banner__text"><span class="pu-banner__title">Codex is asking</span><span class="pu-banner__body">Edit src/lib/feed.ts?</span></div><div class="pu-banner__actions"><button class="pu-btn pu-btn--sm">Open</button></div></div>
```
Don't: a coloured left stripe, a full-colour background, two banners at once (one at a time by priority).

**Loading / empty** `.pu-skeleton` (`--block` for a card) for content that will arrive; `.pu-spinner` inline for an action in flight; `.pu-empty` > `.pu-empty__icon` · `__title` · `__body` · `__actions`. Empty = what is missing + the one thing to do. **Divider** `.pu-divider` between sections only. **Scrim** `.pu-scrim`. **Press** `.pu-press` for tiles/cards.

**Icons** `<PhoneIcon name size? className?>`: 24 grid, 1.8 round stroke, `currentColor`. Names: more check chevron-down/right/left close plus working done alert link-live link-quiet link-reconnecting link-asleep. Need another? Append one entry to its `PATHS`. Agent identity = the maker's real logo (`AgentBadge`), drawn bare on the phone (no tile).

## 3. The head (reference implementation)
Top bar and tab strip are one open band on the ground, closed by ONE hairline under the tabs; no slab, no boxes. Bar (56), left to right: project button (34px tile: the project's initial on a wash of its colour; name 20/700 — 18 under 375px; ⌄) · waiting pill (bare: amber `!` disc + count in ink; the only amber in the bar; the count is NOT repeated on the tile) · the dial (ContextChip) · link (live: neutral ring-and-core glyph alone; quiet/reconnecting/asleep: a pill with shape + word; the word drops ≤430px when the waiting pill is up) · ⋯ in `--p-ink-2`. Tab strip (44): bare tabs (logo at 70%, title, state shape) in `--p-ink-2`; the open tab full ink + 600 + the ink bar (it grows in with `--p-dur-snap`). Overflow is a 64px fade into the ground at the edge that has more — never a hard-cut fragment. `+` bare at the end, outside the scroller. A split tab's panes = `.pu-chip`-style chips on the ground below.

## 4. Motion
Only `transform` and `opacity`. Enter = arrive from where it comes from: sheets rise (`--p-dur-sheet`, `--p-ease-sheet`); menus pop from their trigger (`.pu-in-pop`: scale 0.96→1, `--p-dur-snap` on `--p-glide`); banners drop (`.pu-in-drop`); toasts rise (`.pu-in-rise`, 8px). Exit = the reverse, faster (`--p-dur-exit` 200, `--p-ease-in`): `.pu-out-sink`, `.pu-out-lift`, `.pu-out-fade`; unmount after `exitDelay()`. Press = scale 0.97 in 80ms, release 180ms. State changes (fills, colour) `--p-dur-fast` 120. Drag-dismiss: follow the finger 1:1 with no transition; on release dismiss past `DISMISS_PX` 96 or a flick ≥ 0.55 px/ms (`shouldDismiss`), else settle back on `--p-ease-sheet`; past a hard edge use `rubberband()`. Springs never overshoot. Reduced motion (`prefers-reduced-motion` or `:root[data-reduced-motion='true']`): every `--p-dur-*` is 0 and `--p-press-scale` is 1, so everything lands at its end state at once; loops (spinner, skeleton, pulses) stop. Reduced transparency: scrims go near-solid. The dictation comet keeps its timing (2.0 s; agent 2.8 s).

## 5. Haptics (`buzz(kind)` only — never `navigator.vibrate`)
`hold` 12ms: a long-press opened something · `select` 6ms: a drag/swipe picker landed on a value (the drum) · `confirm` 12-70-12: something you asked for happened while you may not be looking · `warn` 30-80-30: a heads-up banner arrived · `error` 70ms: it failed · dictation: `open` `stop` `sent` `failed`. No buzz on ordinary taps, scrolling, or opening a sheet by tap.

## 6. How Forge talks
Plain, short, calm, sentence case, verbs first on buttons. No "please", no exclamation marks, no "Oops", no jargon the screen does not need. Fixed nouns, one each: **project** (a folder on the desktop) · **tab** (an entry in the strip) · **pane** (one agent or shell inside a tab; a split tab has 2+) · **agent** (Claude Code, Codex, Grok…) · **shell** (a terminal with no agent) · **desktop** (the PC; by its name when known, e.g. STEVE-LAPTOP) · **Terminal** is only a view name (Chat · Cards · Terminal) and the key row. States: Live, Quiet, Reconnecting…, Asleep; Working, Waiting, Done, Stopped. A pane that asks "is asking" / "is waiting on you". Errors: what happened, then what to do — "Couldn't reach STEVE-LAPTOP. Check it's awake, then try again." Lengths: button ≤ 2 words (3 at most); banner title ≤ 40 characters, body ≤ 2 lines; toast ≤ 80 characters; section label ≤ 3 words. Numbers as digits; times as "just now", "2 min ago"; "…" only for something in progress.

## 7. Converting an old component (checklist)
1. Read its CSS: list every surface, border, radius, colour, font size and animation it draws.
2. Map each surface to ground / chrome / raised. Delete every border that is not a row divider or a field. Delete glows, gradients, blur on large layers, one-side borders.
3. Replace its parts with primitives: overlay → `.pu-sheet` / `.pu-menu` / `.pu-banner` / `.pu-toast`; list → `.pu-row`; option grid → picker rows or `.pu-seg`; pills → `.pu-chip` / `.pu-badge`; buttons → `.pu-btn` / `.pu-icon-btn`. Keep old class names on the elements too (scripts and other rules use them); add the `pu-` class beside them.
4. Make "selected" the one way (rule 6) and "pressed"/"focus" the one way (rule 7). Remove ticks+outlines+lenses duplicates.
5. Every state gets a shape and a word (rule 5). Every hit ≥ 44px. Text ≥ 14 (labels ≥ 12).
6. Swap raw values for tokens: colours, radii (rule 9), spacing (rule 10), type (rule 11), z (rule 12), durations/easings (§4). `grep -n "#[0-9a-f]\{3,6\}\|rgba(" yourfile.css` must come back empty (except shadows via tokens).
7. Motion: enter/exit with `.pu-in-*` / `.pu-out-*` or the same tokens; `navigator.vibrate` → `buzz()`.
8. Words: rewrite every string with §6. Keep `aria-label`, `data-testid`, `role` exactly.
9. Look at it: 390×844 and 360×780 in whatsapp-dark, whatsapp-light, volt, paper; one landscape (956×440); reduced motion. Compare with the head at `/?preview=shell&phone` — it must look made by the same hand.
