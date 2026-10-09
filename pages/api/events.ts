import type { NextApiRequest, NextApiResponse } from 'next';
import { events } from '../../lib/events';

export const config = {
  api: {
    bodyParser: false,
  },
};

const PING_INTERVAL_MS = 15000;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'CONNECTED' });

  const onChange = (payload: unknown) => send(payload);
  events.on('change', onChange);

  const pingTimer = setInterval(() => {
    res.write(': ping\n\n');
  }, PING_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(pingTimer);
    events.off('change', onChange);
    res.end();
  });
}
