import { hash } from '@node-rs/argon2';
import { ARGON2_OPTIONS, PasswordService } from './password.service';

describe('PasswordService timing parity (FR-101, FU-BE-30)', () => {
  it('FR-101: the dummy hash is computed at startup with the same parameters as real hashes', async () => {
    const service = new PasswordService();
    const spy = jest.spyOn(service, 'hash');
    await service.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    const dummy = (await spy.mock.results[0]?.value) as string;
    const real = await hash('Correct-Horse-9', ARGON2_OPTIONS);
    const params = (h: string): string => h.split('$').slice(1, 4).join('$');
    expect(params(dummy)).toBe(params(real));
    expect(params(real)).toBe('argon2id$v=19$m=19456,t=2,p=1');

    // burn() reuses the precomputed hash instead of hashing again.
    await service.burn('whatever');
    await service.burn('whatever');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
