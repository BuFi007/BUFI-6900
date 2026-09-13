// graph-ts has no built-in base64 support, so `data:` URI decoding (see
// ./uri.ts) needs a manual decoder. AssemblyScript's `String.UTF8.decode`
// turns the resulting bytes into the JSON text once they are extracted.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes a base64 string to raw bytes. Returns null on invalid input. */
export function base64Decode(input: string): Uint8Array | null {
  const cleaned = withoutWhitespace(input);

  let significantLength = cleaned.length;
  while (significantLength > 0 && cleaned.charAt(significantLength - 1) == '=') significantLength--;
  if (significantLength == 0) return new Uint8Array(0);

  const bytes: u8[] = [];
  let position = 0;
  while (position < significantLength) {
    const chunkLength = significantLength - position < 4 ? significantLength - position : 4;

    let buffer = 0;
    for (let i = 0; i < chunkLength; i++) {
      const value = ALPHABET.indexOf(cleaned.charAt(position + i));
      if (value < 0) return null;
      buffer = (buffer << 6) | value;
    }

    // Left-align an incomplete final chunk to a full 24-bit frame so the byte
    // extraction below always reads from the same bit positions.
    const chunkBits = chunkLength * 6;
    buffer = buffer << (24 - chunkBits);

    const byteCount = chunkBits / 8;
    for (let i = 0; i < byteCount; i++) {
      bytes.push(((buffer >> (16 - i * 8)) & 0xff) as u8);
    }

    position += chunkLength;
  }

  const output = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) output[i] = bytes[i];
  return output;
}

/** Decodes a base64 string as UTF-8 text. Returns null on invalid input. */
export function base64DecodeToString(input: string): string | null {
  const bytes = base64Decode(input);
  if (bytes == null) return null;
  return String.UTF8.decode(bytes.buffer);
}

function withoutWhitespace(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isWhitespace = code == 0x20 || code == 0x09 || code == 0x0a || code == 0x0d;
    if (!isWhitespace) out += value.charAt(i);
  }
  return out;
}
