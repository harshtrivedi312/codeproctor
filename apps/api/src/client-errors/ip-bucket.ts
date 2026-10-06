import { isIPv6 } from 'node:net';

/**
 * The throttle key for a client address: IPv4 as is, an IPv4-mapped IPv6 address as its IPv4,
 * and any other IPv6 address as its /64, so one host with a whole /64 cannot take a bucket per
 * address.
 */
export function ipBucket(ip: string | undefined): string {
  if (ip === undefined || ip === '') return 'unknown';
  const addr = ip.split('%')[0] ?? ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!isIPv6(addr)) return addr;
  const [headRaw = '', tailRaw] = addr.split('::');
  const head = headRaw === '' ? [] : headRaw.split(':');
  const tail = tailRaw === undefined || tailRaw === '' ? [] : tailRaw.split(':');
  const fill = tailRaw === undefined ? 0 : Math.max(0, 8 - head.length - tail.length);
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().padStart(4, '0'))
    .join(':')}::/64`;
}
