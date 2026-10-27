import type { Request } from 'express';

/** The connecting address, for rate limiting. The API is reached directly on the LAN (D25). */
export function clientAddressOf(request: Pick<Request, 'socket'>): string | null {
  return request.socket.remoteAddress ?? null;
}
