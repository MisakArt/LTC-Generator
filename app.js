import { toFrames, fromFrames, formatTc, parseTc, dbToGain, renderWav } from "./ltc.js";

const $ = (id) => document.getElementById(id);
const ui = {
  display: $("display"), status: $("status"), fpsLabel: $("fpsLabel"),
  play: $("play"), stop: $("stop"), reset: $("reset"),
  fps: $("fps"), start: $("start"), level: $("level"), levelLabel: $("levelLabel"),
  duration: $("duration"), export: $("export"), error: $("error"),
};

let ctx = null;
let gain = null;
let node = null;
let frame = 0; // current position (frame count since 00:00:00:00)
let playing = false;
let sent = false; // worklet has reported at least one frame
let starting = false;

const fps = () => Number(ui.fps.value);
const db = () => Number(ui.level.value);

function startFrame() {
  const tc = parseTc(ui.start.value, fps());
  ui.start.classList.toggle("bad", !tc);
  return tc ? toFrames(tc, fps()) : null;
}

function showError(msg) {
  ui.error.textContent = msg;
  ui.error.hidden = !msg;
}

function render() {
  ui.display.textContent = formatTc(fromFrames(frame, fps()));
  ui.display.classList.toggle("stopped", !playing);
  ui.status.textContent = playing ? "Playing" : "Stopped";
  ui.fpsLabel.textContent = fps();
  ui.play.disabled = playing;
  ui.stop.disabled = !playing;
  ui.fps.disabled = playing;
  ui.start.disabled = playing;
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
    processorOptions: { fps: fps(), startFrame: frame },
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
  if (sent) frame = (frame + 1) % (fps() * 86400); // resume after last frame sent
  render();
}

function reset() {
  const s = startFrame();
  if (s === null) return showError("Invalid start time. Use HH:MM:SS:FF, FF < fps.");
  showError("");
  const wasPlaying = playing;
  if (playing) stop();
  frame = s;
  render();
  if (wasPlaying) play();
}

function exportWav() {
  const s = startFrame();
  if (s === null) return showError("Invalid start time. Use HH:MM:SS:FF, FF < fps.");
  const seconds = Number(ui.duration.value);
  if (!(seconds > 0 && seconds <= 3600)) return showError("WAV length must be 1–3600 s.");
  showError("");
  const blob = renderWav({ fps: fps(), startFrame: s, seconds, db: db() });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `LTC_${fps()}fps_${ui.start.value.replace(/\D/g, "")}_${seconds}s.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function updateLevel() {
  ui.levelLabel.textContent = `${db()} dBFS`;
  if (gain) gain.gain.setTargetAtTime(dbToGain(db()), ctx.currentTime, 0.01);
}

ui.play.onclick = play;
ui.stop.onclick = stop;
ui.reset.onclick = reset;
ui.export.onclick = exportWav;
ui.level.oninput = updateLevel;
ui.fps.onchange = () => { startFrame(); reset(); };
ui.start.onchange = reset;
ui.start.oninput = startFrame;

frame = startFrame() ?? 0;
updateLevel();
render();
