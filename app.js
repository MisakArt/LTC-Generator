import {
  RATES, LtcGenerator, toFrames, fromFrames, framesPerDay, formatTc, parseTc, dbToGain, renderWav, wavSize, WAV_MAX_BYTES,
} from "./ltc.js";

const $ = (id) => document.getElementById(id);
const ui = {
  display: $("display"), scope: $("scope"), status: $("status"), fpsLabel: $("fpsLabel"),
  play: $("play"), stop: $("stop"), reset: $("reset"),
  fps: $("fps"), start: $("start"), level: $("level"), levelLabel: $("levelLabel"),
  rise: $("rise"), sink: $("sink"), sinkWrap: $("sinkWrap"), sinkNote: $("sinkNote"),
  duration: $("duration"), durationUnit: $("durationUnit"), sampleRate: $("sampleRate"), bitDepth: $("bitDepth"), wavSize: $("wavSize"), wavMax: $("wavMax"),
  infoEnd: $("infoEnd"), infoFrames: $("infoFrames"), infoSpf: $("infoSpf"), infoBitrate: $("infoBitrate"), infoWavBitrate: $("infoWavBitrate"), export: $("export"), error: $("error"),
};

for (const r of Object.values(RATES)) ui.fps.add(new Option(r.label, r.id, false, r.id === "25"));
// Long text only while the list is open; the closed select shows the short label.
const fpsText = long => { for (const o of ui.fps.options) o.text = long ? RATES[o.value].long : RATES[o.value].label; };
ui.fps.addEventListener("mousedown", () => fpsText(true));
ui.fps.addEventListener("change", () => fpsText(false));
ui.fps.addEventListener("blur", () => fpsText(false));

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
  ui.fpsLabel.textContent = rate().exact ? `${rate().label} · ${rate().exact}` : `${rate().label} fps`;
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
  if (seconds === null) return showError(`WAV length must be 1–${MAX_MINUTES} whole minutes or 1–${MAX_MINUTES * 60} whole seconds.`);
  const sampleRate = Number(ui.sampleRate.value);
  const bitDepth = Number(ui.bitDepth.value);
  if (wavSize(seconds, sampleRate, bitDepth) > WAV_MAX_BYTES) return showError("File would exceed the 4 GB WAV limit. Choose a shorter length, lower sample rate or lower bit depth.");
  showError("");
  const len = inMinutes() ? `${ui.duration.value}min` : `${seconds}s`;
  const blob = renderWav({ r: rate(), startFrame: s, seconds, db: db(), sampleRate, bitDepth, riseUs: riseUs() });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `LTC_${rate().id}fps_${ui.start.value.replace(/\D/g, "")}_${len}_${sampleRate / 1000}k_${bitDepth}bit.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const inMinutes = () => ui.durationUnit.value === "min";

const MAX_MINUTES = 240;

// WAV length in seconds, or null if out of range. Whole minutes 1–240 or whole seconds 1–14400.
function wavSeconds() {
  const v = Number(ui.duration.value);
  if (inMinutes()) return Number.isInteger(v) && v >= 1 && v <= MAX_MINUTES ? v * 60 : null;
  return Number.isInteger(v) && v >= 1 && v <= MAX_MINUTES * 60 ? v : null;
}

// Keep the same length when switching unit.
function changeDurationUnit() {
  const v = Number(ui.duration.value);
  Object.assign(ui.duration, inMinutes()
    ? { min: 1, max: MAX_MINUTES, step: 1, value: Math.max(1, Math.round(v / 60)) }
    : { min: 1, max: MAX_MINUTES * 60, step: 1, value: Math.max(1, Math.round(v * 60)) });
  updateExportInfo();
}

function formatBytes(b) {
  const dec = b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;
  const bin = b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GiB` : `${(b / 2 ** 20).toFixed(1)} MiB`;
  return `${dec} (${bin})`;
}

// File size for current choice, end timecode and signal stats.
// Longest length (in seconds) that keeps the file under the 4 GB WAV limit.
function maxWavSeconds(sr, bitDepth) {
  return Math.min(MAX_MINUTES * 60, Math.floor((WAV_MAX_BYTES - 44) / (sr * (bitDepth / 8))));
}

// Set the length field's max from sample rate + bit depth; clamp the value down if it is over.
function limitDuration(sr, bitDepth, clamp) {
  const maxSec = maxWavSeconds(sr, bitDepth);
  const max = inMinutes() ? Math.floor(maxSec / 60) : maxSec;
  ui.duration.max = max;
  const v = Number(ui.duration.value);
  if (clamp && Number.isInteger(v) && v > max) ui.duration.value = max;
  const sec = wavSeconds();
  const limited = maxSec < MAX_MINUTES * 60;
  ui.wavMax.hidden = !(limited && sec !== null && sec >= maxSec * 0.9);
  ui.wavMax.textContent = `Max ${max} ${inMinutes() ? "min" : "s"} at ${sr / 1000} kHz / ${bitDepth}-bit${bitDepth === 32 ? " float" : ""} (${formatBytes(wavSize(maxSec, sr, bitDepth))})`;
}

function updateExportInfo(clamp = true) {
  limitDuration(Number(ui.sampleRate.value), Number(ui.bitDepth.value), clamp);
  const sec = wavSeconds();
  const sr = Number(ui.sampleRate.value);
  const r = rate();
  const s = parseTc(ui.start.value, r);
  const frames = sec === null ? null : Math.floor(sec * r.rate);
  ui.duration.classList.toggle("bad", sec === null);
  ui.wavSize.classList.toggle("bad", sec !== null && wavSize(sec, sr, Number(ui.bitDepth.value)) > WAV_MAX_BYTES);
  ui.wavSize.textContent = sec === null ? "–" : formatBytes(wavSize(sec, sr, Number(ui.bitDepth.value)));
  ui.infoEnd.textContent = frames === null || !s ? "–" : formatTc(fromFrames(toFrames(s, r) + frames, r), r);
  ui.infoFrames.textContent = frames === null ? "–" : frames.toLocaleString("en-US");
  ui.infoSpf.textContent = (sr / r.rate).toFixed(3);
  ui.infoBitrate.textContent = `${((80 * r.rate) / 1000).toFixed(3)} kbit/s`;
  // Mono PCM: sample rate x bit depth.
  ui.infoWavBitrate.textContent = `${((sr * Number(ui.bitDepth.value)) / 1000).toLocaleString("en-US", { minimumFractionDigits: 3 })} kbit/s`;
}

// Level marks under the slider. Tick position comes from the slider's real min/max.
const LEVEL_MARKS = [
  [0, "bad", "Not recommended. May clip."],
  [-3, "bad", "May clip."],
  [-6, "warn", "High."],
  [-12, "", "Default. Fits most gear."],
  [-20, "", "Quiet. For hot or sensitive inputs."],
];
const levelMarks = $("levelMarks");
{
  const min = Number(ui.level.min), max = Number(ui.level.max);
  const ticks = LEVEL_MARKS.map(([v, c]) => {
    const f = (v - min) / (max - min);
    return `<button type="button" class="tick ${c}" data-db="${v}" style="--f:${f}"><i></i>${v}</button>`;
  }).join("");
  const list = LEVEL_MARKS.map(([v, c, t]) =>
    `<button type="button" class="mark ${c}" data-db="${v}"><b>${v} dBFS</b> ${t}</button>`).join("");
  $("levelTicks").innerHTML = ticks;
  levelMarks.innerHTML = list;
  const onMark = (e) => {
    const b = e.target.closest("[data-db]");
    if (!b) return;
    ui.level.value = b.dataset.db;
    updateLevel();
  };
  levelMarks.onclick = $("levelTicks").onclick = onMark;
}

function updateLevel() {
  document.querySelectorAll("#levelTicks [data-db], #levelMarks [data-db]").forEach((b) => b.classList.toggle("on", Number(b.dataset.db) === db()));
  ui.levelLabel.textContent = `${db()} dBFS`;
  if (gain) gain.gain.setTargetAtTime(dbToGain(db()), ctx.currentTime, 0.01);
  queueScope();
}

// Output device select. Needs AudioContext.setSinkId (Chromium). No permission is ever requested:
// the select is shown only if enumerateDevices() already lists at least two usable outputs,
// otherwise audio follows the system default and a note is shown instead.
async function listSinks() {
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === "audiooutput" && d.deviceId !== "" && d.deviceId !== "default" && d.deviceId !== "communications");
  const keep = ui.sink.value;
  ui.sink.length = 1;
  for (const d of devices) ui.sink.add(new Option(d.label || `Output ${ui.sink.length}`, d.deviceId));
  ui.sink.value = [...ui.sink.options].some((o) => o.value === keep) ? keep : "";
  const show = devices.length >= 2;
  ui.sinkWrap.hidden = !show;
  ui.sinkNote.hidden = show;
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
  listSinks();
  navigator.mediaDevices.addEventListener("devicechange", listSinks);
} else {
  ui.sinkNote.hidden = false;
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
ui.duration.oninput = () => updateExportInfo(false);
ui.duration.onchange = () => updateExportInfo();
ui.durationUnit.onchange = changeDurationUnit;
ui.sampleRate.onchange = updateExportInfo;
ui.bitDepth.onchange = updateExportInfo;
ui.fps.onchange = () => { startFrame(); reset(); updateExportInfo(); };
ui.start.onchange = reset;
ui.start.oninput = () => { startFrame(); updateExportInfo(); };
ui.rise.onchange = restartIfPlaying;
ui.sink.onchange = changeSink;
document.addEventListener("keydown", onKey);
window.addEventListener("resize", queueScope);

frame = startFrame() ?? 0;
updateLevel();
updateExportInfo();
render();
