import { bullConnection } from './bull-connection';

describe('bullConnection (BullMQ options from REDIS_URL)', () => {
  it('NFR-04: reads host, port, credentials, database and tls', () => {
    expect(bullConnection('redis://127.0.0.1:6380/2')).toEqual({
      host: '127.0.0.1',
      port: 6380,
      db: 2,
    });
    expect(bullConnection('rediss://u:p%40ss@redis.example.com')).toEqual({
      host: 'redis.example.com',
      port: 6379,
      username: 'u',
      password: 'p@ss',
      tls: {},
    });
  });

  it('NFR-04: a bad port, database or URL is refused with a message that never prints the URL', () => {
    for (const bad of [
      'redis://u:secret-pass@host:abc/0',
      'redis://u:secret-pass@host:99999',
      'redis://u:secret-pass@host:6379/x',
      'redis://u:secret-pass@host:6379/-1',
      'not a url secret-pass',
    ]) {
      let message = '';
      try {
        bullConnection(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('secret-pass');
      expect(message).not.toContain('host');
    }
  });
});
