import { BROWSER_MAX_LABEL_CHARS, BROWSER_MAX_READ_CHARS, BROWSER_MAX_REFS } from '@shared/browser'

/**
 * How a page is read, and how a number from that read finds its element again.
 *
 * The same contract as the old voice agent's chrome-control read, on purpose:
 * every clickable thing gets a number, the elements behind those numbers are
 * parked on the page as `window.__forgeRefs`, and browser_click / browser_type
 * take nothing else. A selector invented by a model is a guess; a number it was
 * just handed is a thing it actually saw. Numbers restart at 1 on every read and
 * die with the document.
 *
 * The page-side code is kept as *source text* and run through CDP
 * `Runtime.evaluate`, rather than as TypeScript functions, because the Electron
 * tsconfig has no DOM library and main-process code has no business with one.
 * Plain Node, no Electron import: scripts/browser-check.mjs runs `formatRead`
 * directly and runs readScript() inside a real page.
 */

/** What readScript() hands back. */
export interface PageSnapshot {
  url: string
  title: string
  items: string[]
  /** Seeable and reachable, but past BROWSER_MAX_REFS. */
  dropped: number
  /** Drawn, but hidden, covered or out of reach — left out on purpose. */
  hidden?: number
  /** With `find`: elements whose words do not contain it. */
  unmatched?: number
  /** The `find` text the list was narrowed by, as given. */
  find?: string
  /** How many of the first items sit inside the dialog on top of the page. */
  inDialog?: number
  text: string
}

/**
 * Number every interactive element a person could see and reach, park them on
 * the page, and return the list plus the page's own words. An expression, so
 * evaluate returns it. `find` narrows the list to elements whose words contain
 * it (any case); the numbers still map to window.__forgeRefs as usual.
 *
 * What counts as seeable and reachable — kept simple on purpose:
 *  - It has a box (1×1 or bigger), and neither it nor anything it sits in is
 *    display:none, visibility:hidden or opacity:0 (Element.checkVisibility), or
 *    [inert] / [aria-hidden=true] (shadow roots crossed).
 *  - On screen: a hit test (elementFromPoint at its middle and four inner
 *    points) must land on it, inside it, or on its own <label>. Landing on
 *    something else means it is covered. One exception: covered only by a
 *    fixed/sticky bar (wide and short: a header or footer) still counts, since
 *    scrolling brings it out from under the bar.
 *  - Off screen (below the fold, in a scroll box): it must be reachable by
 *    scrolling — not clipped away by an overflow:hidden box, not in a fixed
 *    layer that sits off screen, not at negative page coordinates. And when a
 *    modal is up (aria-modal / <dialog> opened modal, or a full-screen fixed
 *    layer at the viewport centre that is proven to cover other elements), only
 *    what is inside it is listed: the rest would scroll up underneath it.
 *  - Elements inside the dialog on top (or that full-screen layer) come first,
 *    so a modal's buttons never fall past the cap behind the page under it.
 */
export function readScript(find: string | null): string {
  return `(() => {
  const LIMIT_REFS = ${BROWSER_MAX_REFS};
  const LIMIT_LABEL = ${BROWSER_MAX_LABEL_CHARS};
  const FIND_RAW = ${JSON.stringify(find ?? '')};
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
    '[role="combobox"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="textbox"]',
    '[contenteditable="true"]', '[onclick]'
  ].join(', ');
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.opacity !== '0' && style.display !== 'none';
  };
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = clean(el.getAttribute('role'));
    if (tag === 'a') return 'link';
    if (tag === 'input') return 'input ' + clean(el.getAttribute('type') || 'text');
    if (tag === 'button' || tag === 'select' || tag === 'textarea') return tag;
    if (el.isContentEditable) return 'editable';
    return role || tag;
  };
  // A password, card or one-time code someone typed by hand must never reach
  // the model: such a field's value is never read, only whether it is filled.
  const secret = (el) => el.tagName === 'INPUT' && (String(el.type).toLowerCase() === 'password' ||
    /(^|\\s)(cc-|one-time-code|current-password|new-password)/.test(clean(el.getAttribute('autocomplete')).toLowerCase()));
  const labelOf = (el) => {
    const labelled = el.labels && el.labels.length ? el.labels[0].innerText : '';
    const candidates = [el.innerText, el.getAttribute('aria-label'), labelled, el.getAttribute('placeholder'),
      secret(el) ? '' : el.value, el.getAttribute('title'), el.getAttribute('alt'), el.getAttribute('name')];
    for (const c of candidates) {
      const t = clean(c);
      if (t) return t.slice(0, LIMIT_LABEL);
    }
    return '';
  };
  // The document and every open shadow root inside it (web components).
  const deepAll = (selector) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll(selector)) out.push(el);
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot);
    };
    walk(document);
    return out;
  };
  // Up one level, out of a shadow root into its host when need be.
  const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const inside = (outer, n) => { for (let x = n; x; x = up(x)) if (x === outer) return true; return false; };
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = document.documentElement.clientHeight || innerHeight;
  const muted = (el) => {
    for (let x = el; x; x = up(x)) if (x.hasAttribute('inert') || x.getAttribute('aria-hidden') === 'true') return true;
    return false;
  };
  const drawn = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0' || style.display === 'none') return false;
    return typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  // A fixed or sticky bar across most of the width and short: a header or footer.
  const barOf = (n) => {
    for (let x = n; x; x = up(x)) {
      const p = getComputedStyle(x).position;
      if (p === 'fixed' || p === 'sticky') {
        const b = x.getBoundingClientRect();
        return b.width >= vw * 0.5 && b.height <= vh * 0.3;
      }
    }
    return false;
  };
  // Where hit tests at the part of el on screen now (box, from clipped) land:
  // 'top', 'bar', 'covered', or 'off' (none of it on screen).
  const hitTest = (el, box, own) => {
    if (!box) return { at: 'off', hits: [] };
    const l = Math.max(box.L, 0), t = Math.max(box.T, 0), r = Math.min(box.R, vw), b = Math.min(box.B, vh);
    if (r - l < 1 || b - t < 1) return { at: 'off', hits: [] };
    const root = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : document;
    const x1 = l + (r - l) * 0.2, x2 = l + (r - l) * 0.8, y1 = t + (b - t) * 0.2, y2 = t + (b - t) * 0.8;
    const hits = [];
    for (const [x, y] of [[(l + r) / 2, (t + b) / 2], [x1, y1], [x2, y1], [x1, y2], [x2, y2]]) {
      const hit = root.elementFromPoint(x, y);
      if (hit && own(hit)) return { at: 'top', hits };
      hits.push(hit);
    }
    if (hits.every((h) => h && barOf(h))) return { at: 'bar', hits };
    return { at: 'covered', hits };
  };
  const mine = (el) => (hit) => {
    if (hit === el || inside(el, hit)) return true;
    if (el.labels) for (const lab of el.labels) if (inside(lab, hit)) return true;
    // Nothing ever lands on a pointer-events:none element; a click falls through to what holds it.
    return inside(hit, el) && getComputedStyle(el).pointerEvents === 'none';
  };
  const scrolls = (v) => v === 'auto' || v === 'scroll';
  const clips = (v) => v !== 'visible';
  const htmlStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : htmlStyle;
  const pageX = !['hidden', 'clip'].includes(htmlStyle.overflowX) && !['hidden', 'clip'].includes(bodyStyle.overflowX);
  const pageY = !['hidden', 'clip'].includes(htmlStyle.overflowY) && !['hidden', 'clip'].includes(bodyStyle.overflowY);
  const pageBox = document.scrollingElement || document.documentElement;
  // el's box as the boxes it sits in clip it: as things stand (roam false), or
  // once the boxes that scroll are scrolled to it (roam true). Null when none of it is left.
  const clipped = (el, roam) => {
    const b0 = el.getBoundingClientRect();
    let L = b0.left, T = b0.top, R = b0.right, B = b0.bottom, fixed = false;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = up(n)) {
      const s = getComputedStyle(n);
      if (n !== el && (clips(s.overflowX) || clips(s.overflowY))) {
        const c = n.getBoundingClientRect();
        if (clips(s.overflowX)) {
          if (roam && scrolls(s.overflowX) && n.scrollWidth > n.clientWidth + 1) {
            const at = L - c.left + n.scrollLeft;
            if (at + (R - L) <= 0 || at >= n.scrollWidth) return null;
            const w = Math.min(R - L, c.width); L = c.left; R = c.left + w;
          } else { L = Math.max(L, c.left); R = Math.min(R, c.right); }
        }
        if (clips(s.overflowY)) {
          if (roam && scrolls(s.overflowY) && n.scrollHeight > n.clientHeight + 1) {
            const at = T - c.top + n.scrollTop;
            if (at + (B - T) <= 0 || at >= n.scrollHeight) return null;
            const h = Math.min(B - T, c.height); T = c.top; B = c.top + h;
          } else { T = Math.max(T, c.top); B = Math.min(B, c.bottom); }
        }
        if (R - L < 1 || B - T < 1) return null;
      }
      if (s.position === 'fixed') { fixed = true; break; }
    }
    return { L, T, R, B, fixed };
  };
  // Can scrolling (the page, or a scroll box it sits in) bring el on screen?
  const reachable = (el) => {
    const b = clipped(el, true);
    if (!b) return false;
    // A fixed layer never scrolls with the page: off screen is off for good.
    if (b.fixed) return b.R > 0 && b.B > 0 && b.L < vw && b.T < vh;
    const x0 = pageX ? -scrollX : 0, y0 = pageY ? -scrollY : 0;
    const x1 = pageX ? pageBox.scrollWidth - scrollX : vw, y1 = pageY ? pageBox.scrollHeight - scrollY : vh;
    return b.R > x0 && b.B > y0 && b.L < x1 && b.T < y1;
  };
  const words = (el) => clean([el.innerText, el.getAttribute('aria-label'), el.labels && el.labels.length ? el.labels[0].innerText : '',
    el.getAttribute('placeholder'), secret(el) ? '' : el.value, el.getAttribute('title'), el.getAttribute('alt'), el.getAttribute('name')].join(' ')).toLowerCase();
  const FIND = clean(FIND_RAW).toLowerCase();
  const sized = vw >= 1 && vh >= 1;

  // What is on top: the last open dialog whose middle is really on top, and
  // the innermost full-screen fixed layer under the viewport's centre.
  const shown = (n) => { const b = n.getBoundingClientRect(); return b.width >= 1 && b.height >= 1 && drawn(n) && !muted(n); };
  let dialog = null, modal = null, layer = null;
  if (sized) {
    for (const d of deepAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
      if (!shown(d) || hitTest(d, clipped(d, false), (h) => h === d || inside(d, h)).at !== 'top') continue;
      dialog = d;
      let isModal = d.getAttribute('aria-modal') === 'true';
      try { isModal = isModal || d.matches(':modal'); } catch (e) { /* older engine */ }
      if (isModal) modal = d;
    }
    let h = document.elementFromPoint(vw / 2, vh / 2);
    while (h && h.shadowRoot) { const d = h.shadowRoot.elementFromPoint(vw / 2, vh / 2); if (!d || d === h) break; h = d; }
    for (let n = h; n && n !== document.body && n !== document.documentElement; n = up(n)) {
      if (getComputedStyle(n).position !== 'fixed') continue;
      const b = n.getBoundingClientRect();
      if (Math.min(b.right, vw) - Math.max(b.left, 0) >= vw * 0.9 && Math.min(b.bottom, vh) - Math.max(b.top, 0) >= vh * 0.9) { layer = n; break; }
    }
  }

  const refs = [];
  const items = [];
  let dropped = 0, hidden = 0, unmatched = 0;
  const onTop = [];
  const later = [];
  const candidates = [];
  let layerCovers = false;
  for (const el of deepAll(SELECTOR)) {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    if (FIND && !words(el).includes(FIND)) { unmatched++; continue; }
    if (!drawn(el) || muted(el)) { hidden++; continue; }
    candidates.push(el);
    if (!sized) { onTop.push(el); continue; }
    const test = hitTest(el, clipped(el, false), mine(el));
    if (test.at === 'top') onTop.push(el);
    else if (test.at === 'covered') {
      hidden++;
      if (layer && !inside(layer, el) && test.hits.some((x) => x && inside(layer, x))) layerCovers = true;
    } else later.push(el);
  }
  // A full-screen layer only counts as a modal once it is seen covering something.
  const gate = modal || (layerCovers ? layer : null);
  const listed = new Set(onTop);
  for (const el of later) {
    if (reachable(el) && (!gate || inside(gate, el))) listed.add(el); else hidden++;
  }
  const front = modal || dialog || gate;
  const all = candidates.filter((el) => listed.has(el));
  const first = front ? all.filter((el) => inside(front, el)) : [];
  const ordered = first.length ? first.concat(all.filter((el) => !inside(front, el))) : all;
  const inDialog = dialog ? Math.min(first.length, LIMIT_REFS) : 0;
  for (const el of ordered) {
    if (refs.length >= LIMIT_REFS) { dropped++; continue; }
    refs.push(el);
    const extra = secret(el) ? (el.value ? ' (filled in — hidden)' : '')
      : (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value && clean(el.value) !== labelOf(el)
      ? ' = "' + clean(el.value).slice(0, 40) + '"' : '';
    items.push('[' + refs.length + '] ' + kindOf(el) + ' "' + labelOf(el) + '"' + extra);
  }
  window.__forgeRefs = refs;
  const seen = new Set();
  const blocks = [];
  for (const el of deepAll('h1, h2, h3, h4, p, li, td, th, pre, blockquote')) {
    if (!visible(el)) continue;
    const t = clean(el.innerText);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    blocks.push(t);
  }
  return { url: location.href, title: document.title, items, dropped, hidden, unmatched, find: clean(FIND_RAW), inDialog, text: blocks.join('\\n') };
})()`
}

/**
 * Bring ref N into view and say where its middle is, for a real mouse click.
 * Null when the number no longer points at anything.
 */
export function refPointScript(ref: number): string {
  return `(() => {
  const refs = window.__forgeRefs;
  const el = refs ? refs[${Math.round(ref) - 1}] : undefined;
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const box = el.getBoundingClientRect();
  const hidden = el.tagName === 'INPUT' && (String(el.type).toLowerCase() === 'password' || /(^|\\s)(cc-|one-time-code|current-password|new-password)/.test(String(el.getAttribute('autocomplete') || '').toLowerCase()));
  const label = String(el.innerText || el.getAttribute('aria-label') || (hidden ? el.getAttribute('placeholder') || 'hidden field' : el.value) || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60);
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, label, w: box.width, h: box.height };
})()`
}

/**
 * Focus ref N and empty it, so typing replaces rather than appends. Null when
 * the number is stale. Uses the native value setter so React-controlled inputs
 * see the change.
 */
export function refFocusScript(ref: number): string {
  return `(() => {
  const refs = window.__forgeRefs;
  const el = refs ? refs[${Math.round(ref) - 1}] : undefined;
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  el.focus();
  const label = String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60);
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
  }
  return { label, focused: document.activeElement === el };
})()`
}

/**
 * The click for a tab that is not on screen. A hidden view gets no real mouse
 * input (Chromium never acks it), so the same sequence a hand produces is
 * dispatched on the element itself — pointer and mouse down/up, then click —
 * which links, buttons, forms and React handlers all honour.
 */
export function refDomClickScript(ref: number): string {
  return `(() => {
  const refs = window.__forgeRefs;
  const el = refs ? refs[${Math.round(ref) - 1}] : undefined;
  if (!el || !el.isConnected) return false;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const box = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  if (typeof el.focus === 'function') el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', at));
  el.dispatchEvent(new MouseEvent('click', { ...at, detail: 1 }));
  return true;
})()`
}

/** What uploadTargetScript hands back. `boxes` describes every file box, in page order. */
export type UploadTarget =
  | { kind: 'ok'; label: string }
  | { kind: 'not-file'; label: string }
  | { kind: 'none' }
  | { kind: 'many'; boxes: string[] }
  | { kind: 'bad-which'; boxes: string[] }

/**
 * Find the file box browser_upload means and park it on the page as
 * `window.__forgeUpload`, for main to hand to CDP DOM.setFileInputFiles. Null
 * when `ref` is stale.
 *
 * File boxes are usually hidden (`display: none` under a styled "Upload"
 * label), so they never get a read number: every `input[type=file]` counts
 * here, seen or not, shadow roots included. `ref` picks the box that element
 * is, holds, labels, or sits beside (a parent with exactly one); `which` picks
 * by the 1-based number in the list a `many` answer gave.
 */
export function uploadTargetScript(ref: number | null, which: number | null): string {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const isFile = (n) => !!n && n.tagName === 'INPUT' && String(n.type).toLowerCase() === 'file';
  const deepAll = (selector) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll(selector)) out.push(el);
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot);
    };
    walk(document);
    return out;
  };
  const labelOf = (el) => {
    const near = el.closest('label');
    const candidates = [el.labels && el.labels.length ? el.labels[0].innerText : '', el.getAttribute('aria-label'),
      near ? near.innerText : '', el.getAttribute('title'), el.getAttribute('name'), el.id,
      el.parentElement ? el.parentElement.innerText : ''];
    for (const c of candidates) {
      const t = clean(c);
      if (t) return t.slice(0, 60);
    }
    return '';
  };
  const describe = (el) => {
    const accept = clean(el.getAttribute('accept'));
    const label = labelOf(el);
    return (label ? '"' + label + '"' : 'unlabelled') + (accept ? ' (accepts ' + accept + ')' : '') +
      (el.multiple ? ', several files' : '') + (el.disabled ? ', disabled' : '');
  };
  const park = (el) => {
    window.__forgeUpload = el;
    return { kind: 'ok', label: labelOf(el) };
  };
  const all = deepAll('input[type=file]');
  const boxes = all.map((el, i) => '  ' + (i + 1) + '. ' + describe(el));
  const ref = ${ref === null ? 'null' : Math.round(ref)};
  const which = ${which === null ? 'null' : Math.round(which)};
  if (ref !== null) {
    const refs = window.__forgeRefs;
    const el = refs ? refs[ref - 1] : undefined;
    if (!el || !el.isConnected) return null;
    let box = isFile(el) ? el : isFile(el.control) ? el.control : null;
    if (!box && el.querySelector) box = el.querySelector('input[type=file]');
    if (!box && el.closest) {
      const lab = el.closest('label');
      if (lab && isFile(lab.control)) box = lab.control;
    }
    if (!box && el.parentElement) {
      const near = el.parentElement.querySelectorAll('input[type=file]');
      if (near.length === 1) box = near[0];
    }
    if (!box) return { kind: 'not-file', label: clean(el.innerText || el.getAttribute('aria-label') || el.tagName).slice(0, 60) };
    return park(box);
  }
  if (all.length === 0) return { kind: 'none' };
  if (which !== null) return which >= 1 && which <= all.length ? park(all[which - 1]) : { kind: 'bad-which', boxes };
  if (all.length === 1) return park(all[0]);
  return { kind: 'many', boxes };
})()`
}

/** "1, 2, 3 — and nothing else." */
export function badRef(ref: unknown): boolean {
  const n = Number(ref)
  return !Number.isFinite(n) || Math.round(n) < 1 || Math.round(n) > BROWSER_MAX_REFS
}

/** What the model hears when a number no longer points at anything. */
export function staleRef(ref: number): string {
  return `There is no element ${ref} on this page any more — the page has changed or moved on. Read it again with browser_read to get fresh numbers.`
}

/** A snapshot, as the words a model reads. Bounded by BROWSER_MAX_READ_CHARS. */
export function formatRead(tabId: string, snap: PageSnapshot): string {
  const lines = [
    `Tab ${tabId}: ${snap.url} — "${snap.title}"`,
    '',
    'Things you can click or type into. These numbers are good only until you read or navigate again, and they start at 1 every time:',
    snap.items.length
      ? snap.items.join('\n')
      : snap.find
        ? `Nothing you can click here has "${snap.find}" in its words.`
        : 'Nothing on this page is clickable.'
  ]
  if (snap.inDialog) lines.push(`[1]–[${snap.inDialog}] are in the dialog on top of the page.`)
  if (snap.dropped) {
    const hint = snap.find ? '' : ' Pass `find` with a word from the one you want to list only the elements that have it.'
    lines.push(`…and ${snap.dropped} more, past the limit of ${BROWSER_MAX_REFS}.${hint}`)
  }
  if (snap.hidden) lines.push(`Left out: ${snap.hidden} hidden, covered by something on top, or out of reach — not clickable as the page stands.`)
  if (snap.find) lines.push(`Only elements whose words contain "${snap.find}" are listed; ${snap.unmatched ?? 0} others were left out. Read without \`find\` for everything.`)
  let out = lines.join('\n')
  if (out.length > BROWSER_MAX_READ_CHARS) return `${out.slice(0, BROWSER_MAX_READ_CHARS)}\n…truncated`
  const heading = 'What the page says:'
  const room = BROWSER_MAX_READ_CHARS - out.length - heading.length - 16
  const body = snap.text.length > room ? `${snap.text.slice(0, Math.max(0, room))}\n…truncated` : snap.text
  if (body.trim()) out = `${out}\n\n${heading}\n${body}`
  return out
}
