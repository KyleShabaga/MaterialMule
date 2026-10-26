// The parts of autocannon 8 (MIT) the benchmark uses. autocannon ships no type declarations.
declare module 'autocannon' {
  import type { EventEmitter } from 'node:events';

  export type RequestContext = Record<string, unknown>;

  export interface AutocannonRequest {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    setupRequest?: (request: AutocannonRequest, context: RequestContext) => AutocannonRequest;
    onResponse?: (
      status: number,
      body: string,
      context: RequestContext,
      headers: Record<string, string>,
    ) => void;
  }

  export interface AutocannonOptions {
    url: string;
    connections?: number;
    /** Seconds. */
    duration?: number;
    /** Requests per second per connection. */
    connectionRate?: number;
    /** Seconds. */
    timeout?: number;
    headers?: Record<string, string>;
    requests?: AutocannonRequest[];
    excludeErrorStats?: boolean;
  }

  export interface AutocannonResult {
    requests: { total: number; average: number };
    errors: number;
    timeouts: number;
    non2xx: number;
    duration: number;
    statusCodeStats?: Record<string, { count: number }>;
  }

  export interface AutocannonInstance extends EventEmitter {
    stop(): void;
  }

  function autocannon(
    options: AutocannonOptions,
    callback: (error: Error | null, result: AutocannonResult) => void,
  ): AutocannonInstance;

  export default autocannon;
}
