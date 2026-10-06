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
    // A hanging Redis: connected, then silent.
    // It answers only the INFO of the connection handshake, so the client is ready, and then goes
    // silent for every command.
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('data', (chunk) => {
        // One RESP array per command: answer the handshake, stay silent for the commands under test.
        for (const command of chunk.toString().split(/(?=\*\d+\r\n\$)/)) {
          const lower = command.toLowerCase();
          if (command.length === 0 || /\r\n(get|set|eval)\r\n/.test(lower)) continue;
          if (lower.includes('info')) {
            const body = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
            socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
          } else {
            socket.write('+OK\r\n');
          }
        }
      });
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
    await redis.connect();
  });

  afterAll(async () => {
    redis.disconnect();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('FR-104: a raw command to a hanging Redis rejects with a timeout error', async () => {
    const started = Date.now();
    await expect(redis.get('anything')).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
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
