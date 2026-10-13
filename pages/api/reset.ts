import type { NextApiRequest, NextApiResponse } from 'next';
import { errorMessage, resetAllData } from '../../lib/db';
import { emitChange } from '../../lib/events';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const result = await resetAllData();
    emitChange('commands');
    emitChange('devices');
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) });
  }
}
