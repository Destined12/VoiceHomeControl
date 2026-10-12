import type { NextApiRequest, NextApiResponse } from 'next';
import { VOSK_SAMPLE_RATE, modelAvailable, transcribe, voskEnabled } from '../../lib/vosk';

export const config = {
  api: {
    bodyParser: { sizeLimit: '8mb' },
  },
};

const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

function stripWavHeader(buffer: Buffer): { pcm: Buffer; sampleRate?: number } {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return { pcm: buffer };
  }

  const sampleRate = buffer.readUInt32LE(24);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const end = Math.min(offset + 8 + size, buffer.length);
      return { pcm: buffer.subarray(offset + 8, end), sampleRate };
    }
    offset += 8 + size + (size % 2);
  }

  return { pcm: buffer.subarray(44), sampleRate };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!voskEnabled()) {
    res.status(503).json({ error: 'Server-side transcription is disabled (set VOSK_ENABLED=true).' });
    return;
  }

  if (!modelAvailable()) {
    res.status(503).json({ error: 'Vosk model is not available on the server.' });
    return;
  }

  const body = (req.body ?? {}) as { audio?: string; sampleRate?: number };
  if (!body.audio || typeof body.audio !== 'string') {
    res.status(400).json({ error: 'audio (base64 PCM16LE) is required' });
    return;
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(body.audio, 'base64');
  } catch {
    res.status(400).json({ error: 'audio is not valid base64' });
    return;
  }

  if (!raw.length) {
    res.status(400).json({ error: 'audio is empty' });
    return;
  }
  if (raw.length > MAX_AUDIO_BYTES) {
    res.status(413).json({ error: 'audio clip is too large' });
    return;
  }

  const { pcm, sampleRate: wavSampleRate } = stripWavHeader(raw);
  const sampleRate = wavSampleRate || body.sampleRate || VOSK_SAMPLE_RATE;

  if (sampleRate !== VOSK_SAMPLE_RATE) {
    res.status(400).json({
      error: `audio must be ${VOSK_SAMPLE_RATE} Hz mono PCM16 (received ${sampleRate} Hz)`,
    });
    return;
  }

  try {
    const text = transcribe(pcm, sampleRate);
    res.status(200).json({ text });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed';
    res.status(500).json({ error: message });
  }
}
