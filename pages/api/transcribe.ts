import type { NextApiRequest, NextApiResponse } from 'next';
import { GoogleGenAI } from '@google/genai';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

function normalizeMimeType(mimeType: string | undefined): string {
  const type = (mimeType || '').toLowerCase().split(';')[0].trim();
  switch (type) {
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'audio/m4a';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'audio/mp3';
    case 'audio/x-wav':
    case 'audio/wave':
      return 'audio/wav';
    case 'audio/ogg':
      return 'audio/ogg';
    case 'audio/webm':
      return 'audio/webm';
    default:
      return type || 'audio/webm';
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'GEMINI_API_KEY is not configured' });
    return;
  }

  const body = req.body as { audioBase64?: string; mimeType?: string };
  if (!body?.audioBase64) {
    res.status(400).json({ error: 'audioBase64 is required' });
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: TRANSCRIBE_MODEL,
      contents: [
        {
          inlineData: {
            mimeType: normalizeMimeType(body.mimeType),
            data: body.audioBase64,
          },
        },
      ],
    });

    res.status(200).json({ text: response.text?.trim() ?? '' });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Transcription failed' });
  }
}
