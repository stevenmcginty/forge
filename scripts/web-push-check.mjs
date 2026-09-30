/**
 * Head-less proof that the desktop's push decisions are the ones it claims.
 *
 * Bundles the *real* electron/web/push.ts with esbuild and drives its three
 * pure decisions — `shouldPush` (the per-pane flap guard), `pickTargets` (which
 * devices buzz) and `deliver` (one send plus its one retry). No network, no
 * push service, no VAPID keys: the clock is a number passed in, and the sender
 * is a function that fails the way the real one did in the desktop's log.
 *
 *   npm run web:push
 *
 * The thing each check guards is a way the phone stayed silent: the same
 * question asked twice never buzzing, a desktop browser tab silencing the phone
 * in a pocket, a reset connection losing the notification outright.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = join(ROOT, "node_modules", ".forge-web-push");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

// push.ts imports the store; point it at the scratch folder so nothing here can
// ever touch Steve's real profile, even though the pure functions never read it.
process.env["FORGE_DATA_DIR"] = join(scratch, "data");

let failures = 0;
let passes = 0;
const log = (ok, message) => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
};

/** A sender that plays back a script of failures, then succeeds. Counts its calls. */
function scripted(...failuresInOrder) {
  const sender = async () => {
    sender.calls++;
    const next = failuresInOrder.shift();
    if (next) throw next;
  };
  sender.calls = 0;
  return sender;
}

/** An error shaped like web-push's WebPushError: a message and the service's status. */
function httpError(statusCode) {
  const err = new Error(`Received unexpected response code`);
  err.statusCode = statusCode;
  return err;
}

/** A network failure as Node raises it: an Error with a code and no status. */
function netError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

async function main() {
  await build({
    entryPoints: [join(ROOT, "electron", "web", "push.ts")],
    outfile: join(scratch, "web-push.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: { "@shared": join(ROOT, "shared") },
    // CommonJS with node built-ins; loaded from node_modules at run time rather
    // than bundled into an ES module that cannot `require`.
    external: ["web-push"],
    logLevel: "silent",
    absWorkingDir: ROOT,
  });

  const { shouldPush, pickTargets, deliver, PUSH_THROTTLE_MS, PUSH_RETRY_MS } =
    await import(pathToFileURL(join(scratch, "web-push.mjs")).href);

  /* ------------------------------------------------------------ shouldPush */

  const t0 = 1_000_000;
  log(
    PUSH_THROTTLE_MS === 30_000,
    `the flap guard is 30 s (${PUSH_THROTTLE_MS} ms)`,
  );
  log(
    shouldPush(undefined, "asking", t0) === true,
    "a pane's first question pushes",
  );
  log(
    shouldPush({ at: t0, state: "asking" }, "asking", t0 + 31_000) === true,
    "the same question again after 31 s pushes (it used to be suppressed forever)",
  );
  log(
    shouldPush({ at: t0, state: "asking" }, "asking", t0 + 10_000) === false,
    "the same question again after 10 s does not (flap guard)",
  );
  log(
    shouldPush({ at: t0, state: "done" }, "asking", t0 + 10_000) === true,
    'a question 10 s after a "done" pushes (a new question outranks a finished note)',
  );
  log(
    shouldPush({ at: t0, state: "asking" }, "done", t0 + 10_000) === false,
    'a "done" 10 s after a question does not',
  );
  log(
    shouldPush({ at: t0, state: "done" }, "done", t0 + 10_000) === false,
    'a second "done" within 10 s does not',
  );
  log(
    shouldPush({ at: t0, state: "done" }, "done", t0 + PUSH_THROTTLE_MS) ===
      true,
    "exactly PUSH_THROTTLE_MS later, anything pushes again",
  );

  /* ----------------------------------------------------------- pickTargets */

  const phone = { endpoint: "https://fcm.example/phone", deviceId: "phone-1" };
  const deskTab = { endpoint: "https://fcm.example/desk", deviceId: "desk-1" };
  const legacy = { endpoint: "https://fcm.example/old", deviceId: "" };
  const subs = [phone, deskTab, legacy];

  {
    const { targets, onScreen } = pickTargets(subs, {
      visibleDevices: new Set(["desk-1"]),
      anyVisible: true,
    });
    log(
      targets.includes(phone) && !targets.includes(deskTab),
      "a desktop tab showing Forge Web is skipped, the phone in a pocket still buzzes",
    );
    log(
      !targets.includes(legacy),
      "a subscription with no deviceId is skipped while any browser is on screen",
    );
    log(
      onScreen === 2,
      `on-screen count covers both skipped subscriptions (${onScreen})`,
    );
  }
  {
    const { targets, onScreen } = pickTargets(subs, {
      visibleDevices: new Set(),
      anyVisible: false,
    });
    log(
      targets.length === 3 && onScreen === 0,
      "with nothing on screen every subscription is targeted, legacy included",
    );
  }
  {
    const { targets } = pickTargets(subs, {
      visibleDevices: new Set(["phone-1", "desk-1"]),
      anyVisible: true,
    });
    log(targets.length === 0, "with every device on screen nobody is buzzed");
  }
  {
    // A browser with no push subscription can be on screen; that makes
    // `anyVisible` true without naming any subscribed device.
    const { targets } = pickTargets(subs, {
      visibleDevices: new Set(["laptop-9"]),
      anyVisible: true,
    });
    log(
      targets.includes(phone) &&
        targets.includes(deskTab) &&
        !targets.includes(legacy),
      "an unsubscribed browser on screen silences only the legacy subscription",
    );
  }

  /* --------------------------------------------------------------- deliver */

  const waits = [];
  const noWait = async (ms) => {
    waits.push(ms);
  };

  {
    const send = scripted(netError("read ECONNRESET", "ECONNRESET"));
    const outcome = await deliver(send, noWait);
    log(
      outcome.kind === "sent" &&
        send.calls === 2 &&
        waits.at(-1) === PUSH_RETRY_MS,
      `one ECONNRESET then success is sent, on the retry (${outcome.kind}, ${send.calls} calls, waited ${waits.at(-1)} ms)`,
    );
  }
  {
    const send = scripted(
      netError(
        "Client network socket disconnected before secure TLS connection was established",
        "ECONNRESET",
      ),
      netError("socket hang up", "ECONNRESET"),
    );
    const outcome = await deliver(send, noWait);
    log(
      outcome.kind === "failed" && send.calls === 2,
      `two network failures in a row fail after exactly one retry (${send.calls} calls)`,
    );
  }
  {
    const send = scripted(httpError(410));
    const outcome = await deliver(send, noWait);
    log(
      outcome.kind === "dead" && send.calls === 1,
      `410 is dead at once, no retry (${outcome.kind}, ${send.calls} call)`,
    );
  }
  {
    const send = scripted(httpError(404));
    const outcome = await deliver(send, noWait);
    log(
      outcome.kind === "dead" && send.calls === 1,
      "404 is dead at once, no retry",
    );
  }
  {
    const send = scripted(httpError(503));
    const outcome = await deliver(send, noWait);
    log(
      outcome.kind === "sent" && send.calls === 2,
      "503 then success is sent on the retry",
    );
  }
  {
    const send = scripted(httpError(429));
    const outcome = await deliver(send, noWait);
    log(
      outcome.kind === "sent" && send.calls === 2,
      "429 then success is sent on the retry",
    );
  }
  {
    const send = scripted(httpError(400));
    const outcome = await deliver(send, noWait);
    log(
      outcome.kind === "failed" && send.calls === 1,
      "400 fails without a retry (a refusal a retry would repeat)",
    );
  }
  {
    const send = scripted();
    const before = waits.length;
    const outcome = await deliver(send, noWait);
    log(
      outcome.kind === "sent" && send.calls === 1 && waits.length === before,
      "a clean send is sent once, with no wait",
    );
  }
  {
    let threw = false;
    try {
      const outcome = await deliver(async () => {
        throw "not even an Error";
      }, noWait);
      log(
        outcome.kind === "failed",
        "a thrown non-Error is a failure, not an exception",
      );
    } catch {
      threw = true;
    }
    if (threw) log(false, "deliver threw");
  }
}

main()
  .catch((err) => {
    failures++;
    console.error(`\nFAIL  ${err?.stack ?? err}`);
  })
  .finally(() => {
    rmSync(scratch, { recursive: true, force: true });
    console.log(
      failures === 0
        ? `\nweb:push — all ${passes} checks passed`
        : `\nweb:push — ${failures} FAILED, ${passes} passed`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
