import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time match; hashing first hides the expected secret's length. An unset or empty secret never matches. */
export function secretMatches(candidate: string | undefined, expected: string | undefined) {
  if (!expected || candidate === undefined) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function bearerMatches(authorization: string | undefined, expected: string | undefined) {
  return Boolean(authorization?.startsWith('Bearer ')) && secretMatches(authorization!.slice('Bearer '.length), expected);
}
