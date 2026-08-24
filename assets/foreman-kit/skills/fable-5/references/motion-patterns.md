# Motion & interaction pattern library

The signature interactions that recur across the gallery, ranked roughly by frequency in the corpus. Choreograph **one or two** of these per project — not ten — plus a clean entrance. Every motion pattern ships a `prefers-reduced-motion` fallback; those are listed per pattern.

Golden rules:
- **Lerp, don't snap.** Pointer-reactive elements ease toward their target each frame (`current += (target - current) * ease`, ease ≈ 0.08–0.18) inside a single `requestAnimationFrame` loop.
- **One rAF loop.** Drive all continuous motion from one loop; don't spawn a loop per element.
- **GPU-friendly props only.** Animate `transform` and `opacity`. Avoid animating layout (`top/left/width`) or `filter` on large areas per-frame.
- **Reduced motion is a spec item.** `@media (prefers-reduced-motion: reduce)` — disable loops, magnetism, autoplay, count-ups; keep everything readable and static.

---

## Entrance / reveal (near-universal)
Staggered rise+fade or clip-reveal on load and on scroll-into-view.
- **How:** `IntersectionObserver` adds an `in-view` class; CSS transitions `translateY(24px)→0` + `opacity 0→1`, staggered via `transition-delay` or an index-based delay. For headlines, wrap each word/letter in a span and clip-reveal (`clip-path: inset(100% 0 0 0)→inset(0)`).
- **Timing:** 400–700ms, ease `cubic-bezier(0.16,1,0.3,1)` (expo-out) or `(0.22,1,0.36,1)`. Stagger 30–80ms.
- **Reduced motion:** show final state immediately, no transform.

## Scroll-pin & scroll-driven (`pin`, `sticky`, `scroll-driven`)
Pin a section while its inner content advances with scroll (horizontal galleries, step sequences, scene reveals).
- **How:** GSAP ScrollTrigger `pin: true` with a scrub, or CSS `position: sticky` + `scroll-timeline`/`animation-timeline: view()` where support allows. Map scroll progress → transform.
- **Reduced motion:** unpin; let sections flow normally in document order.

## Marquee / ticker (`marquee`, `ticker`)
Continuously scrolling logo strip, coordinate ticker, or headline band; pause on hover.
- **How:** duplicate the track, translate `-50%` over a linear infinite loop; `:hover { animation-play-state: paused }`. For seamlessness, render the content twice.
- **Reduced motion:** static row, no scroll.

## Parallax (`parallax`)
Layers move at different rates on scroll or pointer.
- **How:** per-layer `translateY = scrollProgress * depth` (or pointer offset * depth), lerped. Keep depth subtle (0.02–0.15).
- **Reduced motion:** lock layers.

## Magnetic / recoiling elements (`magnetic`)
Buttons pull toward the cursor; headline letters recoil away from it.
- **How:** on `mousemove`, for each target compute distance to pointer; within a radius (~120–150px) displace by a proportion of the delta (magnetic: toward; recoil: away), lerp back to rest on leave with a springy easing.
- **Reduced motion:** disable; elements sit at rest.

## Cursor-follow card / custom cursor (`custom cursor`, `cursor-follow`)
Hide the native cursor; a card or ring trails the pointer with inertia and velocity tilt; morphs over interactive elements.
- **How:** `cursor: none`; a fixed element lerps to pointer each frame (ease ~0.12–0.18); `rotate`/`skew` from pointer velocity; on hover of links, fade the card and show a small ring/label.
- **Reduced motion / coarse pointer:** restore native cursor; the card becomes static or auto-cycles on a timer.

## Count-up (`count-up`)
Numbers/stats animate 0 → target when scrolled into view.
- **How:** `IntersectionObserver` triggers a rAF tween of the number; use tabular-nums to prevent width jitter; ease-out over 800–1500ms.
- **Reduced motion:** render final value directly.

## Mix-blend header/footer (`mix-blend`)
A fixed header/footer that stays legible over both light and dark regions.
- **How:** `mix-blend-mode: difference` (or `exclusion`) on the bar so text inverts against whatever scrolls under it. Test contrast on both extremes.
- **Reduced motion:** unaffected (not motion) — keep it.

## Grain / noise / texture overlay (`noise`, `grain`)
A faint film-grain layer that lifts flat fills into "designed" surfaces.
- **How:** a fixed full-screen overlay with an SVG `feTurbulence` noise (data-URI) or a tiny tiled PNG at 3–6% opacity, `pointer-events: none`, optionally `mix-blend-mode: overlay`. Static or a slow 2-frame shift.
- **Reduced motion:** static (no animated grain).

## Tilt (`tilt`)
Card rotates in 3D toward the pointer.
- **How:** `perspective` on the parent; map pointer offset within the card to `rotateX/rotateY` (±6–12°), lerped; reset on leave.
- **Reduced motion:** flat, no tilt.

## Text scramble / typewriter (`scramble`, `typewriter`)
Decoding/typing effect on a headline or label.
- **How:** scramble = swap glyphs from a charset, settling left-to-right; typewriter = reveal characters on an interval with a blinking caret.
- **Reduced motion:** show final string immediately.

## Bento / masonry layout (`bento`, `masonry`)
Editorial grid of unequal tiles (a *layout* signature that pairs with parallax/reveal).
- **How:** CSS grid with spanned cells (`grid-column/row: span N`) or a masonry lib; give tiles hover lift + individual reveal delays.

---

## Shaders & 3D (`shader`, `webgl`, `spline`, `particle`)
The gallery's `shaders/` and `3d-games/` categories.
- **Shader backgrounds:** GLSL via a full-screen quad (raw WebGL, `@react-three/fiber` + `shaderMaterial`, or paper-shaders). Feed `u_time`, `u_resolution`, `u_mouse`, and scroll progress. Keep it a *background* — legible content sits above with a scrim.
- **3D scenes:** Three.js / `@react-three/fiber`; embed lightweight Spline scenes for hero backdrops; instanced particles for star/dust fields on a 2D canvas when full WebGL is overkill.
- **Perf:** cap DPR (`Math.min(devicePixelRatio, 2)`), pause rAF when tab hidden / element off-screen, throttle particle counts on mobile.
- **Reduced motion:** freeze `u_time` (render one frame) or swap to a static gradient/poster image.

## Libraries by job
- **GSAP** (+ ScrollTrigger): scroll-pin, scrub timelines, complex sequences.
- **Framer Motion / Motion**: React entrance, layout, spring, `whileInView`, gesture.
- **Lenis**: smooth-scroll base that parallax/pin build on.
- **Three.js / @react-three/fiber / drei**: 3D & WebGL.
- **Vanilla `requestAnimationFrame`**: lerp cursors, magnetism, count-ups — no library needed.
- **hls.js**: streaming background video (Mux) in cinematic heroes.
