# LTC Generator

SMPTE LTC timecode generator in the browser. Plain HTML/CSS/JS + Web Audio API.

Live: https://misakart.github.io/LTC-Generator/

- 23.976 / 24 / 25 / 29.97 DF / 29.97 NDF / 30 fps
- Start time, Play / Stop / Reset (Space = play/stop, R = reset)
- User bits: hex or date (SMPTE 309M)
- 25 µs rise time (SMPTE) or hard square edges
- Output level (dBFS), output device select (Chromium)
- Export WAV (44.1 / 48 / 96 kHz, 16-bit mono)

Local: serve folder over http (ES modules + AudioWorklet need it). Self-test: `test.html`.
