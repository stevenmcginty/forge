# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Forge's dictation sidecar.

One *folder* build (not one-file): the encoder ONNX runtime is ~100 MB of DLLs
and a one-file build would unpack all of it into %TEMP% on every launch, which
is several seconds of disk churn every time somebody presses the dictation key.
The folder is shipped verbatim as an electron-builder extraResource.

Built with DictationMic's venv, which already has the exact wheel set the
sidecar was developed against:

    node scripts/build-stt.mjs
    # or by hand:
    ..\..\DictationMic\venv\Scripts\pyinstaller --noconfirm ^
      --distpath stt-dist --workpath .stt-build stt\forge-stt.spec

The collect-all list is stt_service.py's real import set, which is a *narrower*
set than DictationMic.spec's: no faster_whisper and no ctranslate2, because the
sidecar only ever runs Parakeet through onnx-asr.

  onnxruntime   — its DLLs and the capi package are loaded by path, not import
  onnx_asr      — resolves model classes by name at runtime
  sounddevice   — the PortAudio DLL lives in the separate _sounddevice_data pkg

console=True on purpose: the parent process reads `FORGE_STT_PORT=<n>` off our
stdout, and a windowed PyInstaller build has no usable stdout. Forge spawns us
with CREATE_NO_WINDOW (`windowsHide`), so no console ever appears.
"""
from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = []

for pkg in ('onnxruntime', 'onnx_asr', 'sounddevice', '_sounddevice_data'):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    ['stt_service.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Nothing here needs a GUI toolkit, a plotting library or a test runner.
    # Excluding them keeps the folder to what dictation actually loads.
    excludes=[
        'tkinter',
        'faster_whisper',
        'ctranslate2',
        'matplotlib',
        'PIL',
        'pytest',
        'IPython',
        'torch',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='forge-stt',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX is not on this machine and compressing 100 MB of ORT DLLs buys little
    # once the installer's own LZMA has had a go at them.
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='forge-stt',
)
