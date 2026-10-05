const encoder = new TextEncoder();

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Import the per-session key (base64, issued by the API at start) as a non-extractable HMAC key. */
export function importSessionKey(keyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromBase64(keyBase64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** HMAC-SHA256 of the UTF-8 bytes of `message`, lowercase hex (32 bytes, 64 chars). */
export async function signHex(key: CryptoKey, message: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}
