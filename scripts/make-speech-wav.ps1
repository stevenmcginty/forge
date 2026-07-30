# Generates the speech fixture the dictation smoke test feeds through the
# sidecar's --fake-mic, using the Windows speech synthesiser. Real words, at the
# 16 kHz mono the engine wants, so `node scripts/stt-smoke.mjs --real` can prove
# transcription end to end on a machine with no microphone.
#
#   powershell -NoProfile -File scripts/make-speech-wav.ps1

$ErrorActionPreference = 'Stop'

$dir = Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$out = Join-Path $dir 'speech.wav'

Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($out, $fmt)

# Two sentences with a real pause between them, so the recorder's phrase
# chunking has to cut in the right place and the test sees two phrases.
$prompt = New-Object System.Speech.Synthesis.PromptBuilder
$prompt.AppendText("Forge dictation is working on this machine.")
$prompt.AppendBreak([System.Speech.Synthesis.PromptBreak]::Large)
$prompt.AppendText("Run the build and show me the terminal output.")
$synth.Speak($prompt)

$synth.SetOutputToNull()
$synth.Dispose()

$size = (Get-Item $out).Length
Write-Output ("wrote {0} ({1:N0} bytes, {2:N1}s)" -f $out, $size, ($size / 32000))
