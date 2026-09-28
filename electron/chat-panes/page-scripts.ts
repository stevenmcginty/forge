import type { ChatBotDrive } from '@shared/chatbots'

/**
 * The scripts an agent's chat_send / chat_read run inside a chat page, as
 * strings for `webContents.executeJavaScript`. Pure: no Electron, no DOM here,
 * so scripts/chat-tools-check.mjs runs these exact strings in a real Chromium
 * against stand-in pages.
 *
 * Each one is a self-contained expression that answers plain JSON. They find
 * things through the bot's `drive` selectors (shared/chatbots.ts), where the
 * first selector that matches anything wins. Nothing here reads cookies,
 * storage or anything outside what the page shows.
 */

/** What a page looks like to an agent, between moves. */
export interface ChatProbe {
  /** The message box is there (the page is loaded and signed in, or at least usable). */
  composer: boolean
  /** Words already in the message box. */
  draft: string
  /** The send button is there and pressable. */
  canSend: boolean
  /** A reply is being written. */
  busy: boolean
  replies: number
  users: number
  /** The latest reply's text. */
  lastReply: string
  title: string
}

export interface ChatMessage {
  role: 'user' | 'bot'
  text: string
}

/** The helpers every script opens with. `D` is the bot's drive data. */
function prelude(drive: ChatBotDrive): string {
  return `
    const D = ${JSON.stringify(drive)};
    const all = (sels) => {
      for (const s of sels) {
        try {
          const found = Array.from(document.querySelectorAll(s));
          if (found.length) return found;
        } catch (e) {}
      }
      return [];
    };
    const one = (sels) => all(sels)[0] || null;
    const textOf = (el) => (el ? ('value' in el && typeof el.value === 'string' ? el.value : el.innerText || el.textContent || '') : '');
    const tidy = (t) => String(t || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    const pressable = (b) => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  `
}

/** Where the page is: see ChatProbe. */
export function probeScript(drive: ChatBotDrive): string {
  return `(() => {
    ${prelude(drive)}
    const box = one(D.composer);
    const replies = all(D.reply);
    const last = replies[replies.length - 1];
    return {
      composer: !!box,
      draft: tidy(textOf(box)),
      canSend: pressable(one(D.send)),
      busy: all(D.busy).length > 0,
      replies: replies.length,
      users: all(D.user).length,
      lastReply: tidy(textOf(last)),
      title: document.title || ''
    };
  })()`
}

/**
 * Put `text` in the message box, at the end of whatever is there, as typing
 * would: focus, caret to the end, then the editing command a keyboard's
 * input goes through — so ProseMirror, Quill and a plain textarea all hear it
 * as input. Answers what the box holds afterwards, or null with no box.
 */
export function typeScript(drive: ChatBotDrive, text: string): string {
  return `(() => {
    ${prelude(drive)}
    const box = one(D.composer);
    if (!box) return null;
    box.focus();
    if ('value' in box && typeof box.value === 'string') {
      const end = box.value.length;
      box.setSelectionRange(end, end);
    } else {
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('insertText', false, ${JSON.stringify(text)});
    return tidy(textOf(box));
  })()`
}

/** Just focus the message box, caret at the end — before Electron's own insertText. */
export function focusScript(drive: ChatBotDrive): string {
  return `(() => {
    ${prelude(drive)}
    const box = one(D.composer);
    if (!box) return false;
    box.focus();
    if (!('value' in box && typeof box.value === 'string')) {
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return true;
  })()`
}

/**
 * Send what is in the box: the send button when it is there and pressable,
 * else Enter in the box. Answers which it used, or 'none' with no box at all.
 */
export function sendScript(drive: ChatBotDrive): string {
  return `(() => {
    ${prelude(drive)}
    const button = one(D.send);
    if (pressable(button)) {
      button.click();
      return 'button';
    }
    const box = one(D.composer);
    if (!box) return 'none';
    box.focus();
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    box.dispatchEvent(new KeyboardEvent('keydown', init));
    box.dispatchEvent(new KeyboardEvent('keypress', init));
    box.dispatchEvent(new KeyboardEvent('keyup', init));
    return 'enter';
  })()`
}

/**
 * The last `count` messages, both sides, in page order. With no reply or user
 * elements found at all it answers the page's own words instead (`page`), so a
 * site that renamed its elements still reads as something.
 */
export function readScript(drive: ChatBotDrive, count: number): string {
  return `(() => {
    ${prelude(drive)}
    const users = all(D.user).map((el) => ({ el, role: 'user' }));
    const bots = all(D.reply).map((el) => ({ el, role: 'bot' }));
    // A reply selector can match inside a user message on some layouts, and
    // the other way round: an element inside another of the other side goes.
    const inside = (a, list) => list.some((b) => b.el !== a.el && b.el.contains(a.el));
    const both = users.filter((u) => !inside(u, bots)).concat(bots.filter((b) => !inside(b, users)));
    both.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (!both.length) {
      const main = document.querySelector('main') || document.body;
      return { messages: [], page: tidy(textOf(main)).slice(-6000) };
    }
    const messages = both.slice(-${Math.max(1, Math.floor(count))}).map((m) => ({ role: m.role, text: tidy(textOf(m.el)) }));
    return { messages, page: '' };
  })()`
}
