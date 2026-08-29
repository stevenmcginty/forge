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
    {"hello": "<token>"}            when started with --auth-token / the
                                     FORGE_STT_AUTH_TOKEN env var: the FIRST
                                     line every client must send. Anything
                                     else — or silence past the window — gets
                                     the connection closed before it has seen
                                     a single phrase or landed a single
                                     command. Without a token (a dev run by
                                     hand) there is no handshake at all.
    {"cmd": "start"}                 begin listening
    {"cmd": "start", "autoStop": 10}  ...and set the silence timeout for it
    {"cmd": "start", "mode": "wake"}  ...always-listening instead (see below)
    {"cmd": "start", "conversation": true}
                                     ...a conversation, not dictation: wait out
                                     thinking pauses instead of cutting at 1 s
    {"cmd": "capture"}               wake mode: start capturing now, no wake word
    {"cmd": "release"}               wake mode: flush the phrase, keep monitoring
    {"cmd": "stop"}                  stop listening, transcribe what is left
    {"cmd": "status"}                 re-send the current state
    {"cmd": "shutdown"}              exit cleanly

server -> client
    {"evt": "auth-ok"}                          handshake accepted (token mode only)
    {"evt": "auth-rejected"}                    wrong token; the socket then closes
    {"evt": "ready"}                            model loaded, start is allowed
    {"evt": "level", "rms": 0.42}               ~10/s while listening
    {"evt": "phrase", "text": "..."}            one chunked phrase
    {"evt": "wake", "score": 0.98}              "hey Jarvis" was heard
    {"evt": "state", "v": "idle|listening|finishing",
                     "mode": "phrase|wake", "capturing": true|false}
    {"evt": "error", "msg": "...", "kind": "..."}

------------------------------------------------------------------- wake mode

`{"cmd": "start", "mode": "wake"}` opens the microphone and leaves it open. The
session then alternates between two halves, both of them `v: "listening"`:

    capturing: false   monitoring — openWakeWord listens for "hey Jarvis" and
                       nothing else runs; Parakeet is not fed a single sample
    capturing: true    the wake word (or `{"cmd": "capture"}`) landed, and this
                       is ordinary phrase capture

The auto-stop silence timeout ends the *capture*, not the session: the mic stays
open and monitoring resumes, forever, until `{"cmd": "stop"}`. `capture` is the
follow-up window — after the agent has answered, the reply does not need to be
prefixed with the wake word again.

`error.kind` is what lets Forge tell "you have not got the model" (show a setup
card) apart from "the mic is busy" (transient):

    model-missing     the model directory has no usable model files in it
    model-load        onnx-asr refused to load the model
    audio             the microphone could not be opened
    wake-unavailable  openWakeWord is not installed, or its models could not be
                      fetched. Carries a `hint`. Dictation is untouched: the
                      session simply falls back to plain phrase capture.
    internal          anything else

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
import secrets
import sys
import threading
import time
import types
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
# Conversation mode (the agent, wake word or the re-armed tap-to-talk loop) is
# a different deal: Steve thinks mid-sentence, and a 1 s cut turns one request
# into three fragments the brain has to reassemble. Wait out the thinking
# pauses, so the whole utterance arrives whole.
AGENT_PAUSE_CUT_S = 3.0
SOFT_CUT_S = 0.55           # mid-speech dip that's enough to split at...
SOFT_CUT_AFTER_S = 7.0      # ...once the phrase is already this long
MIN_VOICED_BLOCKS = 2       # ~130 ms of speech before a phrase counts
MAX_PHRASE_S = 18           # force a cut on very long phrases
MIC_MAX_BOOST = 12.0        # software mic gain cap (~ +21 dB)

PARAKEET_NAME = "parakeet-tdt-0.6b-v2"

# Wake word — openWakeWord's pretrained "hey jarvis".
WAKE_WORD = "hey_jarvis"
WAKE_THRESHOLD = 0.5        # openWakeWord's own recommended operating point
WAKE_REARM = 0.3            # ...and it has to fall back under this before the
                            # next fire, so one "hey Jarvis" is one wake and not
                            # the eight consecutive blocks that score over 0.5

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

# How long a token-checking sidecar waits for the client's hello line before
# closing the connection.
AUTH_WINDOW_S = 5.0

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

    def __init__(self, out_queue: "queue.Queue", device=None, conversation: bool = False):
        self.out = out_queue
        self.device = device
        self.stream = None
        self.level = 0.0            # smoothed 0..1, drives the pill's meter
        self.last_voice_time = 0.0
        # Conversation mode waits out thinking pauses and never splits on a
        # breath; dictation keeps the snappy cuts that make push-to-talk feel
        # like pushing and talking.
        self.pause_cut_s = AGENT_PAUSE_CUT_S if conversation else PAUSE_CUT_S
        self.soft_cut_s = None if conversation else SOFT_CUT_S
        self.soft_cut_after_s = SOFT_CUT_AFTER_S
        # Wake mode's two hooks. `monitor` sees every raw block whatever the
        # state; `capturing` is what says whether the block is also being
        # collected into a phrase. Plain dictation never touches either.
        self.monitor = None
        self.capturing = True
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

    def set_capturing(self, on: bool) -> None:
        """Wake mode: flip between monitoring and collecting phrases.

        Turning capture off flushes whatever was being said, exactly as stop()
        would; turning it on starts from an empty buffer, so the wake word
        itself never reaches the engine.
        """
        if on == self.capturing:
            return
        if not on and self._voiced_blocks >= MIN_VOICED_BLOCKS:
            self._emit()
        self._pending = []
        self._voiced_blocks = 0
        self._recent_voiced.clear()
        self.last_voice_time = time.time()
        self.capturing = on

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

        # The wake detector wants the raw block, not the boosted one, and it
        # wants it in both halves of wake mode: fed continuously, its score for
        # the last "hey Jarvis" has decayed away again by the time the capture
        # it triggered is over.
        if self.monitor is not None:
            self.monitor(block)

        if not self.capturing:
            # Idle-monitoring. The floor and the meter above are the whole job:
            # collecting blocks nobody is going to transcribe would only grow a
            # buffer, and letting the AGC adapt to a room nobody is dictating
            # into would wind the gain onto whatever the television is doing.
            return

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

        if self._voiced_blocks >= MIN_VOICED_BLOCKS and silent_for > self.pause_cut_s:
            # A real pause: the phrase already carries its trailing silence and
            # the next one keeps everything from here on, so nothing can be
            # clipped at this kind of cut.
            self._emit()
        elif self._voiced_blocks >= MIN_VOICED_BLOCKS and (
            (
                self.soft_cut_s is not None
                and pending_s > self.soft_cut_after_s
                and silent_for > self.soft_cut_s
            )
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

    def __init__(self, out_queue, path: str, realtime: bool = True, conversation: bool = False):
        super().__init__(out_queue, conversation=conversation)
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
# Wake word — openWakeWord's pretrained "hey jarvis".
# --------------------------------------------------------------------------


#: openWakeWord's package __init__ imports its custom-verifier trainer, which
#: imports scikit-learn, which imports SciPy. We use none of the three — and
#: loading SciPy here does not merely cost 40 MB of RSS, it *hangs*: on Windows,
#: pulling in scipy.linalg's OpenBLAS DLL while another thread sits blocked in a
#: read on stdin deadlocks, and this process always has such a thread
#: (watch_stdin, the parent-death watchdog). Reproduced on Python 3.14 /
#: SciPy 1.18 / Windows 11; the import never returns, on any thread.
_WAKE_STUBBED_IMPORTS = (
    "scipy",
    "sklearn",
    "sklearn.linear_model",
    "sklearn.pipeline",
    "sklearn.preprocessing",
)


class _AnythingModule(types.ModuleType):
    """A module that answers every attribute with a fresh empty class, which is
    all `from sklearn.pipeline import make_pipeline` actually needs."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return type(name, (), {})


def _import_wake_model():
    """openWakeWord's Model class, imported without its scientific stack.

    The stubs are removed again afterwards, so nothing else in the process ever
    sees them: openwakeword's own module body has already bound the names it
    wanted by then, and it only wanted them for the trainer.
    """
    added = [n for n in _WAKE_STUBBED_IMPORTS if n not in sys.modules]
    for name in added:
        sys.modules[name] = _AnythingModule(name)
    try:
        from openwakeword.model import Model

        return Model
    finally:
        for name in added:
            sys.modules.pop(name, None)


class WakeDetector:
    """Listens for "hey Jarvis" in the blocks the recorder is already producing.

    Three ONNX graphs — melspectrogram, Google's speech embedding, and the wake
    model itself — costing about 2% of one core at 16 kHz, which is what makes
    leaving the microphone open all day affordable. They run on their own thread
    rather than in the sounddevice callback: a callback that overruns its 64 ms
    drops microphone blocks, and dropped blocks are dropped words.

    Optional by design. If openwakeword is not installed, or its models cannot
    be fetched, `error` is set and the caller falls back to plain dictation.
    """

    def __init__(self, models_dir: str, on_wake):
        self.models_dir = models_dir
        self.on_wake = on_wake
        self.model = None
        self.error: str | None = None
        self.hint: str | None = None
        self.armed = True
        self.q: "queue.Queue" = queue.Queue()
        self._thread: threading.Thread | None = None
        self._stopping = False

    @property
    def ready(self) -> bool:
        return self.model is not None

    # -- loading -----------------------------------------------------------

    def _model_paths(self) -> dict:
        """The three ONNX files, downloaded on first use if they are not here.

        openWakeWord's own downloader wants a directory rather than a file list,
        and drops the tflite copies in beside the ONNX ones; the ONNX ones are
        what we load, because tflite-runtime has no Windows wheel.
        """
        want = {
            "wake": f"{WAKE_WORD}_v0.1.onnx",
            "melspec": "melspectrogram.onnx",
            "embedding": "embedding_model.onnx",
        }
        paths = {k: os.path.join(self.models_dir, v) for k, v in want.items()}
        if not all(os.path.isfile(p) for p in paths.values()):
            from openwakeword.utils import download_models

            os.makedirs(self.models_dir, exist_ok=True)
            log(f"fetching wake models into {self.models_dir}")
            download_models([WAKE_WORD], target_directory=self.models_dir)
        missing = [os.path.basename(p) for p in paths.values() if not os.path.isfile(p)]
        if missing:
            raise RuntimeError("missing after download: " + ", ".join(missing))
        return paths

    def load(self) -> None:
        """Blocking; the caller runs it on a thread because the first call may
        have ~7 MB to download."""
        try:
            Model = _import_wake_model()
        except Exception as e:                      # noqa: BLE001
            log(f"openwakeword unavailable: {e}")
            # Not always literally "not installed" — a broken install imports
            # just as badly — but that is the case worth naming, and the reason
            # why is on stderr either way.
            self.error = "openWakeWord is not available, so the wake word cannot be heard"
            self.hint = "pip install openwakeword"
            return
        try:
            t0 = time.time()
            paths = self._model_paths()
            self.model = Model(
                wakeword_models=[paths["wake"]],
                inference_framework="onnx",
                melspec_model_path=paths["melspec"],
                embedding_model_path=paths["embedding"],
            )
            log(f"wake model ready in {time.time() - t0:.1f}s")
        except Exception as e:                      # noqa: BLE001
            log(f"wake model failed: {e}")
            self.error = f"The wake-word model could not be loaded: {e}"
            self.hint = f"Delete {self.models_dir} and try again while online"
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    # -- scoring -----------------------------------------------------------

    def feed(self, block: np.ndarray) -> None:
        """One raw 64 ms float32 block, from whichever thread owns the mic."""
        if self.model is None:
            return
        if self.q.qsize() > 32:
            return          # a late wake beats a stalled microphone
        self.q.put(block)

    def drain(self) -> None:
        """Forget anything left over from a previous session, the way the audio
        queue is drained: half a wake word heard as the mic was released must not
        fire the instant it is opened again."""
        while not self.q.empty():
            try:
                self.q.get_nowait()
            except queue.Empty:
                break

    def _loop(self) -> None:
        while not self._stopping:
            try:
                block = self.q.get(timeout=0.25)
            except queue.Empty:
                continue
            if block is None:
                return
            try:
                pcm = np.clip(block * 32767.0, -32768, 32767).astype(np.int16)
                scores = self.model.predict(pcm)
            except Exception as e:                  # noqa: BLE001
                log(f"wake scoring failed: {e}")
                continue
            score = max(scores.values()) if scores else 0.0
            if score >= WAKE_THRESHOLD:
                if self.armed:
                    self.armed = False
                    self.on_wake(float(score))
            elif score < WAKE_REARM:
                self.armed = True

    def close(self) -> None:
        self._stopping = True
        self.q.put(None)


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
PHRASE_MODE, WAKE_MODE = "phrase", "wake"


class SttService:
    def __init__(self, engine: ParakeetEngine, opts):
        self.engine = engine
        self.opts = opts
        # Set only when somebody asked for it — --auth-token, or the
        # FORGE_STT_AUTH_TOKEN env var Forge passes its child. Without a token
        # the socket behaves exactly as it always has, so a dev run by hand
        # needs no ceremony (and no token to guess).
        self.auth_token = (
            getattr(opts, "auth_token", None)
            or os.environ.get("FORGE_STT_AUTH_TOKEN")
            or ""
        ).strip() or None
        self.loop = None
        self.clients: set = set()
        self.state = IDLE
        self.mode = PHRASE_MODE
        self.wake = WakeDetector(opts.wake_dir, self._on_wake)
        self._wake_loading = False
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

    @property
    def capturing(self) -> bool:
        """Whether audio is on its way to Parakeet right now. Always true while
        a plain dictation session is listening; in wake mode, only between the
        wake word and the auto-stop that follows it."""
        rec = self.recorder
        return self.state == LISTENING and rec is not None and rec.capturing

    def _state_msg(self, state: str, **extra) -> dict:
        return {
            "evt": "state",
            "v": state,
            "mode": self.mode,
            "capturing": self.capturing,
            **extra,
        }

    def set_state(self, state: str, **extra) -> None:
        self.state = state
        self.send(self._state_msg(state, **extra))

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
        # Warm the ONNX session so the first real phrase is not the slow one.
        # DictationMic does the same with 0.5 s of silence. Whatever it
        # hallucinates is discarded — this is not a phrase.
        try:
            self.engine.transcribe(np.zeros(SAMPLE_RATE // 2, np.float32))
            log("engine warmed")
        except Exception as e:                      # noqa: BLE001
            log(f"engine warm-up skipped: {e}")
        self.ready = True
        log(f"model ready in {time.time() - t0:.1f}s")
        self.send_threadsafe({"evt": "ready"})

    # -- listening ---------------------------------------------------------

    def start_listening(
        self,
        auto_stop: float | None = None,
        mode: str = PHRASE_MODE,
        conversation: bool = False,
    ) -> None:
        if auto_stop is not None:
            # Forge sends the current silence timeout with every start, so
            # changing it in Settings takes effect without a respawn.
            self.opts.auto_stop = auto_stop
        self.opts.conversation = conversation
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

        self.mode = WAKE_MODE if mode == WAKE_MODE else PHRASE_MODE
        if self.opts.fake_mic:
            rec: LiveRecorder = WavRecorder(
                self.audio_q, self.opts.fake_mic, conversation=self.opts.conversation
            )
        else:
            rec = LiveRecorder(
                self.audio_q, device=self.opts.device, conversation=self.opts.conversation
            )
        if self.mode == WAKE_MODE:
            # Open the mic already monitoring: nothing is collected, and nothing
            # is transcribed, until "hey Jarvis" turns up.
            rec.capturing = False
            self.wake.drain()
            rec.monitor = self.wake.feed
        self.recorder = rec
        try:
            rec.start()
        except Exception as e:                      # noqa: BLE001
            self.recorder = None
            self.mode = PHRASE_MODE
            log(f"microphone failed: {e}")
            self.send({"evt": "error", "msg": str(e), "kind": "audio"})
            self.set_state(IDLE)
            return

        self.session_start = time.time()
        self._ensure_worker()
        if self.mode == WAKE_MODE:
            self._ensure_wake()
        self.set_state(LISTENING)

    def stop_listening(self, reason: str | None = None) -> None:
        if self.state != LISTENING or self.recorder is None:
            return
        rec, self.recorder = self.recorder, None
        rec.monitor = None
        self.mode = PHRASE_MODE
        extra = {"reason": reason} if reason else {}
        self.set_state(FINISHING, **extra)
        # rec.stop() flushes the tail phrase and queues the ("end", None) that
        # returns us to idle once the worker has drained everything.
        threading.Thread(target=rec.stop, daemon=True).start()

    # -- wake mode ---------------------------------------------------------

    def begin_capture(self) -> None:
        """Start collecting a phrase inside an open wake-mode session — what the
        wake word does, and what `{"cmd": "capture"}` does without one."""
        rec = self.recorder
        if self.mode != WAKE_MODE or self.state != LISTENING or rec is None:
            log("capture ignored: not monitoring for the wake word")
            return
        # The silence timeout counts from here, not from the start of the
        # session, or a long quiet monitor would auto-stop the capture instantly.
        self.session_start = time.time()
        if rec.capturing:
            return
        rec.set_capturing(True)
        self.set_state(LISTENING)

    def end_capture(self) -> None:
        """Wake mode's auto-stop: flush the phrase, keep the microphone, go back
        to waiting for the wake word."""
        rec = self.recorder
        if rec is None or not rec.capturing:
            return
        rec.set_capturing(False)
        self.session_start = time.time()
        self.set_state(LISTENING)

    def _on_wake(self, score: float) -> None:
        """Called on the wake detector's thread."""
        self.loop_call(lambda: self._wake_fired(score))

    def _wake_fired(self, score: float) -> None:
        if self.mode != WAKE_MODE or self.state != LISTENING:
            return
        if self.capturing:
            return          # already taking this one down
        log(f"wake word heard ({score:.2f})")
        self.send({"evt": "wake", "score": round(float(score), 3)})
        self.begin_capture()

    def _ensure_wake(self) -> None:
        """Load the wake model on first use, off the event loop: the very first
        call may have models to download."""
        if self.wake.ready or self._wake_loading:
            return
        if self.wake.error:
            self._wake_unavailable()
            return
        self._wake_loading = True
        threading.Thread(target=self._load_wake, daemon=True).start()

    def _load_wake(self) -> None:
        self.wake.load()
        self._wake_loading = False
        if self.wake.error:
            self.loop_call(self._wake_unavailable)

    def _wake_unavailable(self) -> None:
        """No ear for the wake word. Say so — with something the user can act on
        — and let the session carry on as plain dictation, so whoever is talking
        right now still gets transcribed."""
        self.send(
            {
                "evt": "error",
                "kind": "wake-unavailable",
                "msg": self.wake.error or "The wake word is unavailable",
                "hint": self.wake.hint or "",
            }
        )
        if self.mode != WAKE_MODE or self.state != LISTENING:
            return
        self.mode = PHRASE_MODE
        rec = self.recorder
        if rec is not None:
            rec.monitor = None
            rec.set_capturing(True)
        self.session_start = time.time()
        self.set_state(LISTENING)

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
            # Monitoring for the wake word is silence by definition — the
            # timeout only ever ends a capture.
            if limit and limit > 0 and rec.capturing:
                quiet = time.time() - max(rec.last_voice_time, self.session_start)
                if quiet > limit:
                    log(f"auto-stop after {quiet:.1f}s of silence")
                    if self.mode == WAKE_MODE:
                        self.end_capture()
                    else:
                        self.stop_listening(reason="autostop")

    # -- clients -----------------------------------------------------------

    async def _authenticate(self, reader, writer) -> bool:
        """The token handshake, run before the socket joins `clients` — an
        unproven connection must never see a phrase or land a command.

        The client's FIRST line must be {"hello": "<token>"}. A wrong token,
        a malformed line, or nothing at all inside AUTH_WINDOW_S gets the
        connection closed; only the wrong-token case is told why, so the
        parent can tell a refusal apart from a sidecar that predates the
        handshake (and so answers the hello with `unknown command None`
        instead of either auth event).
        """
        peer = writer.get_extra_info("peername")
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=AUTH_WINDOW_S)
        except (asyncio.TimeoutError, TimeoutError):
            log(f"client {peer}: no auth line within {AUTH_WINDOW_S:.0f}s — closing")
            return False
        if not line.strip():
            log(f"client {peer}: hung up before authenticating")
            return False
        try:
            msg = json.loads(line)
        except ValueError:
            log(f"client {peer}: auth line was not JSON — closing")
            return False
        got = msg.get("hello") if isinstance(msg, dict) else None
        if not isinstance(got, str) or not secrets.compare_digest(
            got.encode("utf-8"), self.auth_token.encode("utf-8")
        ):
            log(f"client {peer}: bad auth token — closing")
            try:
                writer.write((json.dumps({"evt": "auth-rejected"}) + "\n").encode("utf-8"))
                await writer.drain()
            except Exception:
                pass
            return False
        try:
            writer.write((json.dumps({"evt": "auth-ok"}) + "\n").encode("utf-8"))
            await writer.drain()
        except Exception:
            return False
        return True

    async def handle(self, reader, writer) -> None:
        peer = writer.get_extra_info("peername")
        if self.auth_token and not await self._authenticate(reader, writer):
            try:
                writer.close()
            except Exception:
                pass
            return
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
        self.send(self._state_msg(self.state))
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
                float(raw) if isinstance(raw, (int, float)) and raw >= 0 else None,
                mode=str(msg.get("mode") or PHRASE_MODE),
                conversation=msg.get("conversation") is True,
            )
        elif cmd == "capture":
            self.begin_capture()
        elif cmd == "release":
            self.end_capture()
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
        self.wake.close()
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
        if self.auth_token:
            log("token auth required: every client must open with the hello line")

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


def default_wake_dir() -> str:
    """Where the openWakeWord models live — Forge's own data directory, beside
    the Parakeet download it normally sits next to. Unlike Parakeet these are a
    few megabytes and are fetched on first use, so there is nothing to configure
    and no borrowing from DictationMic to do."""
    env = os.environ.get("FORGE_STT_WAKE_DIR")
    if env:
        return env
    return os.path.join(_forge_data_dir(), "models", "openwakeword")


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
    p.add_argument(
        "--wake-dir",
        default=default_wake_dir(),
        help="where the wake-word models are cached (downloaded on first use)",
    )
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=0, help="0 = let the OS pick")
    p.add_argument(
        "--auth-token",
        default=None,
        help="require clients to open with this token (default: FORGE_STT_AUTH_TOKEN env; "
        "unset = no handshake, plain dev behaviour)",
    )
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
