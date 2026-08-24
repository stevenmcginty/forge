# The Fable spec protocol

Every high-quality project in the gallery started as a spec with the same skeleton. This is the single most important artifact — write it before code. Header-frequency analysis across the corpus (most common section titles: *Summary, Layout & Structure, Style, Typography, Responsive Behavior, Color Palette, Motion/Animation/Interaction Spec, Tech Stack*) confirms the shape below.

Write specs in **plain declarative prose with exact values**. Vague specs ("modern, clean, some animations") produce slop. Exact specs ("`#F2F0EB` bone paper, Bricolage Grotesque 700 at `clamp(3.5rem,11vw,12rem)`, `line-height:0.82`, `letter-spacing:-0.04em`, letters recoil within 150px of the pointer") produce gallery work.

---

## The 7-part template

Copy this, fill every bracket with a concrete decision.

```markdown
# [PROJECT NAME] — [ONE-LINE WHAT-IT-IS]

## Named aesthetic identity
Build a [hero / full landing page / portfolio / component / scene] for [subject].
The named design language is "[TWO-OR-THREE-WORD NAME]" — [one paragraph: the
mood, the reference points, and the ONE big idea that makes it distinctive].
The mood is [3-4 adjectives]. [State what it is NOT, to rule out the default look.]

## Color palette (strict)
- Background: `#______`  ([name it — e.g. warm bone paper])
- Ink / foreground: `#______`
- Surface / card: `#______`
- Hairline rules: ink at __% opacity
- Muted text: ink at __% opacity
- Accent (the ONLY loud color, used sparingly on [dot / one word / hovers]): `#______`
- [optional] Rare secondary accent for one state: `#______`

## Typography
- Display font: "[FONT]" (vendored locally, weights __–__). Fallback: [system stack].
- Body/UI font: "[FONT]".
- Headline: `clamp(_rem, _vw, _rem)`, weight ___, [case], `letter-spacing: -0.0_em`,
  `line-height: 0.8_`.
- Eyebrow/labels: __px, UPPERCASE, `letter-spacing: 0.2_em–0.3_em`, weight 5__.
- Body: __px, line-height 1._, max-width ~__ch.

## Layout & structure
1. [Region — e.g. fixed header: left mark, center meta, right status pill]
2. [Region — e.g. centered hero block: eyebrow, giant headline, split meta row]
3. [Region …]
4. [Ambient detail — grain overlay, corner registration marks, grid]

## Motion / interaction spec
- Entrance: [what animates in, staggered how, over what duration, which easing].
- Scroll: [pin / parallax / reveal — with thresholds].
- Pointer: [magnetic / lerp-follow / tilt / spotlight — with ease constants].
- Ambient: [live clock, pulse, marquee, ticker].
- prefers-reduced-motion: [disable X and Y; keep content fully readable/static].

## Responsive behavior
- Desktop (≥1024px): full experience.
- Tablet: [what scales / hides].
- Mobile (coarse pointer, no hover): [pointer effects → auto/timer or static;
  stack meta; restore native touch]. Everything stays legible and tappable.

## Tech notes
- Stack: [React+TS+Vite+Tailwind  OR  framework-free HTML/CSS/JS  OR  +Three.js/GSAP/Motion].
- Self-contained & offline: vendor fonts + all media into `assets/`, relative paths,
  no hotlinked CDNs for shipped assets.
- Aim for distinctive, polished, gallery-grade UI — no generic template feel.
```

---

## Principles that separate spec from slop

1. **Name it.** A design language name (Step 1 of the skill) is the anchor. Refuse to proceed on "modern and clean."
2. **Exact over approximate.** Hex not "dark blue". `clamp()` not "big". Easing constants not "smooth".
3. **One accent.** Almost every strong project is monochrome-plus-one. The accent appears on a status dot, one headline word, and hover states — nowhere else.
4. **Ink-on-paper or its inverse.** Warm off-white (`#F2F0EB`, `#F8F7F7`) with near-black ink (`#0D0D0D`, `#1D1D1D`) is the gallery's most reliable base. Or full dark with a single luminous accent.
5. **Display type is the hero.** Oversized, tight negative tracking, `line-height < 1`, often uppercase, sometimes one word in outline/accent. Every letter as its own span when you need per-letter motion.
6. **Print-shop details.** Hairlines, eyebrow labels with wide tracking, grain/noise overlay, corner registration ticks, live clock, frame counters, coordinate tickers. These micro-details read as "designed by a human with taste."
7. **Choreograph one signature interaction.** Not ten effects — one memorable one (a cursor-trailing image card, magnetic recoiling letters, a scroll-pinned scene) plus a clean entrance.
8. **Always the reduced-motion path.** It's part of the spec, not an afterthought.

---

## Worked example (abridged) — "Monocrit"

A real gallery hero, showing the protocol filled in. Full pattern: near-monochrome Swiss-brutalist portfolio hero driven entirely by the cursor.

- **Aesthetic:** *"Monocrit"* — quiet, editorial, gallery-like Swiss brutalism; huge grotesque type on a vast field of bone paper; "a living poster" driven by the cursor.
- **Palette:** paper `#F2F0EB`, ink `#0D0D0D`, hairlines ink @10-15%, muted ink @55-65%, single accent signal-red `#FF3B2F` (status dot + one headline word + hovers only).
- **Type:** Bricolage Grotesque (variable, vendored). Headline `clamp(3.5rem,11vw,12rem)` / weight 700-800 / uppercase / `-0.04em` / `line-height 0.82`. Eyebrow 10-13px uppercase `0.28-0.35em`.
- **Layout:** fixed header (mark / live clock / "available" status pill) with `mix-blend-difference`; centered hero (eyebrow, two-line headline with one outlined word, hairline-topped split row); a fixed ~190×250px image card that *is* the cursor; fixed footer with index dots; grain overlay + registration ticks.
- **Motion:** custom cursor (`cursor:none`, card follows via `requestAnimationFrame` lerp ~0.12-0.18 with velocity tilt); headline letters recoil radially within ~150px of the pointer, springing back; pointer-travel accumulation cycles the portfolio images every ~60-80px; staggered entrance; live clock; **reduced-motion:** disable lerp/magnetism, static card, fully readable.
- **Responsive:** desktop full; tablet hides center meta, card shrinks; mobile disables cursor effects → auto-cycling static card, stacked meta, native touch.
- **Tech:** framework-free HTML/CSS/vanilla JS; font + 6 images vendored to `assets/`; runs offline.

Notice: no section is skipped, every value is concrete, motion has a fallback, and one accent carries the whole page. That's the standard to hit.
