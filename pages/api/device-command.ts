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
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body as { device_id?: string; action?: string };
  if (!body?.device_id || !body.action || !['ON', 'OFF'].includes(body.action)) {
    res.status(400).json({ error: 'Invalid device command' });
    return;
  }

  try {
    await ensureSchema();
    const result = await query<DeviceRow>(
      `SELECT id, name, location, state, online, last_seen, pin
       FROM devices
       WHERE id = $1`,
      [body.device_id]
    );
    const device = result.rows[0];
    if (!device) {
      res.status(404).json({ error: 'Invalid device command' });
      return;
    }

    const inserted = await query<{ id: string }>(
        `INSERT INTO voice_commands (text, device, device_id, pin, action, status, created_at, audio_received)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, FALSE)
       RETURNING id`,
      [`Manual: turn ${body.action.toLowerCase()} ${device.name}`, device.name, device.id, device.pin, body.action, Date.now()]
    );

    res.status(200).json({
      ok: true,
      id: String(inserted.rows[0].id),
      status: 'pending',
      device: { ...device, last_seen: Number(device.last_seen), pin: device.pin ?? undefined },
      transport: 'db-poll',
    });
    emitChange('commands');
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) });
  }
}
