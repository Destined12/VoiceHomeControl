import type { NextApiRequest, NextApiResponse } from 'next';
import {
  ensureSchema,
  errorMessage,
  expireStaleClaims,
  query,
  COMMAND_CLAIM_TTL_MS,
} from '../../../../lib/db';
import { requireDeviceKey } from '../../../../lib/auth';
import { emitChange } from '../../../../lib/events';

type PendingCommand = {
  id: string;
  pin: string | null;
  action: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { controllerId } = req.query;
  if (!controllerId || typeof controllerId !== 'string') {
    res.status(400).json({ error: 'controllerId required' });
    return;
  }

  if (!requireDeviceKey(req, res)) {
    return;
  }

  if (req.method === 'GET') {
    try {
      await ensureSchema();
      const now = Date.now();

      const expired = await expireStaleClaims(now);
      if (expired > 0) {
        emitChange('commands');
      }

      const claimed = await query<PendingCommand>(
        `UPDATE voice_commands vc
         SET status = 'claimed', claimed_at = $1, claimed_by = $2
         FROM (
           SELECT vc.id
           FROM voice_commands vc
           JOIN devices d ON d.id = vc.device_id
           WHERE vc.status = 'pending'
             AND d.pin IS NOT NULL
             AND vc.created_at > $3
             AND (d.controller_id IS NULL OR LOWER(d.controller_id) = LOWER($2))
           ORDER BY vc.id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         ) picked
         JOIN devices d ON d.id = (SELECT device_id FROM voice_commands WHERE id = picked.id)
         WHERE vc.id = picked.id
         RETURNING vc.id, vc.pin, vc.action, d.id AS device_id`,
        [now, controllerId, now - COMMAND_CLAIM_TTL_MS]
      );

      if (claimed.rows.length === 0) {
        res.status(200).json({ command: null });
        return;
      }

      const c = claimed.rows[0];
      emitChange('commands');
      res.status(200).json({
        command: {
          id: String(c.id),
          pin: c.pin,
          action: c.action,
        },
      });
    } catch (error) {
      res.status(503).json({ error: errorMessage(error) });
    }
    return;
  }

  res.setHeader('Allow', 'GET');
  res.status(405).json({ error: 'Method not allowed' });
}
