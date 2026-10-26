# LTC Generator

Web app that generates SMPTE LTC (Linear Timecode) audio in the browser.
Plain HTML/CSS/JS, Web Audio API, no framework, no build step. Hosted on GitHub Pages
(repo `MisakArt/LTC-Generator`, branch `main`, root).

Reference sites for ideas:
- https://elteesee.pehrhovey.net/ltc
- https://ltc.fromstudiotostage.com/?tab=custom

## Files

- `index.html` – UI
- `style.css` – styles
- `ltc.js` – LTC encoder (ES module). `frameBits()` builds 80-bit frame, `LtcGenerator` renders biphase-mark samples. Shared by worklet and WAV export.
- `ltc-worklet.js` – AudioWorkletProcessor, imports `ltc.js`, streams live LTC.
- `app.js` – UI logic, playback, WAV export.
- `test.html` – encoder self-test in browser (decodes generated audio, checks timecode, sync word, parity).

## Notes

- ES modules + AudioWorklet need http(s). `file://` does not work. Run local static server.
- Bit layout per SMPTE 12M. Polarity-correction bit: bit 27 (24/30 fps), bit 59 (25 fps). Keeps ones-count even.
- Frame counter wraps at 24h.
- WAV export: 48 kHz, 16-bit mono.

## Status / Next steps

**Status (2026-10-26):** Version 1 done. 24/25/30 fps, start time, Play/Stop/Reset,
output level (dBFS), big display, WAV export. Encoder self-test passes in browser.
Pushed to main. GitHub Pages must be enabled by hand (Settings → Pages → main / root); no `gh` CLI here.

**Next steps (ideas):**
- 29.97 drop-frame and 23.976
- User bits / date field
- Rise-time shaping (SMPTE 25 µs) instead of hard square
- Sample rate choice for export (44.1/48/96 kHz)
- Output device select (`setSinkId`)
- Keyboard shortcuts (space = play/stop)
