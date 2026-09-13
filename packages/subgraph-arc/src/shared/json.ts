import { BigInt, JSONValue, JSONValueKind, TypedMap } from '@graphprotocol/graph-ts';

// Registration and feedback documents (see ./registration.ts and
// ./feedback-document.ts) come from `data:` URIs that agents and clients
// control entirely. Every accessor here checks `kind` before calling the
// matching `JSONValue.toX()` so a malformed or adversarial document can only
// ever produce a null/empty result, never abort the handler. Prefer these
// over calling `JSONValue` methods directly when reading untrusted JSON.

export function asObject(value: JSONValue | null): TypedMap<string, JSONValue> | null {
  if (value == null || value.isNull() || value.kind != JSONValueKind.OBJECT) return null;
  return value.toObject();
}

export function asArray(value: JSONValue | null): Array<JSONValue> {
  if (value == null || value.isNull() || value.kind != JSONValueKind.ARRAY) return [];
  return value.toArray();
}

/** Reads an array of JSON objects, silently dropping any element that is not itself an object. */
export function asObjectArray(value: JSONValue | null): Array<TypedMap<string, JSONValue>> {
  const items = asArray(value);
  const out: TypedMap<string, JSONValue>[] = [];
  for (let i = 0; i < items.length; i++) {
    const obj = asObject(items[i]);
    if (obj == null) continue;
    out.push(obj);
  }
  return out;
}

export function asString(value: JSONValue | null): string | null {
  if (value == null || value.isNull() || value.kind != JSONValueKind.STRING) return null;
  return value.toString();
}

// AssemblyScript primitives (`bool`, `i32`) cannot be part of a nullable
// union, unlike reference types such as `BigInt` or `string`. `JsonBool` and
// `JsonI32` carry a `present` flag instead so "absent" and "present but
// false/zero" stay distinguishable.
export class JsonBool {
  present: boolean;
  value: boolean;
  constructor(present: boolean, value: boolean) {
    this.present = present;
    this.value = value;
  }
}

export class JsonI32 {
  present: boolean;
  value: i32;
  constructor(present: boolean, value: i32) {
    this.present = present;
    this.value = value;
  }
}

export function asBool(value: JSONValue | null): JsonBool {
  if (value == null || value.isNull() || value.kind != JSONValueKind.BOOL) {
    return new JsonBool(false, false);
  }
  return new JsonBool(true, value.toBool());
}

export function asStringArray(value: JSONValue | null): Array<string> {
  const items = asArray(value);
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = asString(items[i]);
    if (item == null) continue;
    out.push(item!);
  }
  return out;
}

/**
 * Reads a JSON number as a non-negative whole `BigInt`, e.g. for an
 * `agentId`. JSON numbers may contain fractions or exponents, and
 * `JSONValue.toBigInt()` traps on non-integer text, so this always goes
 * through `toF64()` first: any value already lexed as a JSON number can
 * safely become an `f64`, and only a verified whole number is then
 * formatted back to a decimal string for `BigInt.fromString`.
 */
export function asWholeBigInt(value: JSONValue | null): BigInt | null {
  if (value == null || value.isNull() || value.kind != JSONValueKind.NUMBER) return null;

  const asFloat = value.toF64();
  // `asFloat as i64` below traps at 2^63 and above, +Inf included.
  if (asFloat < 0 || asFloat != Math.floor(asFloat) || asFloat >= 9223372036854775808.0)
    return null;

  // `f64.toString()` renders whole numbers as e.g. "241.0", which
  // `BigInt.fromString` rejects. `f64` only carries 53 bits of integer
  // precision anyway, so round-tripping through `i64` loses nothing that
  // wasn't already lost by going through `toF64()`.
  return BigInt.fromString((asFloat as i64).toString());
}

/** Reads a JSON number as a whole `i32` within `[min, max]`, e.g. for a decimals count. */
export function asWholeI32(value: JSONValue | null, min: i32, max: i32): JsonI32 {
  if (value == null || value.isNull() || value.kind != JSONValueKind.NUMBER)
    return new JsonI32(false, 0);

  const asFloat = value.toF64();
  if (asFloat != Math.floor(asFloat)) return new JsonI32(false, 0);

  // Range-check in f64 before casting: `asFloat as i32` traps outside
  // ±2^31, and min/max are i32 values themselves, so anything within
  // [min, max] casts safely.
  if (asFloat < (min as f64) || asFloat > (max as f64)) return new JsonI32(false, 0);
  return new JsonI32(true, asFloat as i32);
}

/** Reads a value that the 8004scan profile sometimes quotes and sometimes leaves as a bare number (e.g. a payment `chainId`). */
export function asStringOrNumber(value: JSONValue | null): string | null {
  const asStringValue = asString(value);
  if (asStringValue != null) return asStringValue;

  const asNumber = asWholeBigInt(value);
  if (!asNumber) return null;
  return asNumber.toString();
}

/** A scalar or best-effort JSON-text rendering of a `JSONValue`, with its matching `AgentServiceAttributeType` enum value. */
export class JsonValueDescription {
  value: string;
  valueType: string;
  constructor(value: string, valueType: string) {
    this.value = value;
    this.valueType = valueType;
  }
}

/**
 * Describes an arbitrary JSON value as a string plus its scalar type, for
 * storing custom/unrecognized fields (see `AgentServiceAttribute` in
 * schema.graphql). Arrays and objects fall back to a compact JSON
 * rendering rather than being rejected.
 */
export function describeJsonValue(value: JSONValue): JsonValueDescription {
  if (value.kind == JSONValueKind.STRING)
    return new JsonValueDescription(value.toString(), 'STRING');
  if (value.kind == JSONValueKind.BOOL) {
    return new JsonValueDescription(value.toBool() ? 'true' : 'false', 'BOOLEAN');
  }
  if (value.kind == JSONValueKind.NUMBER)
    return new JsonValueDescription(numberToText(value), 'NUMBER');
  return new JsonValueDescription(toJsonText(value), 'JSON');
}

function toJsonText(value: JSONValue): string {
  if (value.kind == JSONValueKind.NULL) return 'null';
  if (value.kind == JSONValueKind.BOOL) return value.toBool() ? 'true' : 'false';
  if (value.kind == JSONValueKind.STRING) return quoteJsonString(value.toString());
  if (value.kind == JSONValueKind.NUMBER) return numberToText(value);

  if (value.kind == JSONValueKind.ARRAY) {
    const items = value.toArray();
    let out = '[';
    for (let i = 0; i < items.length; i++) {
      if (i > 0) out += ',';
      out += toJsonText(items[i]);
    }
    return out + ']';
  }

  const obj = value.toObject();
  let out = '{';
  for (let i = 0; i < obj.entries.length; i++) {
    if (i > 0) out += ',';
    out += quoteJsonString(obj.entries[i].key) + ':' + toJsonText(obj.entries[i].value);
  }
  return out + '}';
}

function quoteJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c == '"' || c == '\\') out += '\\' + c;
    else if (c == '\n') out += '\\n';
    else out += c;
  }
  return out + '"';
}

function numberToText(value: JSONValue): string {
  const asFloat = value.toF64();
  // `asFloat as i64` traps outside ±2^63; whole values beyond that range
  // (and ±Inf) fall through to the exponent-form `f64` rendering.
  if (
    asFloat >= -9223372036854775808.0 &&
    asFloat < 9223372036854775808.0 &&
    asFloat == Math.floor(asFloat)
  )
    return (asFloat as i64).toString();
  return asFloat.toString();
}

/** Validates that `value` is a plain decimal number, safe to pass to `BigDecimal.fromString`. */
export function isDecimalString(value: string): boolean {
  if (value.length == 0) return false;

  let index = value.charAt(0) == '-' ? 1 : 0;
  if (index >= value.length) return false;

  let sawDigit = false;
  let sawDot = false;
  for (; index < value.length; index++) {
    const c = value.charAt(index);
    if (c == '.') {
      if (sawDot) return false;
      sawDot = true;
      continue;
    }
    if (c < '0' || c > '9') return false;
    sawDigit = true;
  }
  return sawDigit;
}
