/**
 * Head-less proof that Remote Yes's logic behaves.
 *
 * Bundles the *real* electron/remote-yes.ts with esbuild and drives it the way
 * electron/remote-yes-host.ts does — except tasklist is a scripted fake and the
 * clock is injected, because this check's job is the parsing and the transition
 * rules, and there is no honest way for a script to raise a UAC prompt and then
 * assert what a phone three hundred miles away saw.
 *
 * What a script can honestly claim, it claims:
 *
 *   - the Tailscale address parser, including that IPv6 noise and an empty
 *     tailnet both degrade to '' (the one state setup refuses to run in)
 *   - the consent.exe detector, against a real tasklist row, against the
 *     "INFO: No tasks" line Windows prints when nothing is up, and against junk
 *   - picking the x86_64 installer out of a GitHub release, and refusing when
 *     no such asset is published
 *   - the password's length and alphabet — the look-alike characters are out,
 *     because this is read off a screen and typed into a phone
 *   - that the elevated script carries every option pair from the contract, the
 *     password, the service restart and the read-back, and that the password
 *     only ever appears inside a single-quoted PowerShell literal (a
 *     double-quoted one would expand `$`, and the password is generated)
 *   - the watcher's transition semantics: one rise, silence while it stays up,
 *     one fall — and that an exec that throws does not stop the loop
 *
 * What it cannot claim: that RustDesk accepts these options, that the service
 * reaches the secure desktop, or that a phone can press Yes. That needs the
 * machine, the tailnet and a person — and is the half only Steve can run.
 *
 *   npm run remote-yes:check
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-remote-yes-check')
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** A stand-in password. Deliberately shaped like a generated one. */
const PASSWORD = "Kq7mXt2wVzR4nHb9'Ds"

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'remote-yes-entry.ts')],
    outfile: join(scratch, 'remote-yes.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const {
    buildSetupScript,
    firstOptionMismatch,
    generatePassword,
    parseLatestRelease,
    parseSetupResult,
    parseTailscaleIp,
    parseTasklistConsent,
    redactPassword,
    UacWatcher,
    PASSWORD_LENGTH,
    REMOTE_YES_PORT,
    RUSTDESK_OPTIONS,
    RUSTDESK_SERVICE,
    UAC_POLL_MS
  } = await import(pathToFileURL(join(scratch, 'remote-yes.mjs')).href)

  /* ------------------------------------------------- 1. the tailnet address */

  log(parseTailscaleIp('100.82.234.123\n') === '100.82.234.123', 'a tailnet IPv4 is read off the first line')
  log(parseTailscaleIp('  100.64.0.1  \r\n') === '100.64.0.1', 'surrounding whitespace and CRLF do not matter')
  log(parseTailscaleIp('') === '', 'empty output is no address, not a crash')
  log(parseTailscaleIp('\n\n  \n') === '', 'blank lines are no address')
  log(parseTailscaleIp('fd7a:115c:a1e0::1\n') === '', 'an IPv6 tailnet address is not offered as an IPv4 one')
  log(
    parseTailscaleIp('fd7a:115c:a1e0::1\n100.82.234.123\n') === '100.82.234.123',
    'the IPv4 line is found past IPv6 noise'
  )
  log(parseTailscaleIp('192.168.1.40\n') === '', 'a LAN address is not a tailnet address')
  log(parseTailscaleIp('100.128.0.1\n') === '', 'just outside 100.64.0.0/10 is outside it')
  log(
    parseTailscaleIp('failed to connect to local tailscaled\n') === '',
    "tailscale's own error sentence is not mistaken for an address"
  )

  /* ------------------------------------------------ 2. is a UAC prompt up? */

  const TASKLIST_UP = '"consent.exe","10996","Console","1","12,345 K"\r\n'
  const TASKLIST_DOWN = 'INFO: No tasks are running which match the specified criteria.\r\n'
  log(parseTasklistConsent(TASKLIST_UP) === true, 'a consent.exe row means a prompt is on screen')
  log(parseTasklistConsent(TASKLIST_DOWN) === false, "Windows's \"No tasks are running\" line means no prompt")
  log(parseTasklistConsent('') === false, 'no output is no prompt')
  log(parseTasklistConsent('��\u0000garbage,,,\n') === false, 'garbage is no prompt, never a false alarm')
  log(
    parseTasklistConsent('"notconsent.exe","1","Console","1","1 K"\r\n') === false,
    'a process whose name merely contains consent.exe does not count'
  )
  log(
    parseTasklistConsent('ERROR: The search filter cannot be recognized.\n') === false,
    'a tasklist error is no prompt'
  )

  /* -------------------------------------------- 3. picking the installer */

  const release = (assets) => JSON.stringify({ tag_name: '1.4.9', assets })
  const good = parseLatestRelease(
    release([
      { name: 'rustdesk-1.4.9-x86_64.msi', browser_download_url: 'https://github.com/x/a.msi', size: 20 },
      { name: 'rustdesk-1.4.9-aarch64.exe', browser_download_url: 'https://github.com/x/b.exe', size: 30 },
      { name: 'rustdesk-1.4.9-x86_64.exe', browser_download_url: 'https://github.com/x/c.exe', size: 24_000_000 },
      { name: 'rustdesk-1.4.9-x86_64.deb', browser_download_url: 'https://github.com/x/d.deb', size: 40 }
    ])
  )
  log(good?.url === 'https://github.com/x/c.exe', 'the x86_64 .exe asset is the one picked')
  log(good?.size === 24_000_000, 'its published size comes back with it')
  log(good?.version === '1.4.9', 'the tag is carried as the version')
  log(parseLatestRelease(JSON.stringify({ tag_name: 'v1.4.9', assets: [] })) === null, 'a release with no assets is refused')
  log(
    parseLatestRelease(release([{ name: 'rustdesk-1.4.9-aarch64.exe', browser_download_url: 'https://g/b.exe', size: 1 }])) ===
      null,
    'a release with no x86_64 exe is refused rather than half-matched'
  )
  log(
    parseLatestRelease(release([{ name: 'rustdesk-1.4.9-x86_64.exe', browser_download_url: 'http://g/c.exe', size: 1 }])) ===
      null,
    'a plain-http download URL is refused'
  )
  log(parseLatestRelease('<html>rate limited</html>') === null, 'an HTML error page is not a release')
  log(parseLatestRelease('') === null, 'empty is not a release')

  /* ------------------------------------------------------ 4. the password */

  const pw = generatePassword()
  log(pw.length === PASSWORD_LENGTH && PASSWORD_LENGTH === 20, `a generated password is ${PASSWORD_LENGTH} characters`)
  const alphabet = /^[a-km-zA-HJ-NP-Z2-9]+$/
  let allInAlphabet = true
  const seen = new Set()
  for (let i = 0; i < 400; i++) {
    const candidate = generatePassword()
    if (candidate.length !== PASSWORD_LENGTH || !alphabet.test(candidate)) allInAlphabet = false
    seen.add(candidate)
  }
  log(allInAlphabet, 'every character is in [a-k m-z A-H J-N P-Z 2-9] — no l, I, O, 0 or 1 to misread')
  log(seen.size === 400, '400 passwords in a row are 400 different passwords')

  /* ------------------------------- 5. the one elevated script, read closely */

  const script = buildSetupScript({
    installerPath: 'C:\\Users\\steve\\AppData\\Roaming\\Forge\\bin\\rustdesk-setup.exe',
    password: PASSWORD,
    resultPath: 'C:\\Users\\steve\\AppData\\Roaming\\Forge\\bin\\remote-yes-result.json',
    alreadyInstalled: false
  })

  log(script.includes('--silent-install'), 'the script installs RustDesk silently')
  for (const [key, value] of RUSTDESK_OPTIONS) {
    log(script.includes(`'${key}' = '${value}'`), `it sets ${key} = ${value}`)
  }
  log(RUSTDESK_OPTIONS.length === 6, 'all six options from the contract are in the list, and no more')
  log(
    script.includes("'whitelist' = '100.64.0.0/10'"),
    'the whitelist is the tailnet range and has not been widened to a LAN'
  )
  log(script.includes(`--option $key $wanted[$key]`), 'options go through --option, not a config file it would ignore')
  log(script.includes('--password'), 'it sets the permanent password')
  log(script.includes(`Restart-Service -Name $svc -Force`), 'it restarts the service so the options take')
  log(script.includes(`$svc = '${RUSTDESK_SERVICE}'`), `the service it restarts is ${RUSTDESK_SERVICE}`)
  log(script.includes('--get-id'), 'it reads the RustDesk ID back')
  log(script.includes('$result.options[$key] = '), 'it reads every option back rather than assuming it took')
  log(script.includes(`-Port ${REMOTE_YES_PORT}`), `it proves port ${REMOTE_YES_PORT} is listening`)
  log(script.includes('TcpTestSucceeded'), 'and does it with a real TCP test')
  log(
    script.includes('remote-yes-result.json') && script.includes('ConvertTo-Json'),
    'it writes its verdict to the result path as JSON'
  )
  log(script.includes('Set-Content -LiteralPath $resultPath'), 'the verdict is written whatever happened, in or out of the catch')

  // The password is generated, so it can contain a quote. It must reach
  // PowerShell inside a single-quoted literal (which expands nothing) with the
  // quote doubled — never inside a double-quoted one, where `$` would expand.
  log(script.includes(`--password 'Kq7mXt2wVzR4nHb9''Ds'`), "the password is a single-quoted literal with '' doubling")
  log(!script.includes(`"${PASSWORD}"`), 'the raw password never appears inside a double-quoted PowerShell string')
  const doubleQuoted = script.match(/"[^"\n]*"/g) ?? []
  log(
    doubleQuoted.every((chunk) => !chunk.includes('Kq7mXt2wVzR4nHb9')),
    'no double-quoted string anywhere in the script contains the password'
  )
  log(
    script.split(PASSWORD.replace("'", "''")).length === 2,
    'the password is written exactly once'
  )

  const already = buildSetupScript({
    installerPath: '',
    password: PASSWORD,
    resultPath: 'C:\\r.json',
    alreadyInstalled: true
  })
  log(!already.includes('--silent-install'), 'an install that is already there is not installed again')
  log(already.includes('--option $key $wanted[$key]'), '…but the options are still re-applied, behind the same one prompt')

  /* --------------------------------------------- 6. reading the verdict back */

  const verdict = parseSetupResult(
    JSON.stringify({
      ok: true,
      id: '123456789',
      options: Object.fromEntries(RUSTDESK_OPTIONS.map(([k, v]) => [k, `${v}\r\n`])),
      listening: true,
      error: ''
    })
  )
  log(verdict?.ok === true && verdict.id === '123456789', 'a good verdict parses')
  log(firstOptionMismatch(verdict.options) === '', 'every option read back as asked')
  const bent = { ...verdict.options, whitelist: '0.0.0.0/0' }
  log(firstOptionMismatch(bent) === 'whitelist', 'a widened whitelist is named, not merely counted')
  log(firstOptionMismatch({}) === RUSTDESK_OPTIONS[0][0], 'a verdict with no options at all fails on the first key')
  log(parseSetupResult('\uFEFF{"ok":true,"id":"1","options":{},"listening":true,"error":""}')?.ok === true,
    'a UTF-8 byte-order mark from Windows PowerShell does not turn a good result into "no result"'
  )

  /* ------------------------------------------------------- 7. redaction */

  log(
    redactPassword(`rustdesk.exe --password ${PASSWORD} failed`, PASSWORD) ===
      'rustdesk.exe --password [password] failed',
    'the password is stripped out of anything on its way to a log line'
  )
  log(redactPassword('nothing to hide', '') === 'nothing to hide', 'an empty password redacts nothing')

  /* ---------------------------------------------- 8. the watcher's edges */

  // A scripted clock and a scripted tasklist: the check drives every tick by
  // hand, so the whole rise/stay/fall story runs in microseconds rather than in
  // the 1.5s-per-poll it costs on a real machine.
  const timers = new Map()
  let nextTimerId = 1
  const changes = []
  let answer = TASKLIST_DOWN
  let execCalls = 0
  let clock = 1_000
  const watcher = new UacWatcher({
    exec: async () => {
      execCalls++
      if (answer instanceof Error) throw answer
      return answer
    },
    onChange: (active) => changes.push(active),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimerId++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    }
  })

  /** Fire the one pending timer and let its async tick settle. */
  const tick = async () => {
    const entry = [...timers.entries()][0]
    if (!entry) throw new Error('the watcher stopped scheduling')
    timers.delete(entry[0])
    entry[1].fn()
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  }

  watcher.start()
  log(timers.size === 1 && [...timers.values()][0].ms === UAC_POLL_MS, `start() schedules a poll ${UAC_POLL_MS}ms out`)
  watcher.start()
  log(timers.size === 1, 'start() twice does not double the polling')

  await tick()
  log(changes.length === 0, 'no prompt, no event')

  answer = TASKLIST_UP
  clock = 5_000
  await tick()
  log(changes.length === 1 && changes[0] === true, 'the rise fires exactly one change')
  log(watcher.active === true, 'and the watcher says a prompt is up')
  log(watcher.lastRiseAt === 5_000, 'the rise is stamped off the injected clock')

  await tick()
  await tick()
  await tick()
  log(changes.length === 1, 'a prompt that stays up for three more polls fires nothing more')

  answer = TASKLIST_DOWN
  await tick()
  log(changes.length === 2 && changes[1] === false, 'the fall fires exactly one change')
  log(watcher.active === false, 'and the watcher says the prompt has gone')

  // One bad exec must not end the loop: tasklist can fail transiently, and a
  // watcher that quietly died would leave the feature on in Settings and dead
  // in fact.
  const before = execCalls
  answer = new Error('tasklist: the system cannot find the file specified')
  await tick()
  log(execCalls === before + 1, 'a throwing exec was still called')
  log(timers.size === 1, 'and the loop scheduled the next poll anyway')
  answer = TASKLIST_UP
  clock = 9_000
  await tick()
  log(changes.length === 3 && changes[2] === true, 'the next real rise is still reported after the failure')

  watcher.stop()
  log(timers.size === 0, 'stop() clears the pending timer')
  log(watcher.active === false, 'stop() forgets the prompt it was watching')
  const afterStop = execCalls
  watcher.stop()
  log(execCalls === afterStop && timers.size === 0, 'a stopped watcher schedules and runs nothing further')
}

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\nremote-yes:check — all checks passed' : `\nremote-yes:check — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
