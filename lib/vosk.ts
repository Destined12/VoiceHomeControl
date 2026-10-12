import fs from 'fs';
import path from 'path';

type VoskModel = { free(): void };

type VoskRecognizer = {
  acceptWaveform(data: Buffer): boolean;
  result(): { text?: string };
  partialResult(): { partial?: string };
  finalResult(): { text?: string };
  free(): void;
};

type VoskModule = {
  Model: new (modelPath: string) => VoskModel;
  Recognizer: new (options: { model: VoskModel; sampleRate: number }) => VoskRecognizer;
};

const DEFAULT_MODEL_PATH = 'model';
const DEFAULT_SAMPLE_RATE = 16000;

let voskModule: VoskModule | null = null;
let sharedModel: VoskModel | null = null;

export const VOSK_SAMPLE_RATE = DEFAULT_SAMPLE_RATE;

export function voskEnabled(): boolean {
  const flag = (process.env.VOSK_ENABLED ?? '').toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'yes';
}

export function modelPath(): string {
  return path.resolve(process.env.VOSK_MODEL_PATH || DEFAULT_MODEL_PATH);
}

function loadVosk(): VoskModule {
  if (!voskModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    voskModule = require('vosk') as VoskModule;
  }
  return voskModule;
}

export function getModel(): VoskModel {
  if (!sharedModel) {
    const dir = modelPath();
    if (!fs.existsSync(dir)) {
      throw new Error(`Vosk model not found at ${dir}. Run "npm run fetch-model".`);
    }
    const vosk = loadVosk();
    sharedModel = new vosk.Model(dir);
  }
  return sharedModel;
}

export function modelAvailable(): boolean {
  try {
    getModel();
    return true;
  } catch {
    return false;
  }
}

export function transcribe(pcm: Buffer, sampleRate: number = DEFAULT_SAMPLE_RATE): string {
  const vosk = loadVosk();
  const recognizer = new vosk.Recognizer({ model: getModel(), sampleRate });
  try {
    const step = 4000;
    for (let offset = 0; offset < pcm.length; offset += step) {
      recognizer.acceptWaveform(pcm.subarray(offset, offset + step));
    }
    return (recognizer.finalResult().text || '').trim();
  } finally {
    recognizer.free();
  }
}
