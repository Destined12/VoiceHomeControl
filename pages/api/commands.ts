import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSchema, errorMessage, expireStaleClaims, query } from '../../lib/db';
import { resolveCommand, type ResolveDevice } from '../../lib/resolve';
import { emitChange } from '../../lib/events';

type CommandRow = {
  id: string;
  text: string;
  device: string;
  device_id: string | null;
  action: string;
  status: string;
  created_at: string | number;
  audio_received: boolean;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      await ensureSchema();
      const expired = await expireStaleClaims(Date.now());
      if (expired > 0) {
        emitChange('commands');
      }
      const result = await query<CommandRow>(
        `SELECT id, text, device, device_id, action, status, created_at, audio_received
         FROM voice_commands
         ORDER BY created_at DESC, id DESC
         LIMIT 25`
      );
      res.status(200).json({
        commands: result.rows.map(row => ({ ...row, id: String(row.id), created_at: Number(row.created_at) })),
      });
    } catch (error) {
      res.status(503).json({ error: errorMessage(error) });
    }
    return;
  }

  if (req.method === 'POST') {
    const body = req.body as { text?: string; audio_received?: boolean };
    if (!body?.text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    try {
      await ensureSchema();
      const devices = await query<ResolveDevice>(
        `SELECT id, name, location, aliases, pin FROM devices WHERE pin IS NOT NULL ORDER BY pin, id`
      );
      const resolved = resolveCommand(body.text, devices.rows);

      const status = resolved.device_id && resolved.action !== 'UNKNOWN' ? 'pending' : 'unresolved';
      const inserted = await query<{ id: string }>(
        `INSERT INTO voice_commands (text, device, device_id, pin, action, status, created_at, audio_received)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          body.text,
          resolved.device ?? 'unknown',
          resolved.device_id,
          resolved.pin,
          resolved.action,
          status,
          Date.now(),
          Boolean(body.audio_received),
        ]
      );

      emitChange('commands');

      res.status(200).json({
        id: String(inserted.rows[0].id),
        status,
        device_id: resolved.device_id,
        device: resolved.device,
        action: resolved.action,
        pin: resolved.pin,
      });
    } catch (error) {
      res.status(503).json({ error: errorMessage(error) });
    }
    return;
  }

  if (req.method === 'DELETE') {
    try {
      await ensureSchema();
      const result = await query(`DELETE FROM voice_commands`);
      emitChange('commands');
      res.status(200).json({ ok: true, cleared: result.rowCount });
    } catch (error) {
      res.status(503).json({ error: errorMessage(error) });
    }
    return;
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  res.status(405).json({ error: 'Method not allowed' });
}
