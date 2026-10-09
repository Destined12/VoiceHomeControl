import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSchema, errorMessage, query } from '../../lib/db';
import { emitChange } from '../../lib/events';

type DeviceRow = {
  id: string;
  name: string;
  location: string;
  state: boolean;
  online: boolean;
  last_seen: string | number;
  pin: string | null;
  aliases: string | null;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      await ensureSchema();
      const now = Date.now();
      const result = await query<DeviceRow>(
        `SELECT id, name, location, state, last_seen, heartbeat_at, pin, aliases,
                (COALESCE(heartbeat_at, last_seen) > $1::bigint - 30000) AS online
         FROM devices
         ORDER BY pin NULLS LAST, id`,
        [now]
      );
      res.status(200).json({
        devices: result.rows.map(row => ({ ...row, last_seen: Number(row.last_seen), pin: row.pin ?? undefined })),
      });
    } catch (error) {
      res.status(503).json({ error: errorMessage(error) });
    }
    return;
  }

  if (req.method === 'POST') {
    const body = req.body as {
      id?: string;
      name?: string;
      location?: string;
      state?: boolean;
      pin?: string;
      aliases?: string;
    };
    if (!body?.id || !body.name || !body.location || !body.pin) {
      res.status(400).json({ error: 'id, name, location and pin are required' });
      return;
    }
  if (!/^D[12567]$/.test(body.pin)) {
    res.status(400).json({ error: 'pin must be one of D1, D2, D5, D6, D7' });
    return;
  }

  const dup = await query(`SELECT id FROM devices WHERE pin = $1`, [body.pin]);
  if (dup.rows.length > 0 && dup.rows[0].id !== body.id) {
    res.status(400).json({ error: 'Pin already assigned' });
    return;
  }
    try {
      await ensureSchema();
      const now = Date.now();
      const result = await query<DeviceRow>(
        `INSERT INTO devices (id, name, location, state, online, last_seen, heartbeat_at, pin, aliases)
         VALUES ($1, $2, $3, $4, TRUE, $5, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               location = EXCLUDED.location,
               pin = EXCLUDED.pin,
               aliases = EXCLUDED.aliases,
               last_seen = EXCLUDED.last_seen,
               heartbeat_at = EXCLUDED.last_seen,
               online = TRUE
         RETURNING id, name, location, state, online, last_seen, pin, aliases`,
        [body.id, body.name, body.location, Boolean(body.state), now, body.pin, body.aliases ?? null]
      );
      const device = result.rows[0];
      emitChange('devices');
      res.status(200).json({
        ok: true,
        device: { ...device, last_seen: Number(device.last_seen), pin: device.pin ?? undefined },
      });
    } catch (error) {
      res.status(503).json({ error: errorMessage(error) });
    }
    return;
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ error: 'Method not allowed' });
}
