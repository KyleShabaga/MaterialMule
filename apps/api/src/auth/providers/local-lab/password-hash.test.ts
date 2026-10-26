import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COST, costOf, hashPassword, verifyPassword } from './password-hash.js';

// MM-T06 T2: password hashing and verification. Passwords are generated per run.
describe('LAB password hashing', () => {
  const password = `pw-${randomBytes(12).toString('hex')}`;

  it('stores an Argon2id hash with its cost recorded and never the password', async () => {
    const stored = await hashPassword(password);
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(stored).not.toContain(password);
    expect(costOf(stored)).toEqual(DEFAULT_COST);
  });

  it('salts every hash', async () => {
    expect(await hashPassword(password)).not.toBe(await hashPassword(password));
  });

  it('verifies the right password and rejects others', async () => {
    const stored = await hashPassword(password);
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword(`${password}x`, stored)).toBe(false);
    expect(await verifyPassword(password.toUpperCase(), stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('verifies with the cost recorded in the hash, not the current default', async () => {
    const cheaper = { memory: 8192, passes: 1, parallelism: 1 };
    const stored = await hashPassword(password, cheaper);
    expect(costOf(stored)).toEqual(cheaper);
    expect(await verifyPassword(password, stored)).toBe(true);
  });

  it('treats malformed hashes as a failed verification', async () => {
    expect(await verifyPassword(password, '')).toBe(false);
    expect(await verifyPassword(password, '$2b$10$notargon')).toBe(false);
    expect(costOf('plain-text')).toBeNull();
  });
});
