import * as crypto from 'crypto';

export function generateQRCode(seed: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${seed}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`)
    .digest('hex');

  const code = hash.slice(0, 12).toUpperCase();
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}
