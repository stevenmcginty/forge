# Tech conventions & quality bar

How the gallery projects are actually built, and the bar to hit. Two lanes dominate:

- **React + TypeScript + Vite + Tailwind** — for component-rich pages, shadcn/ui integrations, app-like UIs. Add **Framer Motion / Motion** for animation, **GSAP (+ScrollTrigger)** for scroll choreography, **Three.js / @react-three/fiber** for 3D, **Lucide** for icons.
- **Framework-free HTML + CSS + vanilla JS** — for heroes and self-contained showcases where a framework is dead weight. Often the *better* choice for a single distinctive section; many of the strongest gallery heroes are plain HTML/CSS/JS.

Pick the lighter lane that meets the brief. A single hero rarely needs React.

## Stack defaults
- **Build:** Vite. **Styling:** Tailwind (or hand-written CSS with custom properties for tokens). **Lang:** TypeScript for anything React.
- **Icons:** Lucide. **UI primitives:** shadcn/ui when the brief is component-heavy.
- **Video:** `<video>` with a poster; `hls.js` for streamed/Mux backgrounds. Always provide a poster still so nothing renders blank while loading.
- **Fonts:** vendor locally (`@font-face` from files in `assets/fonts/`, or a self-hosted subset). Never depend on a remote font CDN in shipped work.

## Design tokens
Define once, reference everywhere — the palette and type scale from the spec become CSS custom properties (or Tailwind theme extends):
```css
:root{
  --paper:#F2F0EB; --ink:#0D0D0D; --accent:#FF3B2F;
  --hairline:rgba(13,13,13,.12); --muted:rgba(13,13,13,.6);
  --step-display:clamp(3.5rem,11vw,12rem);
}
```
This keeps "one accent used sparingly" enforceable and makes the aesthetic coherent.

## Asset vendoring (self-contained & offline)
- Download every external asset — fonts, images, video/audio, 3D models, textures — into the project (`assets/`) and reference by **relative path**. Use `curl`/`wget`, verify the files exist and are non-empty.
- The project must clone-and-run offline. Only hotlink when an asset genuinely can't be downloaded (license-locked / dynamically generated) — and call that out.
- For imagery placeholders during dev, prefer real, license-safe sources over lorem — it changes how the layout reads.

## Accessibility (part of the bar, not optional)
- **`prefers-reduced-motion`**: every animation has a reduced path (see motion-patterns.md). This is the single most-forgotten item — include it in the spec.
- **Contrast:** verify text meets WCAG AA against its actual background (mix-blend headers on both extremes).
- **Semantics & focus:** real landmarks (`header/nav/main/footer`), buttons are `<button>`, links are `<a>`, visible focus states, keyboard-operable interactions.
- **Reduced pointer / touch:** hover-only affordances need a touch equivalent; targets ≥44px.
- **Alt text** on meaningful images; `aria-hidden` on decorative overlays (grain, particles).

## Responsive
- Design desktop-first for these showcase pieces, then define exactly what degrades: pointer effects → auto/timer or static, center meta hides, display type scales via `clamp()`, grids collapse to stacks. Everything stays legible and tappable at 375px.

## Anti-slop checklist (run before calling it done)
- [ ] Aesthetic is **named**, and the palette/type/motion all derive from it.
- [ ] **One** accent color, used sparingly — not a rainbow.
- [ ] Display type is oversized with tight negative tracking and `line-height < 1` — not default-sans-16px.
- [ ] Real font pairing, vendored — not the framework default.
- [ ] At least one **print-detail** (hairlines / grain / eyebrow labels / ticker / registration marks / live clock).
- [ ] **One signature interaction**, choreographed — plus a clean staggered entrance.
- [ ] Generous, intentional whitespace and a real spacing rhythm.
- [ ] Not centered-hero-with-two-buttons-and-three-feature-cards boilerplate. If it looks like every AI landing page, restart from the aesthetic.
- [ ] `prefers-reduced-motion` handled; AA contrast; keyboard/focus OK.
- [ ] Assets vendored; runs offline.

## Verification (CLI-first — show evidence)
- Typecheck/build: `tsc --noEmit`, `vite build` (or `npm run build`). Zero errors.
- Drive it headless: boot the dev server / serve the static files, then a Playwright or Puppeteer script that loads the page, waits for network idle, screenshots desktop + mobile widths, and asserts key elements render. Or `curl` the served HTML for smoke checks.
- Confirm the reduced-motion path (emulate `prefers-reduced-motion: reduce`) and both responsive breakpoints.
- Never claim it works without command output backing it. If it has a real runtime surface, exercise it — don't stop at "it should work."
