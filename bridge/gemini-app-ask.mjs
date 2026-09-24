#!/usr/bin/env node
// gemini-app-ask.mjs — talk to the logged-in Gemini Windows app (subscription, no API quota).
// Usage:
//   node gemini-app-ask.mjs "question"                    -> prints text answer
//   node gemini-app-ask.mjs "question" C:\path\file.png   -> attaches file(s), prints text answer
//   Ask for an image ("create an image of ...")           -> saves image(s), prints saved paths
// Recipe notes: fresh chat -> focus input -> execCommand insertText -> click Send button.
// (Input.insertText and Enter keypress do NOT submit on this page. Do not "fix" them back in.)
import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const PORT = 9223;
const EXE = 'C:\\Users\\steve\\AppData\\Local\\Google\\Gemini\\Gemini.exe';
const OUT_DIR = process.env.FORGE_BRIDGE_OUT || 'C:\\Users\\steve\\AppData\\Roaming\\Forge\\bridge-out';
const question = process.argv[2];
const files = process.argv.slice(3).filter(f => f && !f.startsWith('-'));
if (!question) { console.error('usage: node gemini-app-ask.mjs "question" [file1 file2 ...]'); process.exit(1); }

async function portOpen() {
  try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json(); return true; }
  catch { return false; }
}

if (!(await portOpen())) {
  try { execSync('powershell -NoProfile -Command "Get-Process Gemini -ErrorAction SilentlyContinue | Stop-Process -Force"'); } catch {}
  await sleep(2000);
  spawn(EXE, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await portOpen()) break; }
}
if (!(await portOpen())) { console.error('FAIL: could not start Gemini app with debug port'); process.exit(1); }

async function getTab() {
  for (let i = 0; i < 15; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find(x => x.url.startsWith('https://gemini.google.com/'));
    if (t) return t;
    await sleep(1500);
  }
  return null;
}

const target = await getTab();
if (!target) { console.error('FAIL: no gemini.google.com tab found'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0;
const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJS = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
};

// fresh chat (a stuck/generating chat blocks new sends)
await evalJS(`location.href='https://gemini.google.com/app'; 'nav'`);
await sleep(6000);

// attach files: real clipboard + real Ctrl+V (synthetic paste events are ignored by the app)
if (files.length) {
  for (const f of files) {
    const lower = f.toLowerCase();
    if (/\.(png|jpg|jpeg|gif|bmp|webp)$/.test(lower)) {
      execSync(`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Drawing.Image]::FromFile('${f.replace(/'/g, "''")}'); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()"`);
    } else {
      execSync(`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $c=New-Object System.Collections.Specialized.StringCollection; $c.Add('${f.replace(/'/g, "''")}'); [System.Windows.Forms.Clipboard]::SetFileDropList($c)"`);
    }
    // focus the app window and paste for real
    execSync(`powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W {[DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr h);[DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr h,int n);[DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware();}'; [W]::SetProcessDPIAware()|Out-Null; Add-Type -AssemblyName System.Windows.Forms; $p=Get-Process Gemini -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object -First 1; [W]::ShowWindow($p.MainWindowHandle,9)|Out-Null; [W]::SetForegroundWindow($p.MainWindowHandle)|Out-Null; Start-Sleep 1; [System.Windows.Forms.SendKeys]::SendWait('^v')"`);
    await sleep(6000); // let the upload preview settle
  }
}

// type the question with the working recipe, send, and watch for the answer
const payload = await evalJS(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const inp = document.querySelector('div[aria-label="Enter a prompt for Gemini"]');
  if (!inp) return JSON.stringify({ fail: 'no input box' });
  inp.focus();
  document.execCommand('selectAll');
  document.execCommand('delete');
  document.execCommand('insertText', false, ${JSON.stringify(question)});
  await sleep(500);
  const btn = [...document.querySelectorAll('button')].find(b => /send message/i.test(b.getAttribute('aria-label') || ''));
  if (!btn) return JSON.stringify({ fail: 'no send button' });
  btn.click();
  // wait until the last "Gemini said" block stops growing AND images (if any) have loaded
  let lastText = '', lastImgs = 0, stable = 0;
  for (let i = 0; i < 200; i++) {
    await sleep(1500);
    const body = document.body.innerText;
    const idx = body.lastIndexOf('Gemini said');
    if (idx < 0) continue;
    let t = body.slice(idx + 11).replace(/^\\s+/, '').split('Flash')[0].trim();
    const imgEls = [...document.querySelectorAll('img')]
      .filter(i => (i.src.startsWith('blob:') || /AI generated/i.test(i.alt || '')) && i.width >= 100);
    const done = (t === lastText) && imgEls.length === lastImgs && (t.length > 0 || imgEls.length > 0);
    if (done) {
      stable++;
      if (stable >= 5) {
        const dataUrls = imgEls.map(i => {
          try {
            const c = document.createElement('canvas');
            c.width = i.naturalWidth; c.height = i.naturalHeight;
            c.getContext('2d').drawImage(i, 0, 0);
            return c.toDataURL('image/png');
          } catch (e) { return null; }
        }).filter(Boolean);
        return JSON.stringify({ text: t, dataUrls });
      }
    }
    else { stable = 0; lastText = t; lastImgs = imgEls.length; }
  }
  return JSON.stringify({ fail: 'timed out', text: lastText });
})()`);

let result;
try { result = JSON.parse(payload); } catch { result = { text: payload }; }

if (result.fail) { console.error('FAIL: ' + result.fail + (result.text ? ' | partial: ' + result.text : '')); process.exit(1); }

// save any generated images (already base64 PNG data URLs from the page)
const saved = [];
for (const du of result.dataUrls || []) {
  try {
    const stamp = Date.now() + '-' + randomBytes(3).toString('hex');
    const path = join(OUT_DIR, 'gemini-' + stamp + '.png');
    writeFileSync(path, Buffer.from(du.split(',')[1], 'base64'));
    saved.push(path);
  } catch (e) { console.error('WARN: could not save image: ' + e.message); }
}

if (saved.length) console.log('IMAGES_SAVED: ' + saved.join(' | '));
if (result.text) console.log(result.text);
if (!saved.length && !result.text) { console.error('FAIL: empty answer'); process.exit(1); }
ws.close();
process.exit(0);
