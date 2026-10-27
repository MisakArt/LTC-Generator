import {
  RATES, LtcGenerator, toFrames, fromFrames, framesPerDay, formatTc, parseTc, dbToGain, renderWav, wavSize,
} from "./ltc.js";

const $ = (id) => document.getElementById(id);
const ui = {
  display: $("display"), scope: $("scope"), status: $("status"), fpsLabel: $("fpsLabel"),
  play: $("play"), stop: $("stop"), reset: $("reset"),
  fps: $("fps"), start: $("start"), level: $("level"), levelLabel: $("levelLabel"),
  rise: $("rise"), sink: $("sink"), sinkWrap: $("sinkWrap"), sinkScan: $("sinkScan"),
  duration: $("duration"), durationUnit: $("durationUnit"), sampleRate: $("sampleRate"), bitDepth: $("bitDepth"), wavSize: $("wavSize"),
  infoEnd: $("infoEnd"), infoFrames: $("infoFrames"), infoSpf: $("infoSpf"), infoBitrate: $("infoBitrate"), export: $("export"), error: $("error"),
};

for (const r of Object.values(RATES)) ui.fps.add(new Option(r.label, r.id, false, r.id === "25"));

let ctx = null;
let gain = null;
let node = null;
let frame = 0; // current position (frame count since 00:00:00:00)
let playing = false;
let sent = false; // worklet has reported at least one frame
let starting = false;

const rate = () => RATES[ui.fps.value];
const db = () => Number(ui.level.value);
const riseUs = () => Number(ui.rise.value);

function startFrame() {
  const tc = parseTc(ui.start.value, rate());
  ui.start.classList.toggle("bad", !tc);
  return tc ? toFrames(tc, rate()) : null;
}

function showError(msg) {
  ui.error.textContent = msg;
  ui.error.hidden = !msg;
}

// Waveform preview: one frame of the signal being sent, synthesized from the same encoder.
// Redraws only on frame / level / setting change, batched to one draw per animation frame.
let scopeQueued = false;

function queueScope() {
  if (scopeQueued) return;
  scopeQueued = true;
  requestAnimationFrame(drawScope);
}

function drawScope() {
  scopeQueued = false;
  const c = ui.scope;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (!w || !h) return;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);

  // Bit grid every 8 bits, sync word (bits 64–79) shaded, zero line.
  g.fillStyle = "#1c1c1c";
  g.fillRect((64 / 80) * w, 0, (16 / 80) * w, h);
  g.fillStyle = "#333";
  for (let b = 8; b < 80; b += 8) g.fillRect(Math.round((b / 80) * w), 0, 1, h);
  g.fillRect(0, Math.round(h / 2), w, 1);

  // 2 samples per pixel; generator works at any sample rate. Full scale = 0 dBFS.
  const samples = new Float32Array(w * 2);
  const gen = new LtcGenerator(rate(), rate().rate * samples.length, frame, { riseUs: riseUs() });
  gen.fill(samples, dbToGain(db()));
  const amp = h / 2 - 4 * dpr;
  g.strokeStyle = playing ? "#ff3b30" : "#e6e6e6";
  g.lineWidth = 1.5 * dpr;
  g.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = (i / samples.length) * w;
    const y = h / 2 - samples[i] * amp;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}

function render() {
  ui.display.textContent = formatTc(fromFrames(frame, rate()), rate());
  ui.display.classList.toggle("stopped", !playing);
  ui.status.textContent = playing ? "Playing" : "Stopped";
  ui.fpsLabel.textContent = rate().label;
  ui.play.disabled = playing;
  ui.stop.disabled = !playing;
  ui.fps.disabled = playing;
  ui.start.disabled = playing;
  queueScope();
}

async function play() {
  if (playing || starting) return;
  showError("");
  starting = true;
  ui.play.disabled = true;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule("ltc-worklet.js");
      gain = new GainNode(ctx, { gain: dbToGain(db()) });
      gain.connect(ctx.destination);
      if (ui.sink.value) await ctx.setSinkId(ui.sink.value);
    }
    await ctx.resume();
  } catch (e) {
    showError("Audio failed: " + e.message + " (serve over http/https, not file://)");
    return;
  } finally {
    starting = false;
    render();
  }
  node = new AudioWorkletNode(ctx, "ltc", {
    numberOfInputs: 0,
    outputChannelCount: [ctx.destination.channelCount],
    processorOptions: { rateId: rate().id, startFrame: frame, riseUs: riseUs() },
  });
  sent = false;
  node.port.onmessage = (e) => { frame = e.data; sent = true; render(); };
  node.connect(gain);
  playing = true;
  render();
}

function stop() {
  if (!node) return;
  node.port.postMessage("stop");
  node.disconnect();
  node.port.onmessage = null;
  node = null;
  playing = false;
  if (sent) frame = (frame + 1) % framesPerDay(rate()); // resume after last frame sent
  render();
}

function reset() {
  const s = startFrame();
  if (s === null) return showError("Invalid start time. Use HH:MM:SS:FF, FF < fps (DF: no ;00/;01 at minutes not ÷10).");
  showError("");
  const wasPlaying = playing;
  if (playing) stop();
  frame = s;
  render();
  if (wasPlaying) play();
}

// Signal settings changed: keep position, restart generator with new settings.
function restartIfPlaying() {
  render();
  if (!playing) return;
  stop();
  play();
}

function exportWav() {
  const s = startFrame();
  if (s === null) return showError("Invalid start time. Use HH:MM:SS:FF, FF < fps (DF: no ;00/;01 at minutes not ÷10).");
  const seconds = wavSeconds();
  if (seconds === null) return showError("WAV length must be 1–60 whole minutes or 1–3600 whole seconds.");
  showError("");
  const len = inMinutes() ? `${ui.duration.value}min` : `${seconds}s`;
  const sampleRate = Number(ui.sampleRate.value);
  const bitDepth = Number(ui.bitDepth.value);
  const blob = renderWav({ r: rate(), startFrame: s, seconds, db: db(), sampleRate, bitDepth, riseUs: riseUs() });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `LTC_${rate().id}fps_${ui.start.value.replace(/\D/g, "")}_${len}_${sampleRate / 1000}k_${bitDepth}bit.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const inMinutes = () => ui.durationUnit.value === "min";

// WAV length in seconds, or null if out of range. Minutes 0.1–60, seconds whole 1–3600.
function wavSeconds() {
  const v = Number(ui.duration.value);
  if (inMinutes()) return Number.isInteger(v) && v >= 1 && v <= 60 ? v * 60 : null;
  return Number.isInteger(v) && v >= 1 && v <= 3600 ? v : null;
}

// Keep the same length when switching unit.
function changeDurationUnit() {
  const v = Number(ui.duration.value);
  Object.assign(ui.duration, inMinutes()
    ? { min: 1, max: 60, step: 1, value: Math.max(1, Math.round(v / 60)) }
    : { min: 1, max: 3600, step: 1, value: Math.max(1, Math.round(v * 60)) });
  updateExportInfo();
}

function formatBytes(b) {
  return b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;
}

// File size for current choice, end timecode and signal stats.
function updateExportInfo() {
  const sec = wavSeconds();
  const sr = Number(ui.sampleRate.value);
  const r = rate();
  const s = parseTc(ui.start.value, r);
  const frames = sec === null ? null : Math.floor(sec * r.rate);
  ui.duration.classList.toggle("bad", sec === null);
  ui.wavSize.textContent = sec === null ? "–" : formatBytes(wavSize(sec, sr, Number(ui.bitDepth.value)));
  ui.infoEnd.textContent = frames === null || !s ? "–" : formatTc(fromFrames(toFrames(s, r) + frames, r), r);
  ui.infoFrames.textContent = frames === null ? "–" : frames.toLocaleString("en-US");
  ui.infoSpf.textContent = (sr / r.rate).toFixed(3);
  ui.infoBitrate.textContent = `${((80 * r.rate) / 1000).toFixed(3)} kbit/s`;
}

function updateLevel() {
  ui.levelLabel.textContent = `${db()} dBFS`;
  if (gain) gain.gain.setTargetAtTime(dbToGain(db()), ctx.currentTime, 0.01);
  queueScope();
}

// Output device select. Needs AudioContext.setSinkId (Chromium). Labels need mic permission.
async function listSinks() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  const keep = ui.sink.value;
  ui.sink.length = 1;
  for (const d of devices) {
    if (d.deviceId === "default" || d.deviceId === "") continue;
    ui.sink.add(new Option(d.label || `Output ${ui.sink.length}`, d.deviceId));
  }
  ui.sink.value = [...ui.sink.options].some((o) => o.value === keep) ? keep : "";
  ui.sinkScan.hidden = devices.every((d) => d.label);
}

async function scanSinks() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await listSinks();
  } catch (e) {
    showError("Could not list devices: " + e.message);
  }
}

async function changeSink() {
  if (!ctx) return;
  try {
    await ctx.setSinkId(ui.sink.value);
    showError("");
  } catch (e) {
    showError("Could not switch output: " + e.message);
  }
}

if ("setSinkId" in AudioContext.prototype && navigator.mediaDevices?.enumerateDevices) {
  ui.sinkWrap.hidden = false;
  listSinks();
  navigator.mediaDevices.addEventListener("devicechange", listSinks);
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.target.closest("input, select, textarea")) return;
  if (e.code === "Space") {
    e.preventDefault();
    document.activeElement?.blur(); // a focused button would also click on keyup
    playing ? stop() : play();
  } else if (e.code === "KeyR") {
    reset();
  }
}

ui.play.onclick = play;
ui.stop.onclick = stop;
ui.reset.onclick = reset;
ui.export.onclick = exportWav;
ui.level.oninput = updateLevel;
ui.duration.oninput = updateExportInfo;
ui.durationUnit.onchange = changeDurationUnit;
ui.sampleRate.onchange = updateExportInfo;
ui.bitDepth.onchange = updateExportInfo;
ui.fps.onchange = () => { startFrame(); reset(); updateExportInfo(); };
ui.start.onchange = reset;
ui.start.oninput = () => { startFrame(); updateExportInfo(); };
ui.rise.onchange = restartIfPlaying;
ui.sink.onchange = changeSink;
ui.sinkScan.onclick = scanSinks;
document.addEventListener("keydown", onKey);
window.addEventListener("resize", queueScope);

frame = startFrame() ?? 0;
updateLevel();
updateExportInfo();
render();
