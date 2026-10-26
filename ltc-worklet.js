import { LtcGenerator, RATES } from "./ltc.js";

class LtcProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: { rateId, startFrame, userBits, riseUs } }) {
    super();
    this.gen = new LtcGenerator(RATES[rateId], sampleRate, startFrame, { userBits, riseUs });
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
