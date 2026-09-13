import { base64DecodeToString } from './base64';

// Mirrors the `URIKind` enum in schema.graphql. Handlers store this string
// directly on entities (AssemblyScript represents GraphQL enums as strings).
export const URI_KIND_NONE = 'NONE';
export const URI_KIND_DATA = 'DATA';
export const URI_KIND_IPFS = 'IPFS';
export const URI_KIND_ARWEAVE = 'ARWEAVE';
export const URI_KIND_HTTPS = 'HTTPS';
export const URI_KIND_HTTP = 'HTTP';
export const URI_KIND_OTHER = 'OTHER';

/** Classifies a URI by scheme, matching the `URIKind` enum in schema.graphql. */
export function classifyUri(uri: string): string {
  if (uri.length == 0) return URI_KIND_NONE;

  const lower = uri.toLowerCase();
  if (lower.startsWith('data:')) return URI_KIND_DATA;
  if (lower.startsWith('ipfs://')) return URI_KIND_IPFS;
  if (lower.startsWith('ar://')) return URI_KIND_ARWEAVE;
  if (lower.startsWith('https://')) return URI_KIND_HTTPS;
  if (lower.startsWith('http://')) return URI_KIND_HTTP;
  return URI_KIND_OTHER;
}

/**
 * Decodes a `data:` URI's payload to its raw text (expected to be JSON).
 * Returns null when `uri` is not a `data:` URI or the payload cannot be
 * decoded. Percent-encoded plain payloads are not unescaped: real-world
 * `data:application/json,...` URIs observed by the 8004scan profile carry
 * raw JSON, and AssemblyScript has no built-in `decodeURIComponent`.
 */
export function decodeDataUri(uri: string): string | null {
  if (!uri.toLowerCase().startsWith('data:')) return null;

  const rest = uri.slice(5);
  const commaIndex = rest.indexOf(',');
  if (commaIndex < 0) return null;

  const meta = rest.slice(0, commaIndex);
  const payload = rest.slice(commaIndex + 1);

  // Some producers label a payload `;base64` while actually inlining plain
  // JSON. Detect that edge case before trusting the label, per the 8004scan
  // parsing guidance.
  const looksLikePlainJson = payload.startsWith('{') || payload.startsWith('[');
  if (hasBase64Marker(meta) && !looksLikePlainJson) {
    return base64DecodeToString(payload);
  }

  return payload;
}

function hasBase64Marker(meta: string): boolean {
  const segments = meta.split(';');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].toLowerCase() == 'base64') return true;
  }
  return false;
}
