/**
 * Portable standard Base64 for a UTF-8 string: node `Buffer` when present,
 * browser/edge `btoa` otherwise. One copy — the ARCA QR and the ERC-8004
 * registration `data:` URI both encode JSON this way.
 */
export function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of `toBase64` for a UTF-8 payload. */
export function fromBase64(input: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(input, 'base64').toString('utf8');
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
