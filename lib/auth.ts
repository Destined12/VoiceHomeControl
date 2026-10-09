import type { NextApiRequest, NextApiResponse } from 'next';

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function requireDeviceKey(req: NextApiRequest, res: NextApiResponse): boolean {
  const expected = process.env.DEVICE_API_KEY;
  if (!expected) {
    res.status(503).json({ error: 'DEVICE_API_KEY is not configured' });
    return false;
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!safeEqual(token, expected)) {
    res.status(401).json({ error: 'Invalid or missing device API key' });
    return false;
  }

  return true;
}
