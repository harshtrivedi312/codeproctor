// S3: a connected but hanging Redis fails a command at HEALTH_TIMEOUT_MS instead of holding the
// callers (and the DB row locks of the disable, reset and role-change transactions) for longer.
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { TokenValidityService } from '../common/auth/token-validity.service';
import { InfrastructureModule, REDIS_CLIENT } from './infrastructure.module';

describe('Redis command timeout (FR-104, NFR-09)', () => {
  let server: Server;
  const sockets: Socket[] = [];
  let redis: Redis;

  beforeAll(async () => {
    // Accepts the connection and never answers: a black-holed Redis.
    server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              REDIS_URL: `redis://127.0.0.1:${port}`,
              DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/z',
              HEALTH_TIMEOUT_MS: 300,
            }),
          ],
        }),
        InfrastructureModule,
      ],
    }).compile();
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
    await redis.connect().catch(() => undefined);
  });

  afterAll(async () => {
    redis.disconnect();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('FR-104: a command to a hanging Redis rejects within the timeout, and the marker check is a 503', async () => {
    const validity = new TokenValidityService(redis);
    const started = Date.now();
    await expect(validity.isFresh('u', 1)).rejects.toThrow(ServiceUnavailableException);
    expect(Date.now() - started).toBeLessThan(2000);
    const started2 = Date.now();
    await expect(validity.invalidateIssuedTokens('u')).rejects.toThrow(ServiceUnavailableException);
    expect(Date.now() - started2).toBeLessThan(2000);
  });
});
