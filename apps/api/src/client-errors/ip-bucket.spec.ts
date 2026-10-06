import { ipBucket } from './ip-bucket';

describe('ipBucket (C-32)', () => {
  it('C-32: IPv4 and mapped IPv4 are kept as the IPv4', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('C-32: IPv6 addresses in one /64 share a bucket, others do not', () => {
    const a = ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(ipBucket('2001:db8:1:2::1')).toBe(a);
    expect(ipBucket('2001:DB8:1:2:ffff::')).toBe(a);
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(a);
    expect(ipBucket('::1')).toBe('0000:0000:0000:0000::/64');
  });

  it('C-32: a missing address gets one shared bucket', () => {
    expect(ipBucket(undefined)).toBe('unknown');
  });
});
