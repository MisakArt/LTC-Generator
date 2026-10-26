// SMPTE LTC encoder. 80 bits per frame, biphase mark code, LSB first.

export const SYNC_WORD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

export function framesPerDay(fps) {
  return fps * 86400;
}

export function toFrames({ h, m, s, f }, fps) {
  return ((h * 60 + m) * 60 + s) * fps + f;
}

export function fromFrames(n, fps) {
  n = ((n % framesPerDay(fps)) + framesPerDay(fps)) % framesPerDay(fps);
  const f = n % fps;
  const t = Math.floor(n / fps);
  return { h: Math.floor(t / 3600), m: Math.floor(t / 60) % 60, s: t % 60, f };
}

const pad = (v) => String(v).padStart(2, "0");

export function formatTc(tc) {
  return `${pad(tc.h)}:${pad(tc.m)}:${pad(tc.s)}:${pad(tc.f)}`;
}

// "HH:MM:SS:FF" (also accepts ; . or space). Returns null if invalid.
export function parseTc(str, fps) {
  const p = String(str).trim().split(/[:;. ]/).map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isInteger(v) || v < 0)) return null;
  const [h, m, s, f] = p;
  if (h > 23 || m > 59 || s > 59 || f >= fps) return null;
  return { h, m, s, f };
}

function put(bits, start, len, value) {
  for (let i = 0; i < len; i++) bits[start + i] = (value >> i) & 1;
}

export function frameBits(tc, fps) {
  const b = new Uint8Array(80);
  put(b, 0, 4, tc.f % 10);
  put(b, 8, 2, Math.floor(tc.f / 10));
  put(b, 16, 4, tc.s % 10);
  put(b, 24, 3, Math.floor(tc.s / 10));
  put(b, 32, 4, tc.m % 10);
  put(b, 40, 3, Math.floor(tc.m / 10));
  put(b, 48, 4, tc.h % 10);
  put(b, 56, 2, Math.floor(tc.h / 10));
  for (let i = 0; i < 16; i++) b[64 + i] = SYNC_WORD[i];
  // Polarity correction: make count of ones even so every frame starts same phase.
  const pc = fps === 25 ? 59 : 27;
  let ones = 0;
  for (let i = 0; i < 80; i++) ones += b[i];
  b[pc] = ones & 1;
  return b;
}

// Streams biphase-mark LTC samples. Works at any sample rate (fractional bit lengths).
export class LtcGenerator {
  constructor(fps, sampleRate, startFrame = 0) {
    this.fps = fps;
    this.step = (fps * 80) / sampleRate; // bits per sample
    this.frame = startFrame;
    this.bits = frameBits(fromFrames(startFrame, fps), fps);
    this.pos = 0; // position in bits within current frame
    this.level = 1;
    this.bit = -1;
    this.half = 0;
    this.onFrame = null;
  }

  // Fill out with samples in [-amp, amp]. Returns nothing; calls onFrame(frame) at each frame start.
  fill(out, amp = 1) {
    for (let i = 0; i < out.length; i++) {
      const bit = Math.floor(this.pos);
      const half = this.pos - bit >= 0.5 ? 1 : 0;
      if (bit !== this.bit) {
        if (bit === 0 && this.onFrame) this.onFrame(this.frame);
        this.level = -this.level; // transition at every bit start
        this.bit = bit;
        this.half = 0;
      }
      if (half && !this.half) {
        if (this.bits[bit]) this.level = -this.level; // extra transition mid-bit for 1
        this.half = 1;
      }
      out[i] = this.level * amp;
      this.pos += this.step;
      if (this.pos >= 80) {
        this.pos -= 80;
        this.bit = -1;
        this.frame = (this.frame + 1) % framesPerDay(this.fps);
        this.bits = frameBits(fromFrames(this.frame, this.fps), this.fps);
      }
    }
  }
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

// Render LTC to a 16-bit mono WAV Blob.
export function renderWav({ fps, startFrame, seconds, db, sampleRate = 48000 }) {
  const n = Math.round(seconds * sampleRate);
  const samples = new Float32Array(n);
  new LtcGenerator(fps, sampleRate, startFrame).fill(samples, dbToGain(db));
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(samples[i] * 32767), true);
  return new Blob([buf], { type: "audio/wav" });
}
