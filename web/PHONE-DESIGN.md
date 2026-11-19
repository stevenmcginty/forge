# Forge mobile browser — design contract

The one design language for the phone face (`.app[data-mobile]`). Tokens: `web/src/phone-tokens.css` (`--p-*`). Primitives: `web/src/phone-ui.css` (`.pu-*`, inert until a component uses them). Icons: `web/src/components/PhoneIcon.tsx`. Haptics: `web/src/lib/haptics.ts`. Motion numbers for JS: `web/src/lib/motion.ts`. Reference build: the head (TopBar + TabStrip), seen at `/?preview=shell&phone` (params: `tabs=1|3|7 active=N waiting=0|1 name=long link=live|quiet|reconnecting|asleep pct=N theme=ID`).

**Name: Quiet Instrument.** Calm, exact, quick. The theme's ground (WhatsApp's deep green-black by default) with everything on it in one neutral graphite family; no slabs; one accent used rarely; amber only when something needs Steve; shape + word on every state. Remove chrome before you decorate it: fewer boxes, no outlines, more air, one thing per fact.

## 1. Rules (all of them, always)
1. **Surfaces by tone, not outlines.** Ground `--p-bg` (pages, chat, the head: `--p-chrome` IS the ground on a phone) < surface `--p-surface` (+7%: cards, inline wells) < raised `--p-raised` (+10%: sheets, menus, banners, toasts) < pressed `--p-press` (+14%). On dark themes these are the theme's ground mixed with its own ink in oklab (a neutral graphite ladder, not the theme's teal/blue panels); light themes keep their derived panels. Ink: `--p-ink`, `--p-ink-2` (68%), `--p-ink-3` (50%). Nothing else. No cards inside cards, no slab bars.
2. **Hairline (`--p-line`) only** between list rows/sections (`.pu-divider`) and on text fields. Never on buttons, chips, pills, tabs or cards at rest. No thick one-side borders, no glows, no gradients on chrome.
3. **Shadow only on what floats over content:** `--p-shadow-float` (menus, toasts), `--p-shadow-sheet`, `--p-shadow-banner`, always with `--p-rim`. No `backdrop-filter` on large or scrolling layers.
4. **Colour roles.** Neutral ink for everything by default. `--p-act` (theme accent; WhatsApp green), used rarely: the ONE primary action on a surface, sent/done ticks, a switch that is on. A normal, healthy state (live link, idle pane) is NOT accented — it is a neutral shape. `--p-attn` (amber): waiting on you. `--p-danger`: destroys or failed. `--p-dict` violet: your dictation. `--p-agent` lime: the voice agent. Blue: only the read ticks and the Listen round. Tints for fills: `--p-act-tint --p-attn-tint --p-danger-tint`. Ink on solid fills: `--p-act-ink --p-attn-ink --p-danger-ink`. **Month tones** (Dates only, `DatesSheet.css`): each calendar month has its own hue, as a tint on its well and day tiles and a small square by its name — never a fill, a stripe or text colour that carries meaning. Made from the theme (its ink, a quarter of the way to the ground, turned to the month's oklch hue), the twelve hues skip red, orange and amber so a month can never read as `--p-attn` or `--p-danger`, and they match the desktop's.
5. **Never colour alone** (Steve is red-green colourblind). Each state = shape + word: waiting `!` disc (`.pu-bang`) + "Waiting"; working = clock / spinner + "Working"; done = tick + "Done"; failed = triangle + what failed; live = filled core in ring; quiet = empty ring + "Quiet"; reconnecting = broken ring + "Reconnecting"; asleep = moon + "Asleep".
6. **Selected (a choice among options)** = `--p-selected` fill + `--p-ink` + weight 600 + a shape (`.pu-check` tick in lists/chips; the filled thumb in a segmented control). Mark it with `aria-selected`, `aria-checked` or `aria-pressed`; the primitives style those attributes. **Open (where you are, navigation)** = full ink + weight 600 + a 3px `--p-ink` bar on the hairline under it (the open tab). Never show selection with an outline, an accent colour or a lime lens.
7. **Pressed** = `--p-pressed` under the thing; buttons and tiles also scale to `--p-press-scale` (0.97) in `--p-dur-instant`. **Focus** = 2px `--p-focus` ring (`outline`, offset 2px; inset on full-width rows). **Disabled** = opacity `--p-disabled`, no press, and say why in the row's note.
8. **Size.** Hit ≥ `--p-hit` 44px (draw smaller, extend with `::before`). Rows `--p-row` 56. Bar `--p-bar` 56, tab strip `--p-tabs` 44, avatar/tile `--p-avatar` 34, compact control `--p-control` 36, icons `--p-icon` 20 / `--p-icon-sm` 16.
9. **Radius:** `--p-r-sm` 8 (badges, keys) · `--p-r-row` 12 (rows, fields, segmented) · `--p-r-card` 16 (menus, banners, toasts, cards) · `--p-r-sheet` 20 (sheet tops) · `--p-r-pill` (buttons, chips, pills). Nothing else.
10. **Space:** 4px grid `--p-1`…`--p-10` (4 8 12 16 20 24 32 40). Screen gutter `--p-gutter` 16. Sheet side padding 20 for headings, 8 + row padding 12 for rows. Group with space first; divide with a line only when space is not enough.
11. **Type (system font `--p-font`):** display 22/650 · title `--p-t-title` 17/650 (empty states, confirm questions; a sheet's own title is 20/700, §10) · body `--p-t-body` 16/400 (row titles 500) · chrome 15/500–600 (tabs) · label `--p-t-label` 14/500–600 (buttons, chips, notices) · small `--p-t-small` 13 (notes, captions) · micro `--p-t-micro` 12/600 (counts, badges — the floor). Line-height `--p-lh` 1.4, reading `--p-lh-read` 1.55, tight 1.2. Sentence case. No letter-spaced caps. **Mono (`--p-mono`) only** for code, paths, commands, terminal text and keyboard keys — never labels or badges.
12. **Layers:** `--p-z-float` (pills/toasts inside the display) < `--p-z-head` < `--p-z-drawer` < `--p-z-side` < `--p-z-sheet` < `--p-z-banner` < `--p-z-toast` < `--p-z-modal`. Nothing floats over text Steve is reading: if it must float, it sits in a margin or the bar.
13. **Themes:** never a raw hex outside token files. Check every screen in `whatsapp-dark` (default), `whatsapp-light`, `volt`, `paper`.

## 2. Primitives (class · tokens · usage · don't)
**Button** `.pu-btn` (tonal, `--p-fill`) + `--primary` (accent, one per surface) · `--quiet` (text only) · `--danger` (danger tint) · `--wide` · `--sm` (36 drawn, 44 hit). Icon-only: `.pu-icon-btn` (44 round, bare; `aria-expanded`/`aria-pressed` = selected fill).
```html
<button class="pu-btn pu-btn--primary">Send</button> <button class="pu-btn pu-btn--quiet">Cancel</button>
<button class="pu-icon-btn" aria-label="More"><PhoneIcon name="more"/></button>
<button class="pu-btn pu-btn--danger pu-btn--wide">Delete project</button> <button class="pu-btn pu-btn--sm">Open</button>
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
```html
<div class="pu-menu" role="menu" style="--pu-origin: top right"><button class="pu-menu__item" role="menuitem"><PhoneIcon name="link-live"/>Copy link</button>
<div class="pu-menu__sep"></div><button class="pu-menu__item" role="menuitem" data-tone="danger"><PhoneIcon name="close"/>Close tab</button></div>
```
Don't: invent another overlay look (fan, frosted card, bright-outlined pop-over). Every overlay is a sheet, a menu, a banner or a toast.

**Segmented control** `.pu-seg` > `.pu-seg__opt` (`aria-pressed`/`aria-checked`/`aria-selected`). 2–5 short options (view switch Chat · Cards · Terminal, effort Low…Max). Icons optional.
```html
<div class="pu-seg" role="radiogroup"><button class="pu-seg__opt" role="radio" aria-checked="true">Chat</button><button class="pu-seg__opt" role="radio" aria-checked="false">Terminal</button></div>
```
Don't: more than 5 options (use picker rows); labels over one word or two short ones.

**Chip** `.pu-chip` (36 drawn, 44 hit, `--p-fill`; selected = fill + 600 + optional leading `.pu-check`). Filters, quick replies, pane chips. **Badge** `.pu-badge` (22 tall, 12/600; `data-tone="attn|danger|live"`, a word inside). **Count** `.pu-count` (solid amber disc with a number; `--pu-edge` = the surface it sits on). **Marks:** `.pu-bang` ("!" disc), `.pu-dot` (live), `.pu-spinner`, `.pu-state[data-state="waiting|working|done|failed"]` = shape + word.
```html
<button class="pu-chip" aria-pressed="true"><PhoneIcon name="check" className="pu-check"/>Claude</button>   <!-- the tick shows only when pressed/selected/checked -->
<span class="pu-badge" data-tone="attn">Waiting</span> <span class="pu-badge" data-tone="live"><span class="pu-dot"></span>Live</span>
<button class="pu-icon-btn" aria-label="Waiting, 2">…<span class="pu-count" style="--pu-edge: var(--p-bg)">2</span></button>
<span class="pu-bang">!</span> <span class="pu-spinner" role="status" aria-label="Working"></span>
<span class="pu-state" data-state="waiting"><PhoneIcon name="alert"/>Waiting</span>  <span class="pu-state" data-state="done"><PhoneIcon name="done"/>Done</span>
```
Don't: a badge without a word or number; colour as the only difference between two badges.

**Switch** `.pu-switch` on a `button role="switch" aria-checked`. On = accent track, knob right. Put it in a `.pu-row__trail`; the row's tap toggles it. **Text field** `.pu-field` > `.pu-field__label` + `.pu-input` (16px text, hairline, `aria-invalid`) + `.pu-field__hint` (`data-tone="danger"` for the error sentence).
```html
<label class="pu-row"><span class="pu-row__text"><span class="pu-row__title">Sound</span></span><span class="pu-row__trail"><button class="pu-switch" role="switch" aria-checked="true" aria-label="Sound"></button></span></label>
<div class="pu-field"><label class="pu-field__label" for="n">Name</label><input id="n" class="pu-input" aria-invalid="true"/><p class="pu-field__hint" data-tone="danger">Use at least 2 letters.</p></div>
```

**Banner** (heads-up, top, interrupts) `.pu-banner[data-tone]` > `.pu-banner__mark` (shape) · `.pu-banner__text` > `.pu-banner__title` (1 line) + `.pu-banner__body` (≤2 lines) · `.pu-banner__actions`. Position: fixed, top `calc(env(safe-area-inset-top) + 8px)`, sides 8px, `z-index: var(--p-z-banner)`. **Toast** (feedback, bottom, above the composer) `.pu-toast[data-tone="done|danger"]` > `__mark __text __actions`. **Inline notice** (in the flow, never floats) `.pu-notice[data-tone="attn|danger"]` > `__mark __text` > `__title` + `__body`.
```html
<div class="pu-banner" role="status" data-tone="attn"><span class="pu-banner__mark"><span class="pu-bang">!</span></span><div class="pu-banner__text"><span class="pu-banner__title">Codex is asking</span><span class="pu-banner__body">Edit src/lib/feed.ts?</span></div><div class="pu-banner__actions"><button class="pu-btn pu-btn--sm">Open</button></div></div>
```
```html
<div class="pu-toast" role="status" data-tone="done"><span class="pu-toast__mark"><PhoneIcon name="done"/></span><span class="pu-toast__text">Sent to Codex</span><div class="pu-toast__actions"><button class="pu-btn pu-btn--sm pu-btn--quiet">Undo</button></div></div>
<div class="pu-notice" data-tone="danger"><span class="pu-notice__mark"><PhoneIcon name="alert"/></span><div class="pu-notice__text"><span class="pu-notice__title">Couldn't reach STEVE-LAPTOP</span><span class="pu-notice__body">Check it's awake, then try again.</span></div></div>
```
Don't: a coloured left stripe, a full-colour background, two banners at once (one at a time by priority).

**Loading / empty** `.pu-skeleton` (`--block` for a card) for content that will arrive; `.pu-spinner` inline for an action in flight; `.pu-empty` > `.pu-empty__icon` · `__title` · `__body` · `__actions`. Empty = what is missing + the one thing to do. **Divider** `.pu-divider` between sections only. **Scrim** `.pu-scrim`. **Press** `.pu-press` for tiles/cards.
```html
<span class="pu-skeleton" style="width: 60%"></span><div class="pu-skeleton pu-skeleton--block"></div>
<div class="pu-empty"><span class="pu-empty__icon"><PhoneIcon name="plus"/></span><h3 class="pu-empty__title">No tabs yet</h3><p class="pu-empty__body">Open a project to start an agent.</p><div class="pu-empty__actions"><button class="pu-btn pu-btn--primary">Open project</button></div></div>
<hr class="pu-divider"/> <div class="pu-scrim"></div> <button class="pu-press">…tile…</button>
```

**Icons** `<PhoneIcon name size? className?>`: 24 grid, 1.8 round stroke, `currentColor`. Names: more check chevron-down/right/left close plus working done alert link-live link-quiet link-reconnecting link-asleep (list in §9). Need another? Append one entry to its `PATHS`. Agent identity = the maker's real logo (`AgentBadge`), drawn bare on the phone (no tile).

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

## 8. Tokens (`.app[data-mobile]`, values in `whatsapp-dark`; "theme" = read from the active theme)
`whatsapp-dark` theme inputs: ground `--bg-base` #0b141a, ink `--text-primary` #e9edef, accent #00a884, danger #f15c6d, warn #ffd279. "mix(a, b n%)" = `color-mix(in oklab, a, b n%)`; "ink n%" = ink at n% alpha over what is under it.

**Surfaces and lines**
| Token | Value | For |
|---|---|---|
| `--p-bg` | theme `--bg-base` | ground: pages, chat, the head |
| `--p-chrome` | = `--p-bg` | the head (no slab) |
| `--p-surface` | mix(bg, ink 7%) | cards, inline wells |
| `--p-raised` | mix(bg, ink 10%) | sheets, menus, banners, toasts |
| `--p-press` / `--p-hover` | mix(bg, ink 14%) / mix(bg, ink 6%) | opaque pressed / hover surface |
| `--p-scrim` | theme `--bg-scrim` | behind a sheet |
| `--p-line` / `--p-line-strong` | mix(bg, ink 12%) / mix(bg, ink 22%) | hairline between rows, on fields / stronger rule |
| `--p-rim` | inset 1px ink 7% | edge of anything with a shadow |

**Ink and interaction fills** (translucent ink, so they work on any surface)
| Token | Value | For |
|---|---|---|
| `--p-ink` | theme `--text-primary` | text, icons, focus ring |
| `--p-ink-2` / `--p-ink-3` | ink 68% / 50% of the way from bg | secondary / dim text |
| `--p-fill` | ink 7% | tonal button, chip, segmented track, field, notice |
| `--p-hovered` / `--p-pressed` | ink 5% / 12% | hover / pressed under a thing |
| `--p-selected` / `--p-selected-press` | ink 14% / 19% | a chosen option |
| `--p-focus`, `--p-focus-w`, `--p-focus-gap` | ink, 2px, 2px | focus ring |
| `--p-disabled`, `--p-press-scale` | 0.45, 0.97 | disabled opacity, press scale (1 when motion is reduced) |

**Roles**
| Token | Value | For |
|---|---|---|
| `--p-act` / `--p-act-ink` / `--p-act-tint` / `--p-act-soft` | theme `--accent` #00a884 / `--text-on-accent` / accent 16% / `--accent-soft` | the one primary action, ticks, switch on / ink on it / fill / soft wash |
| `--p-live` | theme `--accent` | the live dot |
| `--p-attn` / `--p-attn-ink` / `--p-attn-tint` | theme `--warn` #ffd279 / bg / warn 18% | waiting on you / ink on it / fill |
| `--p-attn-soft`, `--p-attn-line` | warn 13% over bg, theme `--warn-line-strong` | soft wash, amber rule |
| `--p-danger` / `--p-danger-ink` / `--p-danger-tint` / `--p-danger-soft` | theme `--danger` #f15c6d / bg / danger 16% / `--danger-soft` | destroys or failed |
| `--p-dict`, `--p-dict-2`, `--p-dict-core`, `--p-dict-ink` | #a58bff, #6d7bff, #f1edff, #b3a2ff | your dictation (violet) |
| `--p-agent`, `--p-agent-2`, `--p-agent-core` | #b6f04a, #e3f36b, #fbffe8 | the voice agent (lime) |
| `--p-chart-plan/-session`, `--p-ring-sky/-blue/-amber/-red` | #6ea8ff #4dd2e6 / #63b8ff #547bd8 #e6a23c #f06a57 | usage charts and the dial only |
| `--dm` (on `.dates [data-tone]`) / `--dm-tint` / `--dm-well` | oklch(from mix(ink 74%, bg) l 0.12 *hue*) / 16% / 8% (light: 0.11, 14%, 7%) | Dates month tones only: swatch / day tile / well. Hues by month, Jan→Dec: 110 206 303 168 264 129 226 322 187 284 148 245 |

**Shape, size, space**
| Token | Value | For |
|---|---|---|
| `--p-r-sm` `--p-r-row` `--p-r-card` `--p-r-sheet` `--p-r-pill` | 8 · 12 · 16 · 20 · 999px | badge/key · row/field/segmented · menu/banner/card · sheet top · pill |
| `--p-hit` `--p-row` `--p-bar` `--p-tabs` `--p-tab` | 44 · 56 · 56 · 44 · 38 | tap target · row · top bar · tab strip · one tab |
| `--p-control` `--p-avatar` `--p-icon` `--p-icon-sm` `--p-signal` | 36 · 34 · 20 · 16 · 2 | compact control · tile · icon · small icon · open-tab bar thickness |
| `--p-1` `--p-2` `--p-3` `--p-4` `--p-5` `--p-6` `--p-8` `--p-10` | 4 8 12 16 20 24 32 40 | 4px space grid |
| `--p-gutter` | 16 | screen side padding |

**Type**
| Token | Value | For |
|---|---|---|
| `--p-font` / `--p-mono` | theme `--font-ui` / `--font-mono` | UI font / code, paths, keys only |
| `--p-t-display` `--p-t-title` `--p-t-body` `--p-t-chrome` | 22 · 17 · 16 · 15 | heading · empty / confirm title (sheet titles are 20/700) · body, rows, inputs · tabs, banner title |
| `--p-t-label` `--p-t-small` `--p-t-micro` `--p-t-mono` | 14 · 13 · 12 · 13 | buttons, chips · notes, captions · counts, badges (the floor) · terminal text |
| `--p-w-regular` `--p-w-medium` `--p-w-strong` `--p-w-heavy` | 400 · 500 · 600 · 700 | weights (650 is used for titles) |
| `--p-lh-tight` `--p-lh` `--p-lh-read` `--p-track-tight` | 1.2 · 1.4 · 1.55 · -0.01em | line heights, title tracking |
| `--p-text-scale` | theme `--phone-text-scale`, default 1 | A− / A+ (not yet applied) |

**Elevation and layers**
| Token | Value | For |
|---|---|---|
| `--p-shadow-float` / `-sheet` / `-banner` | 0 6px 20px / 0 -10px 36px / 0 12px 32px, black .32 / .38 / .38 | menus, toasts / sheets / banners (use with `--p-rim`) |
| `--p-z-float` `-head` `-drawer` `-side` `-sheet` `-banner` `-toast` `-modal` | 5 · 10 · pop+1 · +2 · +5 · +6 · +7 · +10 | stack order, low to high (pop = `--z-popover` 60) |

**Motion** (all `--p-dur-*` are 0 under reduced motion)
| Token | Value | For |
|---|---|---|
| `--p-dur-instant` `-fast` `-dur` `-exit` `-snap` `-sheet` `-glide` | 80 · 120 · 180 · 200 · 220 · 280 · 330 ms | press-down · fills · press-release, check · exits · pops · sheet rise · banner/toast travel (`--p-dur` is the bare name) |
| `--p-ease` / `--p-ease-in` / `--p-ease-sheet` | cubic-bezier(.22,.61,.36,1) / (.4,0,1,1) / (.32,.72,0,1) | default out / exit / sheet and drag settle |
| `--p-glide` | critically damped spring as `linear()`, never passes 1 | travel and pop |
| `--p-enter-y`, `--p-enter-scale` | 8px, 0.96 | start offset of rise/drop, start scale of pop |

## 9. Shared code
`web/src/lib/motion.ts`: `DUR` {instant 80, fast 120, base 180, exit 200, snap 220, sheet 280, glide 330} (ms, same as the tokens) · `DISMISS_PX` 96 · `FLICK_PX_PER_MS` 0.55 · `reducedMotion()` true when the page or the person asked for less motion · `exitDelay()` ms to wait before unmounting a `.pu-out-*` exit (0 if reduced) · `shouldDismiss(distance, elapsedMs)` true past 96px or a 0.55px/ms flick · `rubberband(overshoot, limit = 48)` damped follow past a hard edge.
`web/src/lib/haptics.ts`: `buzz(kind)` with kinds `hold` 12 · `select` 6 · `confirm` 12-70-12 · `warn` 30-80-30 · `error` 70 · dictation `open` 15 · `stop` 10 · `sent` 12-70-12 · `failed` 70 (ms). No-op without a motor.
`web/src/components/PhoneIcon.tsx`: `<PhoneIcon name size? className? />`. Names: `more` (three dots) · `check` (tick, list/chip selection) · `chevron-down` `chevron-right` `chevron-left` (open, go in, back) · `close` · `plus` · `working` (clock) · `done` (tick) · `alert` (triangle, failed/asks) · `link-live` (core in ring) · `link-quiet` (empty ring) · `link-reconnecting` (broken ring) · `link-asleep` (moon).
Enter classes: `.pu-in-rise` `.pu-in-drop` `.pu-in-pop` `.pu-in-fade`; exit: `.pu-out-sink` `.pu-out-lift` `.pu-out-fade`. `.pu-menu`, `.pu-banner`, `.pu-toast` and `.pu-scrim` already run their own enter animation.

## 10. The phone sheet as built (`BottomSheet.tsx` + `BottomSheet.css`)
Every phone menu is `<BottomSheet>`; rows are `SheetRow`, groups `SheetSection`, a destructive step `SheetConfirm`. It draws the markup in §2 under its own `bsheet*` / `bsrow*` / `bssec*` classes.
- **Form.** On a phone (`.app[data-mobile]`) the sheet is a floating card, not docked: 8px (`--p-2`) in from the left, right and bottom edge (plus the bottom safe inset), radius `--p-r-sheet` 20 on all four corners, `--p-raised` with `--p-rim` and `--p-shadow-sheet`, no border. It never grows past the screen minus 56px and the insets; the body scrolls. Landscape (>= 700px wide) centres it at 640px. At desktop width it is a centred 440px panel.
- **Grab handle.** A 36px bar at the top (24% ink). The handle and the head are one drag zone (`.bsheet__grab`); a button in the head keeps its own tap.
- **Title block.** `title` (defaults to `label`, which is also the accessible name; `title={null}` draws none) at 20px / 700, `subtitle` under it at 14px `--p-ink-2`, then a round `×` (44px hit, glyph 16px, `aria-label="Close"`) on the right. The `×` shows only when a heading is drawn.
- **Wells.** `SheetSection` = a quiet 13px/600 label, then its rows in one well: `--p-fill`, radius `--p-r-card` 16, 4px inner padding, hairlines between rows from the text edge. A chosen `role="radio"` row = `--p-selected` fill inside the well + weight 600 + tick. A section holding its own control (`.mseg`, a text box) drops the well.
- **`back`** `{ label, onClick, disabled? }`: a `‹` round before the title for an inner step; `label` is its accessible name ("More"). **`footer`**: pinned under the scrolling body, equal-width full-width pills in a column grid (use `.bsbtn`, `data-tone="act"` for the one primary). **`onBack`**: what Esc and Android Back do (default `onClose`); a multi-step sheet passes "step back to the list".
- **Closing.** Outside tap (a press that also started on the scrim), Esc, Android Back (one history entry per open sheet; `closeTopSheet()` pops the newest), swipe down (follows the finger 1:1; closes past 96px or a flick of 0.55px/ms, else settles back), and the `×`. Esc and Back go through `onBack` when given, the rest through `onClose`. Focus moves in on open and returns to the opener.
```tsx
<BottomSheet open={open} onClose={onClose} onBack={step !== 'list' ? () => setStep('list') : undefined}
  label="More" back={step === 'theme' ? { label: 'More', onClick: () => setStep('list') } : undefined} testId="more-sheet">
  <SheetSection title="This phone">
    <SheetRow icon={<SheetGlyph name="bell" />} label="Alerts" secondary="Off" onClick={askPermission} />
    <SheetRow icon={<SheetGlyph name="signOut" />} label="Sign out" tone="danger" onClick={() => setStep('sign-out')} />
  </SheetSection>
</BottomSheet>
{/* footer: <BottomSheet … footer={<><button className="bsbtn" onClick={onClose}>Close</button><a className="bsbtn" data-tone="act" href={href}>Open</a></>}> */}
```
