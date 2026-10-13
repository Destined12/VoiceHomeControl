import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSchema, errorMessage, query, COMMAND_EXECUTION_TTL_MS } from '../../../../../../lib/db';
import { requireDeviceKey } from '../../../../../../lib/auth';
import { emitChange } from '../../../../../../lib/events';

const TERMINAL_STATUSES = "'executed', 'failed', 'expired', 'cancelled'";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { controllerId, commandId } = req.query;
  if (!controllerId || typeof controllerId !== 'string' || !commandId || typeof commandId !== 'string') {
    res.status(400).json({ error: 'controllerId and commandId required' });
    return;
  }

  if (!requireDeviceKey(req, res)) {
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body as { success?: boolean; error?: string };
  const success = body?.success === true;

  try {
    await ensureSchema();
    const now = Date.now();

    const cmd = await query<{ device_id: string | null; status: string; action: string; created_at: string | number }>(
      `SELECT vc.device_id, vc.action, vc.status, vc.created_at
       FROM voice_commands vc
       WHERE vc.id = $1`,
      [commandId]
    );
    if (cmd.rows.length === 0) {
      res.status(404).json({ error: 'Command not found' });
      return;
    }
    const row = cmd.rows[0];
    if (!row.device_id) {
      res.status(400).json({ error: 'Invalid command device' });
      return;
    }

    // Never revive or overwrite a terminal state.
    if (row.status === 'expired' || row.status === 'cancelled' || row.status === 'executed' || row.status === 'failed') {
      res.status(200).json({ ok: row.status === 'executed', status: row.status });
      return;
    }

    // A command that missed its execution deadline is expired, not completed.
    if (now - Number(row.created_at) > COMMAND_EXECUTION_TTL_MS) {
      const expired = await query(
        `UPDATE voice_commands SET status = 'expired'
         WHERE id = $1 AND status NOT IN (${TERMINAL_STATUSES})
         RETURNING id`,
        [commandId]
      );
      if (expired.rowCount && expired.rowCount > 0) {
        emitChange('commands');
      }
      res.status(200).json({ ok: false, status: 'expired' });
      return;
    }

    if (success) {
      const updated = await query(
        `UPDATE voice_commands
         SET status = 'executed', executed_at = $1, error = NULL
         WHERE id = $2 AND status = 'claimed'
         RETURNING id`,
        [now, commandId]
      );
      if (!updated.rowCount) {
        const current = await query<{ status: string }>(`SELECT status FROM voice_commands WHERE id = $1`, [commandId]);
        res.status(200).json({ ok: false, status: current.rows[0]?.status ?? 'unknown' });
        return;
      }
      await query(
        `UPDATE devices
         SET state = $1, last_seen = $2, online = TRUE, heartbeat_at = $2
         WHERE id = $3`,
        [row.action === 'ON', now, row.device_id]
      );
      emitChange('all');
      res.status(200).json({ ok: true, status: 'executed' });
    } else {
      const updated = await query(
        `UPDATE voice_commands
         SET status = 'failed', executed_at = NULL, error = $1
         WHERE id = $2 AND status = 'claimed'
         RETURNING id`,
        [body?.error ?? 'Execution failed', commandId]
      );
      if (!updated.rowCount) {
        const current = await query<{ status: string }>(`SELECT status FROM voice_commands WHERE id = $1`, [commandId]);
        res.status(200).json({ ok: false, status: current.rows[0]?.status ?? 'unknown' });
        return;
      }
      await query(
        `UPDATE devices SET heartbeat_at = $1, online = TRUE WHERE id = $2`,
        [now, row.device_id]
      );
      emitChange('all');
      res.status(200).json({ ok: false, status: 'failed' });
    }
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) });
  }
}
