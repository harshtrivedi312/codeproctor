import { isIPv6 } from 'node:net';

/**
 * The throttle key for a client address: IPv4 as is, an IPv4-mapped IPv6 address as its IPv4,
 * and any other IPv6 address as its /64, so one host with a whole /64 cannot take a bucket per
 * address.
 */
export function ipBucket(ip: string | undefined): string {
  if (ip === undefined || ip === '') return 'unknown';
  const addr = ip.split('%')[0] ?? ip;
  const dotted =
    /^(?:0{1,4}:){5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$|^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  const v4 = dotted?.[1] ?? dotted?.[2];
  if (v4 !== undefined) return v4;
  const hex = /^(?:(?:0{1,4}:){5}|::)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
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
