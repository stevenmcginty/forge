---
name: fable-5
description: >-
  Build distinctive, gallery-grade front-end UI — hero sections, landing pages,
  portfolios, design-system showcases, shaders, animated/interactive components,
  and 3D/WebGL scenes — using the design protocol, named-aesthetic lexicon, and
  motion-pattern library distilled from the claude-directory ("Fable 5") gallery
  of ~550 AI-generated UI experiments. Invoke when the user wants a website,
  landing page, hero, component, or UI that should look intentional and premium
  rather than templated — especially when they say "Fable 5", "make it look
  good/distinctive/premium", ask for a specific aesthetic, or want a design spec
  before code. Covers React/TS/Vite/Tailwind and framework-free HTML/CSS/JS.
---

# Fable 5

A design capability distilled from **claude-directory** (github.com/pulkitxm/claude-directory) — an open gallery of ~550 UI experiments, every one built from a detailed design spec and shipped with the prompt that made it. The through-line across all of them is a repeatable way of working that produces *distinctive, intentional* interfaces instead of generic AI-slop. This skill encodes that method plus its reference libraries.

## The core idea

**Do not jump straight to code.** The gallery's quality comes from writing a tight *design spec first* — naming an aesthetic, fixing an exact palette and type scale, choreographing motion — and only then implementing it faithfully. Great UI here is the output of a great spec, not a lucky render.

So the workflow is always: **name an aesthetic → write the spec → build to the spec → verify.**

## When to use this

Use it whenever you're building or reshaping visible UI and quality matters: a hero, a full landing page, a portfolio, a pricing/features section, a design-system showcase, an animated component, a shader background, a 3D scene. Use it especially when the user wants something that looks *premium and specific*, references "Fable 5", or asks for a particular vibe.

Don't use it for pure logic/back-end work, or trivial tweaks where a full spec is overkill (though even a small component benefits from a named aesthetic + exact tokens).

## Step 1 — Name the aesthetic (the anchor)

Before anything, commit to a **named design language** — two or three evocative words that fix the mood, e.g. *"Precision Grid"*, *"Warm Cartography"*, *"Spectral Darkroom"*, *"Obsidian Lacquer"*, *"Quiet Craft Editorial"*. This single act is what steers every downstream decision away from defaults.

- If the user gave a vibe, coin a name that captures it. If they didn't, propose 2-3 distinct directions and pick/confirm one.
- The name must imply a **palette**, a **type personality**, a **texture**, and a **motion character**. "Warm Cartography" already tells you: bone paper, ember accent, cartographic tickers, editorial serif/grotesk, unhurried parallax.
- See `references/design-languages.md` for 100+ named aesthetics grouped into families, each with its palette/type/motion signature — and rules for coining your own.

## Step 2 — Write the spec (the protocol)

Write a spec with these sections (this is the exact anatomy the whole gallery shares). Keep it concrete — exact hex, exact `clamp()` values, exact easings. Full template + a worked example in `references/spec-protocol.md`.

1. **Named aesthetic identity** — the name + a paragraph on mood and the one big idea.
2. **Color palette (strict/exact)** — background, ink, 1-2 surfaces, hairlines, muted text, and **one** decisive accent used sparingly. Exact hex/rgb.
3. **Typography** — named fonts (vendored), a display size via `clamp()`, tight negative tracking + `line-height` under 1 for display, an uppercase eyebrow scale with wide tracking.
4. **Layout & structure** — numbered sections/regions, top to bottom.
5. **Motion / interaction spec** — entrance, scroll, pointer, and ambient motion, each with timing/easing; always include a `prefers-reduced-motion` fallback.
6. **Responsive behavior** — desktop / tablet / mobile, and what degrades (usually pointer-driven effects → auto/timer or static).
7. **Tech notes** — stack, self-contained/offline, vendored assets, no hotlinked CDNs for shipped assets.

## Step 3 — Build to the spec

Implement the whole thing, faithfully. Quality bar and conventions in `references/tech-conventions.md`. Non-negotiables:

- **One accent, used sparingly.** Restraint reads as expensive. Ink on paper (or the reverse) + a single loud accent beats a rainbow every time.
- **Type does the heavy lifting.** Huge display sizes, tight tracking, real font pairings — not the framework default sans at 16px.
- **Texture and detail.** Grain/noise overlay, hairline rules, registration marks, live clocks, tickers, counters — the small print-inspired details that signal intent.
- **Motion is choreographed, not sprinkled.** A deliberate entrance sequence and one or two signature interactions, all reduced-motion-safe.
- **Vendor assets, run offline.** Download fonts/images/video/models locally; reference by relative path.
- Reach for the motion vocabulary in `references/motion-patterns.md` (magnetic letters, lerp cursor-card, mix-blend header, scroll-pin, marquee, count-up, shader background, …).

## Step 4 — Verify

CLI-first: build/typecheck, then drive it headless (Playwright/Puppeteer/`curl`) — never claim it works without evidence. If the project has a real runtime surface, actually exercise it. Confirm responsive breakpoints and the reduced-motion path.

## Reference library (load on demand)

- **`references/spec-protocol.md`** — the 7-part spec template + a full worked example. Read before writing any spec.
- **`references/design-languages.md`** — 100+ named aesthetics in families, each with palette/type/motion signature; how to coin new ones. Read when choosing/naming a direction.
- **`references/motion-patterns.md`** — the interaction & motion pattern library with implementation notes and reduced-motion fallbacks. Read when speccing/building motion.
- **`references/tech-conventions.md`** — stack choices, font shortlist, anti-slop checklist, accessibility, asset vendoring, verification. Read when building.
- **`references/catalog.md`** — index of ~513 real gallery projects (name / description / stack) by category. Grep it for the closest 2-3 precedents to any brief.

## Provenance

Distilled 2026-07 from `claude-directory` by pulkitxm. The gallery is itself "vibe-coded" — treat generated output as a strong starting point: review code, check dependencies, verify accessibility and responsiveness before shipping to production.
