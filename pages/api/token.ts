import type { NextApiRequest, NextApiResponse } from 'next';
import { GoogleGenAI } from '@google/genai';
import { Modality } from '@google/genai';
import { ensureSchema, query } from '../../lib/db';
import { buildTranscriptionConfig } from '../../lib/transcription';

const LIVE_MODEL = 'gemini-3.5-transcribe-live';
const TOKEN_TTL_MS = 120_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

const hits = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

type DeviceVocabularyRow = {
  name: string;
  location: string;
  aliases: string | null;
};

// Best-effort: room names, device names and voice aliases are fed to the
// recognizer so configured spaces are transcribed correctly. Voice must still
// work when the database is unreachable, so failures fall back to no terms.
async function loadVocabularyTerms(): Promise<string[]> {
  try {
    await ensureSchema();
    const rows = await query<DeviceVocabularyRow>(
      `SELECT name, location, aliases FROM devices WHERE pin IS NOT NULL`
    );
    return rows.rows.flatMap(row => [
      row.name,
      row.location,
      ...(row.aliases ?? '').split(','),
    ]);
  } catch (error) {
    console.error('[token] vocabulary lookup failed:', error);
    return [];
  }
}

function clientKey(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const key = clientKey(req);
  if (isRateLimited(key)) {
    res.status(429).json({ error: 'Too many requests — try again in a minute.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'Voice transcription is not configured yet.' });
    console.error('[token] GEMINI_API_KEY is not set');
    return;
  }

  try {
    const vocabularyTerms = await loadVocabularyTerms();
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: 'v1alpha' },
    });
    const authToken = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.TEXT],
            inputAudioTranscription: buildTranscriptionConfig(vocabularyTerms),
          },
        },
      },
    });
    if (!authToken.name) {
      throw new Error('empty token');
    }
    res.status(200).json({ token: authToken.name });
  } catch (error: any) {
    const message =
      error && typeof error.message === 'string'
        ? error.message.slice(0, 200)
        : 'token creation failed';
    if (message.includes('429')) {
      res.status(429).json({ error: 'Transcription service is busy — try again shortly.' });
      return;
    }
    console.error('[token] failed:', message);
    res.status(502).json({ error: 'Could not start voice transcription. Please try again.' });
  }
}