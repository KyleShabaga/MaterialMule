import { Controller, Get, Headers, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ActiveUser } from '../auth/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { loadActivePersonPhoto } from './person-photo.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `If-None-Match` names `etag` (a list, weak validators, or `*`). */
function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag);
}

/**
 * Directory photos (STRATA-52). Any active session, LAB included (stations show people's avatars),
 * reads the photo the host cached at that person's sign-in or profile refresh. This route never
 * talks to Microsoft Graph. 404 `no_photo` when there is none or the person isn't active (pending
 * or disabled), so the browser shows initials.
 */
@Controller()
export class PeopleController {
  constructor(private readonly database: DatabaseService) {}

  @Get('people/:userId/photo')
  @ActiveUser()
  async photo(
    @Param('userId') userId: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const photo = UUID_PATTERN.test(userId)
      ? await loadActivePersonPhoto(this.database.pool, userId)
      : null;
    if (!photo) throw new NotFoundException({ code: 'no_photo' });
    const etag = `"${photo.sha256}"`;
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.setHeader('ETag', etag);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (matchesEtag(ifNoneMatch, etag)) {
      response.status(304).end();
      return;
    }
    response.setHeader('Content-Type', photo.contentType);
    response.setHeader('Content-Length', String(photo.bytes.length));
    response.status(200).end(photo.bytes);
  }
}
