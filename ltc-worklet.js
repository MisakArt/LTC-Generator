import { LtcGenerator } from "./ltc.js";

class LtcProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: { fps, startFrame } }) {
    super();
    this.gen = new LtcGenerator(fps, sampleRate, startFrame);
    this.gen.onFrame = (frame) => this.port.postMessage(frame);
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.running = false;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    this.gen.fill(out[0]);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    return this.running;
  }
}

registerProcessor("ltc", LtcProcessor);
