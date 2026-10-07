// FU-BE-194: an idle connection ended by Postgres (restart, failover, pg_terminate_backend) makes
// pg's Pool emit 'error'. With no listener that is an uncaught exception and kills the process.
// Prisma 7's adapter-pg attaches its own listener in connect(); this pins that, so an adapter
// upgrade that drops it fails here instead of in production.
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

describe('Prisma pool idle-connection errors (FU-BE-194, NFR-09)', () => {
  it('FU-BE-194, NFR-09: an error event on the pool does not throw once the adapter is connected', async () => {
    const pool = new Pool({ connectionString: 'postgresql://u:p@127.0.0.1:1/db' });
    const seen: string[] = [];
    const adapter = await new PrismaPg(pool, { onPoolError: (e) => seen.push(e.name) }).connect();
    try {
      expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
      expect(seen).toEqual(['Error']);
    } finally {
      await adapter.dispose();
      await pool.end();
    }
  });
});
