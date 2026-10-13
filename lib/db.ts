import { Pool, QueryResult, QueryResultRow } from 'pg';

export const COMMAND_CLAIM_TTL_MS = 15 * 1000;
export const COMMAND_EXECUTION_TTL_MS = 25 * 1000;

type SeedDevice = {
  id: string;
  name: string;
  location: string;
  state: boolean;
  online: boolean;
  last_seen: number;
  pin: string;
};

export const STARTER_DEVICES: SeedDevice[] = [
  { id: 'sitting-room-bulb', name: 'Sitting Room Bulb', location: 'Sitting Room', state: false, online: true, last_seen: Date.now(), pin: 'D2' },
  { id: 'sitting-room-socket', name: 'Sitting Room Socket', location: 'Sitting Room', state: false, online: true, last_seen: Date.now(), pin: 'D5' },
  { id: 'master-bedroom-bulb', name: 'Master Bedroom Bulb', location: 'Bedroom', state: false, online: true, last_seen: Date.now(), pin: 'D6' },
  { id: 'master-bedroom-socket', name: 'Master Bedroom Socket', location: 'Bedroom', state: false, online: true, last_seen: Date.now(), pin: 'D7' },
];

let pool: Pool | null = null;

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function seedStarterDevices(db: Pool, now: number): Promise<void> {
  for (const device of STARTER_DEVICES) {
    await db.query(
      `INSERT INTO devices (id, name, location, state, online, last_seen, heartbeat_at, pin)
       VALUES ($1, $2, $3, FALSE, TRUE, $4, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [device.id, device.name, device.location, now, device.pin]
    );
  }
  await db.query(`
    UPDATE devices
    SET aliases = CASE location
      WHEN 'Sitting Room' THEN 'sitting room, living room, parlour'
      WHEN 'Bedroom' THEN 'bedroom, master bedroom'
    END
    WHERE aliases IS NULL
  `);
}

let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getPool();
      await db.query(`
        CREATE TABLE IF NOT EXISTS voice_commands (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          text TEXT NOT NULL,
          device TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at BIGINT NOT NULL,
          audio_received BOOLEAN NOT NULL DEFAULT FALSE,
          device_id TEXT,
          pin TEXT,
          room_id TEXT,
          claimed_at BIGINT,
          claimed_by TEXT,
          executed_at BIGINT,
          error TEXT
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          location TEXT NOT NULL,
          state BOOLEAN NOT NULL DEFAULT FALSE,
          online BOOLEAN NOT NULL DEFAULT TRUE,
          last_seen BIGINT NOT NULL DEFAULT 0,
          pin TEXT
        )
      `);
      await db.query(`ALTER TABLE voice_commands ADD COLUMN IF NOT EXISTS device_id TEXT`);
      await db.query(`ALTER TABLE voice_commands ADD COLUMN IF NOT EXISTS pin TEXT`);
      await db.query(`ALTER TABLE voice_commands ADD COLUMN IF NOT EXISTS room_id TEXT`);
      await db.query(`ALTER TABLE voice_commands ADD COLUMN IF NOT EXISTS claimed_at BIGINT`);
      await db.query(`ALTER TABLE voice_commands ADD COLUMN IF NOT EXISTS claimed_by TEXT`);
      await db.query(`ALTER TABLE voice_commands ADD COLUMN IF NOT EXISTS executed_at BIGINT`);
      await db.query(`ALTER TABLE voice_commands ADD COLUMN IF NOT EXISTS error TEXT`);
      await db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS aliases TEXT`);
      await db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS controller_id TEXT`);
      await db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS fw TEXT`);
      await db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS heartbeat_at BIGINT`);
      await db.query(`
        UPDATE voice_commands vc
        SET device_id = d.id
        FROM devices d
        WHERE vc.device_id IS NULL AND lower(vc.device) = lower(d.name)
      `);
      await db.query(`
        UPDATE voice_commands
        SET status = CASE
          WHEN status = 'queued' THEN 'pending'
          WHEN status = 'applied' THEN 'executed'
          ELSE status
        END
        WHERE status IN ('queued', 'applied')
      `);
      await seedStarterDevices(db, Date.now());
      await db.query(`
        UPDATE devices
        SET pin = CASE id
          WHEN 'sitting-room-bulb' THEN 'D2'
          WHEN 'sitting-room-socket' THEN 'D5'
          WHEN 'master-bedroom-bulb' THEN 'D6'
          WHEN 'master-bedroom-socket' THEN 'D7'
        END
        WHERE id IN (
          'sitting-room-bulb', 'sitting-room-socket',
          'master-bedroom-bulb', 'master-bedroom-socket'
        )
      `);
      await db.query(`DELETE FROM devices WHERE id = 'bedroom-socket'`);
      await db.query(`UPDATE devices SET heartbeat_at = last_seen WHERE heartbeat_at IS NULL`);
      await db.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'voice_commands_status_check'
          ) THEN
            ALTER TABLE voice_commands
              ADD CONSTRAINT voice_commands_status_check
              CHECK (status IN (
                'pending', 'queued', 'claimed', 'executed',
                'failed', 'expired', 'cancelled', 'unresolved'
              ));
          END IF;
        END $$;
      `);
    })();
    schemaPromise.catch(() => {
      schemaPromise = null;
    });
  }
  return schemaPromise;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as any[]);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected database error';
}

export async function expireStaleClaims(now: number = Date.now()): Promise<number> {
  const claim = await query(
    `UPDATE voice_commands SET status = 'expired'
     WHERE status IN ('pending', 'queued') AND created_at < $1`,
    [now - COMMAND_CLAIM_TTL_MS]
  );
  const execution = await query(
    `UPDATE voice_commands SET status = 'expired'
     WHERE status = 'claimed' AND created_at < $1`,
    [now - COMMAND_EXECUTION_TTL_MS]
  );
  return (claim.rowCount ?? 0) + (execution.rowCount ?? 0);
}

export async function resetAllData(): Promise<{ commands: number; devices: number }> {
  await ensureSchema();
  const db = getPool();
  const cleared = await db.query(`DELETE FROM voice_commands`);
  await db.query(`DELETE FROM devices`);
  await seedStarterDevices(db, Date.now());
  return {
    commands: cleared.rowCount ?? 0,
    devices: STARTER_DEVICES.length,
  };
}
