// SMPTE LTC encoder. 80 bits per frame, biphase mark code, LSB first.

export const SYNC_WORD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

// fps = timecode base (frames per label second), rate = real frames per second.
export const RATES = {
  "23.976": { id: "23.976", label: "23.976 fps", fps: 24, rate: 24000 / 1001, df: false },
  "24": { id: "24", label: "24 fps", fps: 24, rate: 24, df: false },
  "25": { id: "25", label: "25 fps", fps: 25, rate: 25, df: false },
  "29.97df": { id: "29.97df", label: "29.97 DF", fps: 30, rate: 30000 / 1001, df: true },
  "29.97": { id: "29.97", label: "29.97 NDF", fps: 30, rate: 30000 / 1001, df: false },
  "30": { id: "30", label: "30 fps", fps: 30, rate: 30, df: false },
};

// Drop frame: skip labels 00 and 01 every minute except minutes divisible by 10.
const DF_10MIN = 17982;
const DF_MIN = 1798;

export function framesPerDay(r) {
  return r.df ? 144 * DF_10MIN : r.fps * 86400;
}

export function toFrames({ h, m, s, f }, r) {
  const n = ((h * 60 + m) * 60 + s) * r.fps + f;
  if (!r.df) return n;
  const mins = h * 60 + m;
  return n - 2 * (mins - Math.floor(mins / 10));
}

export function fromFrames(n, r) {
  const day = framesPerDay(r);
  n = ((n % day) + day) % day;
  if (r.df) {
    const d = Math.floor(n / DF_10MIN);
    const m = n % DF_10MIN;
    n += 18 * d + (m > 1 ? 2 * Math.floor((m - 2) / DF_MIN) : 0);
  }
  const f = n % r.fps;
  const t = Math.floor(n / r.fps);
  return { h: Math.floor(t / 3600), m: Math.floor(t / 60) % 60, s: t % 60, f };
}

const pad = (v) => String(v).padStart(2, "0");

export function formatTc(tc, r) {
  return `${pad(tc.h)}:${pad(tc.m)}:${pad(tc.s)}${r?.df ? ";" : ":"}${pad(tc.f)}`;
}

// "HH:MM:SS:FF" (also accepts ; . or space). Returns null if invalid.
export function parseTc(str, r) {
  const p = String(str).trim().split(/[:;. ]/).map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isInteger(v) || v < 0)) return null;
  const [h, m, s, f] = p;
  if (h > 23 || m > 59 || s > 59 || f >= r.fps) return null;
  if (r.df && s === 0 && f < 2 && m % 10 !== 0) return null; // dropped label
  return { h, m, s, f };
}

function put(bits, start, len, value) {
  for (let i = 0; i < len; i++) bits[start + i] = (value >> i) & 1;
}

// SMPTE 12M frame. User bits, colour frame flag and binary group flags are all 0.
export function frameBits(tc, r) {
  const b = new Uint8Array(80);
  put(b, 0, 4, tc.f % 10);
  put(b, 8, 2, Math.floor(tc.f / 10));
  put(b, 16, 4, tc.s % 10);
  put(b, 24, 3, Math.floor(tc.s / 10));
  put(b, 32, 4, tc.m % 10);
  put(b, 40, 3, Math.floor(tc.m / 10));
  put(b, 48, 4, tc.h % 10);
  put(b, 56, 2, Math.floor(tc.h / 10));
  b[10] = r.df ? 1 : 0;
  for (let i = 0; i < 16; i++) b[64 + i] = SYNC_WORD[i];
  // Polarity correction: make count of ones even so every frame starts same phase.
  // 25 fps uses bit 59, 24/30 fps bit 27.
  const pc = r.fps === 25 ? 59 : 27;
  let ones = 0;
  for (let i = 0; i < 80; i++) ones += b[i];
  b[pc] = ones & 1;
  return b;
}

// SMPTE 12M rise time (10–90 %) is 25 ± 5 µs.
export const SMPTE_RISE_US = 25;

// Streams biphase-mark LTC samples. Works at any sample rate (fractional bit lengths).
// riseUs > 0 shapes edges as linear ramps placed at the exact (sub-sample) edge time.
export class LtcGenerator {
  constructor(r, sampleRate, startFrame = 0, { riseUs = 0 } = {}) {
    this.r = r;
    this.step = (r.rate * 80) / sampleRate; // bits per sample
    this.ramp = (riseUs / 0.8) * 1e-6 * sampleRate; // full-swing ramp length in samples
    this.frame = startFrame;
    this.bits = frameBits(fromFrames(startFrame, r), r);
    this.pos = 0; // position in bits within current frame
    this.level = 1;
    this.since = Infinity; // samples since last edge
    this.bit = -1;
    this.half = 0;
    this.onFrame = null;
  }

  // Fill out with samples in [-amp, amp]. Calls onFrame(frame) at each frame start.
  fill(out, amp = 1) {
    for (let i = 0; i < out.length; i++) {
      const bit = Math.floor(this.pos);
      const half = this.pos - bit >= 0.5 ? 1 : 0;
      if (bit !== this.bit) {
        if (bit === 0 && this.onFrame) this.onFrame(this.frame);
        this.level = -this.level; // transition at every bit start
        this.since = (this.pos - bit) / this.step;
        this.bit = bit;
        this.half = 0;
      }
      if (half && !this.half) {
        if (this.bits[bit]) { // extra transition mid-bit for 1
          this.level = -this.level;
          this.since = (this.pos - bit - 0.5) / this.step;
        }
        this.half = 1;
      }
      const k = this.since >= this.ramp ? 1 : this.since / this.ramp;
      out[i] = this.level * (2 * k - 1) * amp;
      this.since++;
      this.pos += this.step;
      if (this.pos >= 80) {
        this.pos -= 80;
        this.bit = -1;
        this.frame = (this.frame + 1) % framesPerDay(this.r);
        this.bits = frameBits(fromFrames(this.frame, this.r), this.r);
      }
    }
  }
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

// Mono WAV file size in bytes (44-byte header + data).
export function wavSize(seconds, sampleRate, bitDepth = 16) {
  return 44 + Math.round(seconds * sampleRate) * (bitDepth / 8);
}

// WAV sizes are 32-bit, so the whole file must stay below 4 GiB.
export const WAV_MAX_BYTES = 0xffffffff;

// Render LTC to a mono WAV Blob. bitDepth 16/24 = PCM, 32 = float.
// Rendered in 1 s chunks so long files never need one giant buffer.
export function renderWav({ r, startFrame, seconds, db, sampleRate = 48000, bitDepth = 16, riseUs }) {
  const n = Math.round(seconds * sampleRate);
  const bytes = bitDepth / 8;
  const head = new ArrayBuffer(44);
  const v = new DataView(head);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 1 = PCM, 3 = float
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytes, true);
  v.setUint16(32, bytes, true);
  v.setUint16(34, bitDepth, true);
  str(36, "data");
  v.setUint32(40, n * bytes, true);

  const gen = new LtcGenerator(r, sampleRate, startFrame, { riseUs });
  const amp = dbToGain(db);
  const parts = [head];
  for (let done = 0; done < n; done += sampleRate) {
    const len = Math.min(sampleRate, n - done);
    const samples = new Float32Array(len);
    gen.fill(samples, amp);
    const buf = new ArrayBuffer(len * bytes);
    const c = new DataView(buf);
    if (bitDepth === 32) {
      for (let i = 0; i < len; i++) c.setFloat32(i * 4, samples[i], true);
    } else if (bitDepth === 24) {
      for (let i = 0; i < len; i++) {
        const s = Math.round(samples[i] * 8388607);
        c.setUint16(i * 3, s & 0xffff, true);
        c.setInt8(i * 3 + 2, s >> 16);
      }
    } else {
      for (let i = 0; i < len; i++) c.setInt16(i * 2, Math.round(samples[i] * 32767), true);
    }
    parts.push(buf);
  }
  return new Blob(parts, { type: "audio/wav" });
}
