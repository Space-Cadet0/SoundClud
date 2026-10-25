/**
 * Strict, zero-`any` runtime validation primitives for SoundClud wire contracts.
 */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export type ParseResult<T> = Result<T>;

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Unwraps either a parsed JSON object or a raw JSON string into a plain object.
 */
export function unwrapJsonObject(
  input: unknown,
  context: string,
): Result<Record<string, unknown>> {
  let candidate: unknown = input;
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      candidate = parsed;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'malformed JSON';
      return err(`${context}: invalid JSON string (${detail})`);
    }
  }

  if (!isPlainObject(candidate)) {
    return err(`${context}: expected plain JSON object`);
  }

  return ok(candidate);
}

export function isHttpOrHttpsUrl(raw: string): boolean {
  if (raw.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function readString(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): Result<string> {
  const raw = obj[key];
  if (typeof raw !== 'string') {
    return err(`${context}.${key}: expected string`);
  }
  return ok(raw);
}

export function readNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): Result<string> {
  const raw = obj[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return err(`${context}.${key}: expected non-empty string`);
  }
  return ok(raw);
}

export function readHttpUrl(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): Result<string> {
  const str = readNonEmptyString(obj, key, context);
  if (!str.ok) {
    return str;
  }
  if (!isHttpOrHttpsUrl(str.value)) {
    return err(`${context}.${key}: expected valid http(s) URL`);
  }
  return str;
}

export function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  allowNull: boolean,
): Result<string | undefined> {
  if (!(key in obj)) {
    return ok(undefined);
  }
  const raw = obj[key];
  if (raw === undefined || (allowNull && raw === null)) {
    return ok(undefined);
  }
  if (typeof raw !== 'string') {
    return err(`${context}.${key}: expected optional string`);
  }
  return ok(raw);
}

export function readOptionalNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  allowNull: boolean,
): Result<string | undefined> {
  const res = readOptionalString(obj, key, context, allowNull);
  if (!res.ok || res.value === undefined) {
    return res;
  }
  if (res.value.trim().length === 0) {
    return err(`${context}.${key}: expected non-empty string when present`);
  }
  return res;
}

export function readOptionalHttpUrl(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  allowNull: boolean,
): Result<string | undefined> {
  const res = readOptionalNonEmptyString(obj, key, context, allowNull);
  if (!res.ok || res.value === undefined) {
    return res;
  }
  if (!isHttpOrHttpsUrl(res.value)) {
    return err(`${context}.${key}: expected valid http(s) URL when present`);
  }
  return res;
}

export function readBoolean(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): Result<boolean> {
  const raw = obj[key];
  if (typeof raw !== 'boolean') {
    return err(`${context}.${key}: expected boolean`);
  }
  return ok(raw);
}

export function readOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  allowNull: boolean,
): Result<boolean | undefined> {
  if (!(key in obj)) {
    return ok(undefined);
  }
  const raw = obj[key];
  if (raw === undefined || (allowNull && raw === null)) {
    return ok(undefined);
  }
  if (typeof raw !== 'boolean') {
    return err(`${context}.${key}: expected optional boolean`);
  }
  return ok(raw);
}

export function readNonNegativeNumber(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): Result<number> {
  const raw = obj[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return err(`${context}.${key}: expected finite non-negative number`);
  }
  return ok(raw);
}

export function readPositiveNumber(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): Result<number> {
  const raw = obj[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return err(`${context}.${key}: expected finite positive number`);
  }
  return ok(raw);
}

export function readNonNegativeInt(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): Result<number> {
  const raw = obj[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return err(`${context}.${key}: expected non-negative integer`);
  }
  return ok(raw);
}

export function readOptionalNonNegativeInt(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  allowNull: boolean,
): Result<number | undefined> {
  if (!(key in obj)) {
    return ok(undefined);
  }
  const raw = obj[key];
  if (raw === undefined || (allowNull && raw === null)) {
    return ok(undefined);
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return err(`${context}.${key}: expected optional non-negative integer`);
  }
  return ok(raw);
}

export function readPortNumber(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): Result<number> {
  const raw = obj[key];
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > 65535
  ) {
    return err(`${context}.${key}: expected TCP port integer in 1..65535`);
  }
  return ok(raw);
}

export function readLiteral<T extends string | number | boolean>(
  obj: Record<string, unknown>,
  key: string,
  expected: T,
  context: string,
): Result<T> {
  const raw = obj[key];
  if (raw !== expected) {
    return err(`${context}.${key}: expected literal ${String(expected)}`);
  }
  return ok(expected);
}

export function readEnum<T extends string | number>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  context: string,
): Result<T> {
  const raw = obj[key];
  for (const candidate of allowed) {
    if (raw === candidate) {
      return ok(candidate);
    }
  }
  return err(`${context}.${key}: expected one of [${allowed.join(', ')}]`);
}

export function readOptionalEnum<T extends string | number>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  context: string,
  allowNull: boolean,
): Result<T | undefined> {
  if (!(key in obj)) {
    return ok(undefined);
  }
  const raw = obj[key];
  if (raw === undefined || (allowNull && raw === null)) {
    return ok(undefined);
  }
  for (const candidate of allowed) {
    if (raw === candidate) {
      return ok(candidate);
    }
  }
  return err(`${context}.${key}: expected one of [${allowed.join(', ')}]`);
}

export function readArray<T>(
  obj: Record<string, unknown>,
  key: string,
  context: string,
  parseItem: (raw: unknown, itemContext: string) => Result<T>,
): Result<readonly T[]> {
  const raw = obj[key];
  if (!Array.isArray(raw)) {
    return err(`${context}.${key}: expected array`);
  }
  const items: T[] = [];
  for (let idx = 0; idx < raw.length; idx += 1) {
    const parsed = parseItem(raw[idx], `${context}.${key}[${String(idx)}]`);
    if (!parsed.ok) {
      return parsed;
    }
    items.push(parsed.value);
  }
  return ok(items);
}
