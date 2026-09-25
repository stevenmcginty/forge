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
 * directly and runs READ_SCRIPT inside a real page.
 */

/** What READ_SCRIPT hands back. */
export interface PageSnapshot {
  url: string
  title: string
  items: string[]
  dropped: number
  text: string
}

/**
 * Number every visible interactive element, park them on the page, and return
 * the list plus the page's own words. An expression, so evaluate returns it.
 */
export const READ_SCRIPT = `(() => {
  const LIMIT_REFS = ${BROWSER_MAX_REFS};
  const LIMIT_LABEL = ${BROWSER_MAX_LABEL_CHARS};
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
  const refs = [];
  const items = [];
  let dropped = 0;
  for (const el of deepAll(SELECTOR)) {
    if (!visible(el)) continue;
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
  return { url: location.href, title: document.title, items, dropped, text: blocks.join('\\n') };
})()`

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
    snap.items.length ? snap.items.join('\n') : 'Nothing on this page is clickable.'
  ]
  if (snap.dropped) lines.push(`…and ${snap.dropped} more, past the limit of ${BROWSER_MAX_REFS}.`)
  let out = lines.join('\n')
  if (out.length > BROWSER_MAX_READ_CHARS) return `${out.slice(0, BROWSER_MAX_READ_CHARS)}\n…truncated`
  const heading = 'What the page says:'
  const room = BROWSER_MAX_READ_CHARS - out.length - heading.length - 16
  const body = snap.text.length > room ? `${snap.text.slice(0, Math.max(0, room))}\n…truncated` : snap.text
  if (body.trim()) out = `${out}\n\n${heading}\n${body}`
  return out
}
