/**
 * AudioWorklet processor that converts getUserMedia audio into mono
 * signed 16-bit PCM at a fixed target sample rate (default 16000 Hz).
 *
 * The worklet source is shipped as a string and registered through
 * `registerProcessor`, so it never runs on the server.
 */

export const PCM_WORKLET_NAME = 'pcm-downsampler';

const PCM_WORKLET_CODE = `
${'' /* eslint-disable */}
const name = '${PCM_WORKLET_NAME}';

class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.chunkSamples = opts.chunkSamples || 1600; // 100ms at 16kHz
    // Fixed windowed-sinc kernel (Hann window).
    this.taps = 16;
    this.step = sampleRate / this.targetRate;
    this.buf = new Float32Array(0);
    this.base = 0;      // global input index of buf[0]
    this.outIndex = 0;  // next output sample index in the full stream
    this.acc = new Int16Array(this.chunkSamples);
    this.accLen = 0;
  }

  process(inputs) {
    const ch = inputs[0];
    if (!ch || ch.length === 0 || ch[0].length === 0) return true;

    const frames = ch[0].length;
    const mono = new Float32Array(frames);
    const nCh = ch.length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < nCh; c++) s += ch[c][i];
      mono[i] = s / nCh;
    }

    const merged = new Float32Array(this.buf.length + frames);
    merged.set(this.buf, 0);
    merged.set(mono, this.buf.length);
    this.buf = merged;

    let consumed = 0;
    while (true) {
      const pos = this.outIndex * this.step; // global input position
      if (Math.floor(pos) + this.taps + 1 > this.base + this.buf.length) break;
      const first = Math.max(Math.ceil(pos - this.taps), this.base);
      const last = Math.min(Math.floor(pos + this.taps), this.base + this.buf.length - 1);
      let sum = 0;
      let norm = 0;
      for (let n = first; n <= last; n++) {
        const d = pos - n;
        const w = 0.5 * (1 + Math.cos(Math.PI * d / this.taps));
        const scr = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
        sum += this.buf[n - this.base] * w * scr;
        norm += w * scr;
      }
      const sample = norm === 0 ? 0 : Math.max(-1, Math.min(1, sum / norm));
      this.acc[this.accLen++] = Math.round(sample * 32767);
      this.outIndex++;
      consumed = Math.max(consumed, Math.min(Math.max(Math.floor(pos) - this.taps - 1, 0), this.buf.length));

      if (this.accLen === this.chunkSamples) {
        const part = this.acc.slice();
        this.port.postMessage({ samples: part }, [part.buffer]);
        this.acc = new Int16Array(this.chunkSamples);
        this.accLen = 0;
      }
    }

    if (consumed > 0) {
      this.base += consumed;
      this.buf = this.buf.slice(consumed);
    }
    return true;
  }
}

try {
  registerProcessor(name, PCMDownsampler);
} catch (e) {
  // Already registered in HMR / duplicate-injection scenarios.
}
` + '';

function workletBlobUrl(): string {
  const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

export function loadPcmWorklet(audioContext: AudioContext, targetRate: number): Promise<void> {
  const url = workletBlobUrl();
  return audioContext.audioWorklet
    .addModule(url)
    .finally(() => URL.revokeObjectURL(url));
}