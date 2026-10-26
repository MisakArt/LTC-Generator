import {
  RATES, toFrames, fromFrames, framesPerDay, formatTc, parseTc, dbToGain, renderWav,
  NO_USER_BITS, userBitsFromHex, userBitsFromDate, formatUserBits,
} from "./ltc.js";

const $ = (id) => document.getElementById(id);
const ui = {
  display: $("display"), status: $("status"), fpsLabel: $("fpsLabel"), ubLabel: $("ubLabel"),
  play: $("play"), stop: $("stop"), reset: $("reset"),
  fps: $("fps"), start: $("start"), level: $("level"), levelLabel: $("levelLabel"),
  ubMode: $("ubMode"), ubHex: $("ubHex"), ubHexWrap: $("ubHexWrap"), ubDate: $("ubDate"), ubDateWrap: $("ubDateWrap"),
  rise: $("rise"), sink: $("sink"), sinkWrap: $("sinkWrap"), sinkScan: $("sinkScan"),
  duration: $("duration"), sampleRate: $("sampleRate"), export: $("export"), error: $("error"),
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

// Returns user bits, or null if hex field is invalid.
function userBits() {
  const mode = ui.ubMode.value;
  if (mode === "hex") {
    const ub = userBitsFromHex(ui.ubHex.value);
    ui.ubHex.classList.toggle("bad", !ub);
    return ub;
  }
  if (mode === "date") {
    const [y, m, d] = (ui.ubDate.value || todayIso()).split("-").map(Number);
    return userBitsFromDate(d, m, y % 100);
  }
  return NO_USER_BITS;
}

function todayIso() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function showError(msg) {
  ui.error.textContent = msg;
  ui.error.hidden = !msg;
}

function render() {
  ui.display.textContent = formatTc(fromFrames(frame, rate()), rate());
  ui.display.classList.toggle("stopped", !playing);
  ui.status.textContent = playing ? "Playing" : "Stopped";
  ui.fpsLabel.textContent = rate().label;
  const ub = ui.ubMode.value === "off" ? null : userBits();
  ui.ubLabel.textContent = ub ? ` · UB ${formatUserBits(ub)}` : "";
  ui.ubHexWrap.hidden = ui.ubMode.value !== "hex";
  ui.ubDateWrap.hidden = ui.ubMode.value !== "date";
  ui.play.disabled = playing;
  ui.stop.disabled = !playing;
  ui.fps.disabled = playing;
  ui.start.disabled = playing;
}

async function play() {
  if (playing || starting) return;
  const ub = userBits();
  if (!ub) return showError("Invalid user bits. Use 8 hex digits (0–9, A–F).");
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
    processorOptions: { rateId: rate().id, startFrame: frame, userBits: ub, riseUs: riseUs() },
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
  const ub = userBits();
  if (!ub) return showError("Invalid user bits. Use 8 hex digits (0–9, A–F).");
  const seconds = Number(ui.duration.value);
  if (!(seconds > 0 && seconds <= 3600)) return showError("WAV length must be 1–3600 s.");
  showError("");
  const sampleRate = Number(ui.sampleRate.value);
  const blob = renderWav({ r: rate(), startFrame: s, seconds, db: db(), sampleRate, userBits: ub, riseUs: riseUs() });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `LTC_${rate().id}fps_${ui.start.value.replace(/\D/g, "")}_${seconds}s_${sampleRate / 1000}k.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function updateLevel() {
  ui.levelLabel.textContent = `${db()} dBFS`;
  if (gain) gain.gain.setTargetAtTime(dbToGain(db()), ctx.currentTime, 0.01);
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
ui.fps.onchange = () => { startFrame(); reset(); };
ui.start.onchange = reset;
ui.start.oninput = startFrame;
ui.ubMode.onchange = restartIfPlaying;
ui.ubHex.oninput = render;
ui.ubHex.onchange = restartIfPlaying;
ui.ubDate.onchange = restartIfPlaying;
ui.rise.onchange = restartIfPlaying;
ui.sink.onchange = changeSink;
ui.sinkScan.onclick = scanSinks;
document.addEventListener("keydown", onKey);

ui.ubDate.value = todayIso();
frame = startFrame() ?? 0;
updateLevel();
render();
