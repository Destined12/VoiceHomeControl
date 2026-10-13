import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSchema, errorMessage, query } from '../../../../lib/db';
import { emitChange } from '../../../../lib/events';

const CANCELLABLE_STATUSES = "'pending', 'queued'";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { commandId } = req.query;
  if (!commandId || typeof commandId !== 'string' || !/^\d+$/.test(commandId)) {
    res.status(400).json({ error: 'A valid numeric commandId is required' });
    return;
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    await ensureSchema();

    const cancelled = await query<{ status: string }>(
      `UPDATE voice_commands SET status = 'cancelled'
       WHERE id = $1 AND status IN (${CANCELLABLE_STATUSES})
       RETURNING status`,
      [commandId]
    );

    if (cancelled.rowCount && cancelled.rowCount > 0) {
      emitChange('commands');
      res.status(200).json({ ok: true, status: 'cancelled', commands: 1 });
      return;
    }

    const current = await query<{ status: string }>(
      `SELECT status FROM voice_commands WHERE id = $1`,
      [commandId]
    );
    if (current.rows.length === 0) {
      res.status(404).json({ ok: false, status: 'not_found', error: 'Command not found' });
      return;
    }

    const status = current.rows[0].status;
    if (status === 'claimed') {
      res.status(409).json({
        ok: false,
        status,
        error: 'Command already delivered to the controller; the physical action cannot be guaranteed to be prevented.',
      });
      return;
    }
    if (status === 'pending' || status === 'queued') {
      // Lost a race with a concurrent transition; report actual state.
      res.status(409).json({ ok: false, status, error: `Command is currently ${status} and could not be cancelled.` });
      return;
    }
    res.status(200).json({ ok: false, status, error: `Command is already ${status} and cannot be cancelled.` });
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) });
  }
}
