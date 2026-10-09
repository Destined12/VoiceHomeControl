import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSchema, errorMessage, query } from '../../../../../../lib/db';
import { requireDeviceKey } from '../../../../../../lib/auth';
import { emitChange } from '../../../../../../lib/events';

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

    const cmd = await query<{ device_id: string | null; status: string; action: string }>(
      `SELECT vc.device_id, vc.action, vc.status
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

    if (success) {
      await query(
        `UPDATE voice_commands
         SET status = 'executed', executed_at = $1, error = NULL
         WHERE id = $2`,
        [now, commandId]
      );
      await query(
        `UPDATE devices
         SET state = $1, last_seen = $2, online = TRUE, heartbeat_at = $2
         WHERE id = $3`,
        [row.action === 'ON', now, row.device_id]
      );
      res.status(200).json({ ok: true, status: 'executed' });
    } else {
      await query(
        `UPDATE voice_commands
         SET status = 'failed', executed_at = NULL, error = $1
         WHERE id = $2`,
        [body?.error ?? 'Execution failed', commandId]
      );
      await query(
        `UPDATE devices SET heartbeat_at = $1, online = TRUE WHERE id = $2`,
        [now, row.device_id]
      );
      res.status(200).json({ ok: false, status: 'failed' });
    }
    emitChange('all');
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) });
  }
}
