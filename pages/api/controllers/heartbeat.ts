import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSchema, errorMessage, expireStaleClaims, query } from '../../../lib/db';
import { requireDeviceKey } from '../../../lib/auth';
import { emitChange } from '../../../lib/events';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!requireDeviceKey(req, res)) {
    return;
  }

  const body = (req.body ?? {}) as {
    controller_id?: string;
    fw?: string;
  };

  try {
    await ensureSchema();
    const now = Date.now();

    const expired = await expireStaleClaims(now);
    if (expired > 0) {
      emitChange('commands');
    }

    if (body.controller_id) {
      await query(
        `UPDATE devices
         SET controller_id = COALESCE($2, controller_id),
             fw = COALESCE($3, fw),
             last_seen = $1,
             heartbeat_at = $1,
             online = TRUE
         WHERE pin IS NOT NULL`,
        [now, body.controller_id, body.fw ?? null]
      );
    } else {
      await query(
        `UPDATE devices SET last_seen = $1, heartbeat_at = $1, online = TRUE WHERE pin IS NOT NULL`,
        [now]
      );
    }
    res.status(200).json({ ok: true, database_connected: true, server_time: now });
    emitChange('devices');
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) });
  }
}
