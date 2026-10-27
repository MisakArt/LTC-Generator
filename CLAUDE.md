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
- Rates live in `RATES` (ltc.js): `fps` = timecode base (24/25/30), `rate` = real frames/s (x1000/1001 for 23.976, 29.97), `df` = drop frame. Frame counts are real frames; `toFrames`/`fromFrames` do DF conversion. DF day = 2589408 frames. DF flag = bit 10. DF shown with `;`.
- Strict SMPTE 12M frame: user bits (UB1..UB8), colour frame flag (bit 11) and binary group flags (BGF0/1/2) always 0. User bits feature removed 2026-10-26 on user request.
- Rise time: linear ramp, 25 µs 10–90 % default, placed at exact sub-sample edge time. `riseUs: 0` = hard square.
- Frame counter wraps at 24h.
- WAV export: 44.1/48/96 kHz, mono, 16/24-bit PCM or 32-bit float. Length unit select next to the field: Minutes (default, whole 1–240) or Seconds (whole, 1–14400; `MAX_MINUTES` in app.js); switching unit converts the value (rounds when going to minutes); file size (only below the bit-depth select, not in its options), end timecode, frames, samples/frame, LTC bit rate (80 x fps, only changes with frame rate) and WAV bit rate (sample rate x bit depth, mono) shown live.
- Output device select uses `AudioContext.setSinkId` (Chromium only; hidden elsewhere). Device names need mic permission ("Show device names" button).
- Shortcuts: Space = play/stop, R = reset (ignored while typing in a field).
- Local test: any static server on port 8123 (e.g. `npx http-server -p 8123 -c-1`), open `/test.html`. Browser-pane launch config is in parent folder `.claude/launch.json` (not in repo; points at a temp server script, recreate if gone).

## Status / Next steps

**Status (2026-10-26):** Version 2 done. Added 23.976 / 29.97 DF / 29.97 NDF, user bits (hex / 309M date),
25 µs rise-time shaping, export sample-rate choice, output device select, keyboard shortcuts.
Self-test (`test.html`) 63 checks pass in browser. Output device switching not tested on real hardware.

**Next steps (ideas):**
- Output channel select (LTC on L / R / both) so the other channel can carry audio
- Jam to time of day (start from current clock)
