import type { CookieOptions } from 'express';
import type { AppConfig } from '../config/env.js';

export const SESSION_COOKIE = 'materialmule_session';

/** Reads one cookie from a raw Cookie header without a parsing dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * HttpOnly so scripts can't read it; SameSite=Lax against cross-site posts; Secure everywhere
 * except local development over plain HTTP. `expires` makes it survive a browser restart for the
 * session's (absolute) lifetime.
 */
export function sessionCookieOptions(config: AppConfig, expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.APP_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}
