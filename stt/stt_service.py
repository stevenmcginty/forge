#!/usr/bin/env python
"""
Forge speech-to-text sidecar — on-device dictation over a localhost socket.

Forge itself is Electron; the speech engine is NVIDIA's Parakeet TDT 0.6B
running under onnx-asr, which only exists as Python. So the engine lives in
this standalone process and Forge talks to it over a loopback socket.

The audio capture and phrase-chunking design is lifted from Steve's
DictationMic (`app.py`: LiveRecorder / ParakeetTranscriber) — the same adaptive
noise floor, mic AGC and "cut at a natural pause" rules, which are the reason
dictation there reads like sentences instead of fragments. It is *copied*
rather than imported: importing app.py would boot a whole Tkinter pill.

--------------------------------------------------------------------- protocol

Newline-delimited JSON, one object per line, over TCP on 127.0.0.1. The port is
chosen by the OS and announced on stdout as:

    FORGE_STT_PORT=<n>

(The `websockets` package is not installed in DictationMic's venv and we must
not install into it, so this is a raw line protocol. It carries the exact same
messages a WebSocket would.)

client -> server
    {"cmd": "start"}                 begin listening
    {"cmd": "start", "autoStop": 10}  ...and set the silence timeout for it
    {"cmd": "stop"}                  stop listening, transcribe what is left
    {"cmd": "status"}                 re-send the current state
    {"cmd": "shutdown"}              exit cleanly

server -> client
    {"evt": "ready"}                            model loaded, start is allowed
    {"evt": "level", "rms": 0.42}               ~10/s while listening
    {"evt": "phrase", "text": "..."}            one chunked phrase
    {"evt": "state", "v": "idle|listening|finishing"}
    {"evt": "error", "msg": "...", "kind": "..."}

`error.kind` is what lets Forge tell "you have not got the model" (show a setup
card) apart from "the mic is busy" (transient):

    model-missing   the model directory has no usable model files in it
    model-load      onnx-asr refused to load the model
    audio           the microphone could not be opened
    internal        anything else

Exit status 0 always means "asked to leave". Anything else is a crash and the
parent restarts us.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import queue
import re
import sys
import threading
import time
import wave
from collections import deque

import numpy as np

# --------------------------------------------------------------------------
# Capture tuning — DictationMic's numbers, arrived at by using the thing.
# --------------------------------------------------------------------------

SAMPLE_RATE = 16000
BLOCK = 1024                # 64 ms blocks
PAUSE_CUT_S = 1.0           # silence gap that ends a phrase: a real sentence
                            # pause, not a breath. Shorter gaps split sentences
                            # into fragments the engine punctuates as
                            # "Full. Stops."
SOFT_CUT_S = 0.55           # mid-speech dip that's enough to split at...
SOFT_CUT_AFTER_S = 7.0      # ...once the phrase is already this long
MIN_VOICED_BLOCKS = 2       # ~130 ms of speech before a phrase counts
MAX_PHRASE_S = 18           # force a cut on very long phrases
MIC_MAX_BOOST = 12.0        # software mic gain cap (~ +21 dB)

PARAKEET_NAME = "parakeet-tdt-0.6b-v2"

# file -> minimum plausible size, so a stray HTML error page or a half-finished
# download can never pass for a model
MODEL_FILES = {
    "config.json": 50,
    "vocab.txt": 5_000,
    "decoder_joint-model.int8.onnx": 5_000_000,
    "encoder-model.int8.onnx": 500_000_000,
}

LEVEL_HZ = 10.0
DEFAULT_AUTO_STOP_S = 10.0

# What the model hears in a chunk of breath.
BREATH_TEXT = {"you", "thank you", "thanks for watching", "bye", "uh", "um"}


def log(msg: str) -> None:
    """Diagnostics go to stderr; stdout is reserved for the port line."""
    print(f"[stt] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Capture — streams the mic and emits phrases at natural pauses.
# --------------------------------------------------------------------------


class LiveRecorder:
    """Streams the mic and puts ("audio", phrase) / ("end", None) on a queue."""

    def __init__(self, out_queue: "queue.Queue", device=None):
        self.out = out_queue
        self.device = device
        self.stream = None
        self.level = 0.0            # smoothed 0..1, drives the pill's meter
        self.last_voice_time = 0.0
        self._pending: list = []
        self._voiced_blocks = 0
        self._noise_floor = 0.004
        self._recent_voiced = deque(maxlen=2)
        self._gain = 1.0
        self._peaks = deque(maxlen=int(6 * SAMPLE_RATE / BLOCK))  # ~6 s

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        import sounddevice as sd

        self._reset()
        kwargs = dict(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=BLOCK,
            callback=self._callback,
        )
        if self.device is not None:
            kwargs["device"] = self.device
        self.stream = sd.InputStream(**kwargs)
        self.stream.start()

    def stop(self) -> None:
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        # Whatever was still being spoken when the key was pressed is a phrase.
        if self._voiced_blocks >= MIN_VOICED_BLOCKS:
            self._emit()
        self._pending = []
        self.out.put(("end", None))

    def _reset(self) -> None:
        self._pending = []
        self._voiced_blocks = 0
        self._recent_voiced.clear()
        self._peaks.clear()
        # _gain is deliberately NOT reset: the mic doesn't get louder between
        # sessions, and re-learning from 1.0 would swallow the first quiet
        # words of every dictation.
        self.level = 0.0
        self.last_voice_time = time.time()

    # -- the audio thread --------------------------------------------------

    def _callback(self, indata, frames, t, status) -> None:  # noqa: ARG002
        self.feed(indata[:, 0].copy())

    def feed(self, block: np.ndarray) -> None:
        """One 64 ms mono float32 block. Split out from the sounddevice
        callback so the WAV feeder used by the tests drives identical logic."""
        rms = float(np.sqrt(np.mean(block**2)))

        # Adaptive noise floor: falls fast, learns background noise slowly, and
        # barely moves during speech — otherwise long unbroken talking drags the
        # floor up until real words get classed as silence and thrown away.
        if rms < self._noise_floor:
            self._noise_floor = 0.8 * self._noise_floor + 0.2 * rms
        elif rms < self._noise_floor * 3.5:
            self._noise_floor = 0.995 * self._noise_floor + 0.005 * rms
        else:
            self._noise_floor = 0.9995 * self._noise_floor + 0.0005 * rms

        # The mic-boost gain divides the absolute floor: on a quiet mic, soft
        # speech would fall under a fixed gate and be thrown away as silence —
        # you'd have to shout. Noisy rooms are still handled by the 3.5x
        # relative gate, which compares raw signal to raw floor.
        threshold = max(0.008 / self._gain, self._noise_floor * 3.5)

        voiced = rms > threshold
        self._recent_voiced.append(voiced)
        now = time.time()
        if any(self._recent_voiced):
            self.last_voice_time = now

        self.level = 0.55 * self.level + 0.45 * min(
            1.0, (rms / max(threshold, 1e-4)) * 0.35
        )

        # Software mic boost for the engine's benefit: aim the loudest recent
        # audio at a healthy peak so quiet mics transcribe like loud ones.
        # Adapt ONLY while the window holds real signal — during silence the
        # gain HOLDS, so a thinking pause can't wind it to max and drop the
        # gate onto amplified room noise.
        raw_peak = float(np.max(np.abs(block))) if block.size else 0.0
        self._peaks.append(raw_peak)
        sig = [p for p in self._peaks if p > self._noise_floor * 6]
        if len(sig) >= 8:
            loud = sorted(sig)[int(len(sig) * 0.9)]
            want = min(MIC_MAX_BOOST, max(1.0, 0.40 / max(loud, 1e-5)))
            self._gain += 0.1 * (want - self._gain)
        if raw_peak * self._gain > 0.98:        # never clip — duck instantly
            self._gain = 0.98 / max(raw_peak, 1e-5)

        self._pending.append(block * self._gain)
        if voiced:
            self._voiced_blocks += 1

        pending_s = len(self._pending) * BLOCK / SAMPLE_RATE
        silent_for = now - self.last_voice_time

        if self._voiced_blocks >= MIN_VOICED_BLOCKS and silent_for > PAUSE_CUT_S:
            # A real pause: the phrase already carries ~1 s of trailing silence
            # and the next one keeps everything from here on, so nothing can be
            # clipped at this kind of cut.
            self._emit()
        elif self._voiced_blocks >= MIN_VOICED_BLOCKS and (
            (pending_s > SOFT_CUT_AFTER_S and silent_for > SOFT_CUT_S)
            or pending_s > MAX_PHRASE_S
        ):
            # Forced cut during (near-)continuous speech: never slice at "now"
            # — that lands mid-word and the engine drops both halves.
            self._emit_at_quietest()
        elif self._voiced_blocks == 0 and pending_s > 3.0:
            self._pending = self._pending[-4:]   # only silence piling up

    # -- cutting -----------------------------------------------------------

    def _emit(self) -> None:
        if not self._pending:
            return
        audio = np.concatenate(self._pending)
        self._pending = []
        self._voiced_blocks = 0
        self.out.put(("audio", audio))

    def _emit_at_quietest(self) -> None:
        """Cut at the quietest instant of the last ~1.5 s instead of right now;
        the blocks after that instant seed the next phrase, so no audio is lost
        and none is duplicated."""
        tail = min(len(self._pending) - 1, int(1.5 * SAMPLE_RATE / BLOCK))
        if tail < 3:
            self._emit()
            return
        start = len(self._pending) - tail
        rms = [float(np.sqrt(np.mean(b**2))) for b in self._pending[start:]]
        cut = start + int(np.argmin(rms)) + 1
        carry = self._pending[cut:]
        self._pending = self._pending[:cut]
        self._emit()
        self._pending = carry
        # Carried blocks are gain-boosted; the floor tracks the raw signal.
        threshold = max(0.008, self._noise_floor * 3.5 * self._gain)
        self._voiced_blocks = sum(
            1 for b in carry if float(np.sqrt(np.mean(b**2))) > threshold
        )


class WavRecorder(LiveRecorder):
    """A LiveRecorder fed from a WAV file at wall-clock speed instead of a mic.

    Exists so the sidecar can be proved end to end — model load, chunking,
    transcription, auto-stop — on a machine (or in an agent session) with no
    microphone access. Enabled with --fake-mic.
    """

    def __init__(self, out_queue, path: str, realtime: bool = True):
        super().__init__(out_queue)
        self.path = path
        self.realtime = realtime
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        self._reset()
        self._stop.clear()
        samples = self._read()
        self._thread = threading.Thread(
            target=self._pump, args=(samples,), daemon=True
        )
        self._thread.start()

    def _read(self) -> np.ndarray:
        with wave.open(self.path, "rb") as w:
            if w.getsampwidth() != 2:
                raise ValueError("fake mic wants 16-bit PCM WAV")
            raw = w.readframes(w.getnframes())
            rate = w.getframerate()
            chans = w.getnchannels()
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if chans > 1:
            data = data.reshape(-1, chans).mean(axis=1)
        if rate != SAMPLE_RATE:                      # crude but adequate
            n = int(len(data) * SAMPLE_RATE / rate)
            data = np.interp(
                np.linspace(0, len(data) - 1, n), np.arange(len(data)), data
            ).astype(np.float32)
        return data

    def _pump(self, samples: np.ndarray) -> None:
        period = BLOCK / SAMPLE_RATE
        next_at = time.time()
        for i in range(0, len(samples), BLOCK):
            if self._stop.is_set():
                return
            block = samples[i : i + BLOCK]
            if len(block) < BLOCK:
                block = np.pad(block, (0, BLOCK - len(block)))
            self.feed(np.ascontiguousarray(block, dtype=np.float32))
            next_at += period
            if self.realtime:
                delay = next_at - time.time()
                if delay > 0:
                    time.sleep(delay)
        # Then feed silence, so the pause-cut and auto-stop paths run exactly as
        # they do with a real mic that has gone quiet.
        quiet = np.zeros(BLOCK, dtype=np.float32)
        while not self._stop.is_set():
            self.feed(quiet)
            next_at += period
            if self.realtime:
                delay = next_at - time.time()
                if delay > 0:
                    time.sleep(delay)

    def stop(self) -> None:
        self._stop.set()
        t, self._thread = self._thread, None
        if t is not None:
            t.join(timeout=1.0)
        if self._voiced_blocks >= MIN_VOICED_BLOCKS:
            self._emit()
        self._pending = []
        self.out.put(("end", None))


# --------------------------------------------------------------------------
# Engine — Parakeet TDT 0.6B via onnx-asr.
# --------------------------------------------------------------------------


class ParakeetEngine:
    """load() / transcribe(). Mirrors DictationMic's ParakeetTranscriber,
    including the ONNX Runtime thread settings that keep the rest of the
    machine responsive while a phrase is being decoded."""

    # The ONNX export runs full attention, so a very long take in one piece
    # would eat RAM for no accuracy win — cut at the quietest instant.
    CHUNK_S = 60

    def __init__(self, model_dir: str):
        self.model_dir = model_dir
        self.model = None
        self.error: str | None = None
        self.error_kind: str | None = None

    def check_files(self) -> str | None:
        """Return a human-readable complaint, or None if the model looks real."""
        if not self.model_dir:
            return "No model directory configured"
        if not os.path.isdir(self.model_dir):
            return f"Model folder not found: {self.model_dir}"
        missing = []
        for name, min_size in MODEL_FILES.items():
            p = os.path.join(self.model_dir, name)
            try:
                if os.path.getsize(p) < min_size:
                    missing.append(f"{name} (truncated)")
            except OSError:
                missing.append(name)
        if missing:
            return "Model files missing or incomplete: " + ", ".join(missing)
        return None

    def load(self) -> None:
        complaint = self.check_files()
        if complaint:
            self.error, self.error_kind = complaint, "model-missing"
            return
        try:
            import onnx_asr
            import onnxruntime as ort

            so = ort.SessionOptions()
            # Only half the cores: transcription must not starve Forge's UI or
            # the terminals it is running agents in.
            so.intra_op_num_threads = min(6, max(2, (os.cpu_count() or 8) // 2))
            so.inter_op_num_threads = 1
            # ORT worker threads busy-spin between ops by default. With a phrase
            # every few seconds that pegs the cores continuously; sleeping costs
            # microseconds at this much realtime headroom.
            so.add_session_config_entry("session.intra_op.allow_spinning", "0")
            so.add_session_config_entry("session.inter_op.allow_spinning", "0")
            self.model = onnx_asr.load_model(
                "nemo-" + PARAKEET_NAME,
                self.model_dir,
                quantization="int8",
                sess_options=so,
            )
        except Exception as e:                      # noqa: BLE001
            self.error, self.error_kind = str(e), "model-load"

    def _pieces(self, audio: np.ndarray):
        max_n = self.CHUNK_S * SAMPLE_RATE
        while len(audio) > max_n:
            win = audio[max_n - 10 * SAMPLE_RATE : max_n]
            cut = max_n - 10 * SAMPLE_RATE + int(np.argmin(np.abs(win)))
            yield audio[:cut]
            audio = audio[cut:]
        yield audio

    def transcribe(self, audio: np.ndarray) -> str:
        if self.model is None:
            return ""
        parts = []
        for piece in self._pieces(np.ascontiguousarray(audio, dtype=np.float32)):
            parts.append((self.model.recognize(piece) or "").strip())
        text = " ".join(p for p in parts if p)
        text = re.sub(r"\.{2,}|…", "", text)
        text = re.sub(r"\s{2,}", " ", text).strip()
        if text.lower().strip(" .,!?") in BREATH_TEXT:
            return ""
        return text


class StubEngine(ParakeetEngine):
    """Skips the 660 MB model load and echoes the length of what it heard.
    --stub-engine, for exercising the protocol in a second rather than a minute.
    """

    def load(self) -> None:
        self.model = "stub"

    def transcribe(self, audio: np.ndarray) -> str:
        return f"stub phrase of {len(audio) / SAMPLE_RATE:.1f} seconds"


# --------------------------------------------------------------------------
# Service
# --------------------------------------------------------------------------

IDLE, LISTENING, FINISHING = "idle", "listening", "finishing"


class SttService:
    def __init__(self, engine: ParakeetEngine, opts):
        self.engine = engine
        self.opts = opts
        self.loop = None
        self.clients: set = set()
        self.state = IDLE
        self.ready = False
        self.audio_q: "queue.Queue" = queue.Queue()
        self.recorder: LiveRecorder | None = None
        self.session_start = 0.0
        self._worker: threading.Thread | None = None
        self._stopping = False
        self._shutdown: asyncio.Event | None = None

    # -- wire --------------------------------------------------------------

    def send(self, obj: dict) -> None:
        """Broadcast one message. Safe to call from the asyncio thread only."""
        line = (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")
        for w in list(self.clients):
            try:
                w.write(line)
            except Exception:
                self.clients.discard(w)

    def send_threadsafe(self, obj: dict) -> None:
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self.send, obj)

    def set_state(self, state: str, **extra) -> None:
        self.state = state
        self.send({"evt": "state", "v": state, **extra})

    # -- model -------------------------------------------------------------

    def load_engine(self) -> None:
        """Blocking; runs on a worker thread so the socket is accepting
        connections while the 660 MB encoder is being mapped in."""
        t0 = time.time()
        self.engine.load()
        if self.engine.error:
            log(f"engine failed ({self.engine.error_kind}): {self.engine.error}")
            self.send_threadsafe(
                {
                    "evt": "error",
                    "msg": self.engine.error,
                    "kind": self.engine.error_kind or "internal",
                }
            )
            return
        self.ready = True
        log(f"model ready in {time.time() - t0:.1f}s")
        self.send_threadsafe({"evt": "ready"})

    # -- listening ---------------------------------------------------------

    def start_listening(self, auto_stop: float | None = None) -> None:
        if auto_stop is not None:
            # Forge sends the current silence timeout with every start, so
            # changing it in Settings takes effect without a respawn.
            self.opts.auto_stop = auto_stop
        if self.state == LISTENING:
            return
        if not self.ready:
            self.send(
                {
                    "evt": "error",
                    "msg": self.engine.error or "The speech model is still loading",
                    "kind": self.engine.error_kind or "not-ready",
                }
            )
            return
        # A phrase from a previous session must not leak into this one.
        while not self.audio_q.empty():
            try:
                self.audio_q.get_nowait()
            except queue.Empty:
                break

        if self.opts.fake_mic:
            self.recorder = WavRecorder(self.audio_q, self.opts.fake_mic)
        else:
            self.recorder = LiveRecorder(self.audio_q, device=self.opts.device)
        try:
            self.recorder.start()
        except Exception as e:                      # noqa: BLE001
            self.recorder = None
            log(f"microphone failed: {e}")
            self.send({"evt": "error", "msg": str(e), "kind": "audio"})
            self.set_state(IDLE)
            return

        self.session_start = time.time()
        self._ensure_worker()
        self.set_state(LISTENING)

    def stop_listening(self, reason: str | None = None) -> None:
        if self.state != LISTENING or self.recorder is None:
            return
        rec, self.recorder = self.recorder, None
        extra = {"reason": reason} if reason else {}
        self.set_state(FINISHING, **extra)
        # rec.stop() flushes the tail phrase and queues the ("end", None) that
        # returns us to idle once the worker has drained everything.
        threading.Thread(target=rec.stop, daemon=True).start()

    def _ensure_worker(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._transcribe_loop, daemon=True)
        self._worker.start()

    def _transcribe_loop(self) -> None:
        while not self._stopping:
            try:
                kind, payload = self.audio_q.get(timeout=0.25)
            except queue.Empty:
                continue
            if kind == "quit":
                return
            if kind == "end":
                self.loop_call(self._maybe_idle)
                continue
            try:
                text = self.engine.transcribe(payload)
            except Exception as e:                  # noqa: BLE001
                log(f"transcribe failed: {e}")
                self.send_threadsafe(
                    {"evt": "error", "msg": str(e), "kind": "internal"}
                )
                continue
            if text:
                self.send_threadsafe({"evt": "phrase", "text": text})

    def loop_call(self, fn) -> None:
        if self.loop is not None:
            self.loop.call_soon_threadsafe(fn)

    def _maybe_idle(self) -> None:
        if self.state == FINISHING:
            self.set_state(IDLE)

    # -- ticker ------------------------------------------------------------

    async def ticker(self) -> None:
        """Level events while listening, plus the silence auto-stop."""
        period = 1.0 / LEVEL_HZ
        while True:
            await asyncio.sleep(period)
            rec = self.recorder
            if self.state != LISTENING or rec is None:
                continue
            self.send({"evt": "level", "rms": round(float(rec.level), 3)})
            limit = self.opts.auto_stop
            if limit and limit > 0:
                quiet = time.time() - max(rec.last_voice_time, self.session_start)
                if quiet > limit:
                    log(f"auto-stop after {quiet:.1f}s of silence")
                    self.stop_listening(reason="autostop")

    # -- clients -----------------------------------------------------------

    async def handle(self, reader, writer) -> None:
        peer = writer.get_extra_info("peername")
        self.clients.add(writer)
        log(f"client {peer} connected")
        self.greet()
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    self.send(
                        {"evt": "error", "msg": "malformed JSON", "kind": "internal"}
                    )
                    continue
                self.dispatch(msg if isinstance(msg, dict) else {})
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            self.clients.discard(writer)
            log(f"client {peer} gone")
            try:
                writer.close()
            except Exception:
                pass

    def greet(self) -> None:
        """Tell a fresh client where things stand, so a reconnect after a
        renderer reload doesn't leave the pill guessing."""
        self.send({"evt": "state", "v": self.state})
        if self.ready:
            self.send({"evt": "ready"})
        elif self.engine.error:
            self.send(
                {
                    "evt": "error",
                    "msg": self.engine.error,
                    "kind": self.engine.error_kind or "internal",
                }
            )

    def dispatch(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "start":
            raw = msg.get("autoStop")
            self.start_listening(
                float(raw) if isinstance(raw, (int, float)) and raw >= 0 else None
            )
        elif cmd == "stop":
            self.stop_listening()
        elif cmd == "status":
            self.greet()
        elif cmd == "shutdown":
            self.quit()
        else:
            self.send(
                {"evt": "error", "msg": f"unknown command {cmd!r}", "kind": "internal"}
            )

    def quit(self) -> None:
        self._stopping = True
        if self.recorder is not None:
            rec, self.recorder = self.recorder, None
            try:
                rec.stop()
            except Exception:
                pass
        self.audio_q.put(("quit", None))
        if self._shutdown is not None:
            self._shutdown.set()

    # -- run ---------------------------------------------------------------

    async def serve(self) -> int:
        self.loop = asyncio.get_running_loop()
        self._shutdown = asyncio.Event()

        server = await asyncio.start_server(self.handle, self.opts.host, self.opts.port)
        port = server.sockets[0].getsockname()[1]
        # The one thing stdout is for: the parent parses this line.
        print(f"FORGE_STT_PORT={port}", flush=True)
        log(f"listening on {self.opts.host}:{port}")

        threading.Thread(target=self.load_engine, daemon=True).start()
        tick = asyncio.create_task(self.ticker())

        await self._shutdown.wait()

        # Deliberately NOT `async with server` / bare wait_closed(): since 3.12
        # wait_closed() also waits for every live connection handler, and ours
        # is parked in readline() on the very socket that asked us to quit — so
        # the shutdown command would hang the shutdown. Hang up on the clients
        # first, then give wait_closed a bounded chance.
        tick.cancel()
        for w in list(self.clients):
            try:
                w.close()
            except Exception:
                pass
        self.clients.clear()
        server.close()
        try:
            await asyncio.wait_for(server.wait_closed(), timeout=2.0)
        except (asyncio.TimeoutError, TimeoutError):
            log("wait_closed timed out — leaving anyway")
        log("bye")
        return 0


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def _forge_data_dir() -> str:
    """Forge's own data root, matching electron/store.ts resolveDataRoot()."""
    env = os.environ.get("FORGE_DATA_DIR")
    if env and env.strip():
        return os.path.abspath(env.strip())
    appdata = os.environ.get("APPDATA")
    if appdata:
        return os.path.join(appdata, "Forge")
    return os.path.join(os.path.expanduser("~"), ".forge")


def default_model_dir() -> str:
    """Where to look for Parakeet when nobody said.

    Forge normally passes --model-dir, so this only matters when the sidecar is
    run by hand. Order: an explicit env override, then Forge's own downloaded
    copy, then DictationMic's copy if this machine happens to have one, then
    nothing at all — which surfaces as a clean `model-missing` rather than a
    path that only exists on one person's laptop.
    """
    env = os.environ.get("FORGE_STT_MODEL_DIR")
    if env:
        return env
    candidates = [
        os.path.join(_forge_data_dir(), "models", PARAKEET_NAME),
        os.path.join(
            os.path.expanduser("~"), "Desktop", "DictationMic", "models", PARAKEET_NAME
        ),
    ]
    for path in candidates:
        if os.path.isdir(path):
            return path
    return ""


def import_check() -> int:
    """Prove the frozen build carries everything a real model load needs.

    A PyInstaller folder that is missing onnxruntime's DLLs builds perfectly
    happily — the failure only shows up the first time somebody dictates. So the
    build script runs `forge-stt.exe --import-check` and refuses to ship a binary
    that cannot answer.
    """
    missing = []
    for name in ("numpy", "onnxruntime", "onnx_asr", "sounddevice"):
        try:
            __import__(name)
        except Exception as e:  # noqa: BLE001
            missing.append(f"{name}: {e}")
    if missing:
        for m in missing:
            print(f"MISSING {m}", file=sys.stderr, flush=True)
        return 1
    import onnxruntime as ort

    print(
        f"imports OK (onnxruntime {ort.__version__}, "
        f"providers: {','.join(ort.get_available_providers())})",
        flush=True,
    )
    return 0


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Forge on-device dictation sidecar")
    p.add_argument("--model-dir", default=default_model_dir())
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=0, help="0 = let the OS pick")
    p.add_argument(
        "--auto-stop",
        type=float,
        default=float(os.environ.get("FORGE_STT_AUTO_STOP", DEFAULT_AUTO_STOP_S)),
        help="stop listening after this many seconds of silence (0 = never)",
    )
    p.add_argument("--device", default=None, help="sounddevice input device")
    p.add_argument(
        "--fake-mic",
        default=None,
        metavar="WAV",
        help="feed a 16-bit PCM WAV instead of the microphone (testing)",
    )
    p.add_argument(
        "--stub-engine",
        action="store_true",
        help="skip the model load and emit placeholder text (testing)",
    )
    p.add_argument(
        "--import-check",
        action="store_true",
        help="import every runtime dependency and exit (packaging check)",
    )
    return p.parse_args(argv)


def watch_stdin() -> None:
    """If the parent dies, its end of our stdin pipe closes. Leave with it —
    an orphaned sidecar would sit on the microphone forever."""
    try:
        while sys.stdin.readline():
            pass
    except Exception:
        pass
    log("stdin closed — parent is gone")
    os._exit(0)


def main(argv=None) -> int:
    import asyncio

    opts = parse_args(argv)
    if opts.import_check:
        return import_check()
    engine: ParakeetEngine = (
        StubEngine(opts.model_dir) if opts.stub_engine else ParakeetEngine(opts.model_dir)
    )
    service = SttService(engine, opts)

    if sys.stdin is not None and not sys.stdin.closed:
        threading.Thread(target=watch_stdin, daemon=True).start()

    try:
        return asyncio.run(service.serve())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
