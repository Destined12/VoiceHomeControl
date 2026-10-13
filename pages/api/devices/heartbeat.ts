import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSchema, errorMessage, query } from '../../../lib/db';
import { emitChange } from '../../../lib/events';

type DeviceRow = {
  id: string;
  name: string;
  location: string;
  state: boolean;
  online: boolean;
  last_seen: string | number;
  pin: string | null;
};

type QueuedCommand = {
  id: string;
  device_id: string;
  device: string;
  action: string;
  pin: string;
};

// NOTE: The ESP8266 firmware does not call this route. It uses
// /api/controllers/heartbeat/ for presence and /api/controllers/{id}/commands/
// for claiming. This endpoint is retained for compatibility but is not part of
// the active command lifecycle. STALE_MS below is a legacy command-expiry value;
// authoritative command expiry now lives in lib/db.ts (expireStaleClaims). Do not
// repurpose this constant for device-presence detection.
const STALE_MS = 5 * 60 * 1000;
const CLAIM_TIMEOUT_MS = 60 * 1000;

function toDevice(row: DeviceRow) {
  return {
    ...row,
    last_seen: Number(row.last_seen),
    pin: row.pin ?? undefined,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = (req.body ?? {}) as {
    controller_id?: string;
    fw?: string;
    acks?: Array<{ command_id?: string | number; device_id?: string }>;
  };

  try {
    await ensureSchema();
    const now = Date.now();
    const acked: string[] = [];

    if (Array.isArray(body.acks)) {
      for (const ack of body.acks.slice(0, 8)) {
        const commandId = String(ack.command_id ?? '');
        if (!/^\d+$/.test(commandId)) continue;
        const command = await query<{ device_id: string | null; action: string; status: string }>(
          `SELECT device_id, action, status FROM voice_commands WHERE id = $1`,
          [commandId]
        );
        const row = command.rows[0];
        if (!row || !row.device_id || row.status === 'executed' || row.status === 'expired' || row.status === 'failed') continue;
        await query(`UPDATE voice_commands SET status = 'executed', executed_at = COALESCE(executed_at, $1) WHERE id = $2`, [now, commandId]);
        if (row.device_id) {
          await query(
            `UPDATE devices SET state = $1, last_seen = $2, heartbeat_at = $2, online = TRUE WHERE id = $3`,
            [row.action === 'ON', now, row.device_id]
          );
        }
        acked.push(commandId);
      }
    }

    await query(
      `UPDATE devices SET last_seen = $1, heartbeat_at = $1, online = TRUE WHERE pin IS NOT NULL`,
      [now]
    );

    await query(
      `UPDATE voice_commands SET status = 'pending', claimed_at = NULL, claimed_by = NULL
       WHERE status = 'claimed' AND claimed_at IS NOT NULL AND ($1 - claimed_at) > $2`,
      [now, CLAIM_TIMEOUT_MS]
    );

    await query(
      `UPDATE voice_commands SET status = 'expired'
       WHERE status IN ('pending', 'queued', 'claimed') AND created_at < $1`,
      [now - STALE_MS]
    );

    const commands = await query<QueuedCommand>(
      `SELECT vc.id, vc.device_id, vc.device, vc.action, d.pin
       FROM voice_commands vc
       JOIN devices d ON d.id = vc.device_id
       WHERE vc.status = 'pending' AND d.pin IS NOT NULL
       ORDER BY vc.id
       LIMIT 5`
    );

    const devices = await query<DeviceRow>(
      `SELECT id, name, location, state, online, last_seen, heartbeat_at, pin
       FROM devices
       ORDER BY pin NULLS LAST, id`
    );

    res.status(200).json({
      ok: true,
      controller_id: body.controller_id ?? 'unknown',
      server_time: now,
      acked,
      commands: commands.rows.map(row => ({ ...row, id: String(row.id) })),
      devices: devices.rows.map(toDevice),
    });
    emitChange('all');
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) });
  }
}
