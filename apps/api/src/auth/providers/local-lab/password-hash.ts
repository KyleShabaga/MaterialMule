import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// Argon2id via Node's built-in implementation (no native add-on to build on Windows). Each hash is
// stored as a PHC string that records its own cost, e.g.
//   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
// so the cost can be raised later without invalidating existing passwords.

export interface Argon2Cost {
  /** Memory in KiB. */
  memory: number;
  /** Iterations. */
  passes: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet minimum for Argon2id (19 MiB, 2 iterations, 1 lane). */
export const DEFAULT_COST: Argon2Cost = { memory: 19_456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const VERSION = 19;
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,})\$([A-Za-z0-9+/]{16,})$/;

function derive(password: string, salt: Buffer, cost: Argon2Cost, tagLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory: cost.memory,
        passes: cost.passes,
        parallelism: cost.parallelism,
        tagLength,
      },
      (error, key) => (error ? reject(error) : resolve(Buffer.from(key))),
    );
  });
}

const b64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

/** Hashes a password with a random salt. The result never contains the password. */
export async function hashPassword(password: string, cost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, cost, TAG_BYTES);
  return `$argon2id$v=${VERSION}$m=${cost.memory},t=${cost.passes},p=${cost.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** The cost recorded in a stored hash, or null when it isn't a hash this module wrote. */
export function costOf(stored: string): Argon2Cost | null {
  const match = PHC_PATTERN.exec(stored);
  return match
    ? { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]) }
    : null;
}

/** Constant-time check of `password` against a stored PHC string. False for malformed hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = PHC_PATTERN.exec(stored);
  if (!match) {
    return false;
  }
  const cost = costOf(stored)!;
  const salt = Buffer.from(match[4]!, 'base64');
  const expected = Buffer.from(match[5]!, 'base64');
  const actual = await derive(password, salt, cost, expected.length);
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same work as a real verification, so an unknown username or a missing password
 * answers in about the same time as a wrong password.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
}
