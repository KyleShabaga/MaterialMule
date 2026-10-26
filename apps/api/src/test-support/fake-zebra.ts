import { createServer, type Server, type Socket } from 'node:net';
import { formatHostStatus, HOST_STATUS_REQUEST, type HostStatus } from '../printing/host-status.js';

// A fake Zebra printer listening on raw TCP like port 9100 (TRP-T15 testing seam). It answers ~HS
// host-status queries and records the label bytes it receives. Behaviours:
//   accept — read everything, then close cleanly (a working printer)
//   hang   — accept the connection but never answer or close
//   drop   — answer status, then reset the connection after `dropAfterBytes` label bytes
// For "refused", use FakeZebraPrinter.unusedPort(): nothing listens there.

export type FakeZebraMode = 'accept' | 'hang' | 'drop';

export interface FakeZebraOptions {
  mode?: FakeZebraMode;
  /** Host status reported to ~HS (e.g. { paperOut: true }). */
  status?: Partial<HostStatus>;
  dropAfterBytes?: number;
}

export class FakeZebraPrinter {
  /** Label data received on each connection that reached the label stage, in order. */
  readonly jobs: string[] = [];
  statusQueries = 0;
  connections = 0;
  mode: FakeZebraMode;
  status: Partial<HostStatus>;
  dropAfterBytes: number;
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    options: FakeZebraOptions,
  ) {
    this.mode = options.mode ?? 'accept';
    this.status = options.status ?? {};
    this.dropAfterBytes = options.dropAfterBytes ?? 16;
    server.on('connection', (socket) => this.handle(socket));
  }

  static async start(options: FakeZebraOptions = {}): Promise<FakeZebraPrinter> {
    const server = createServer();
    const printer = new FakeZebraPrinter(server, options);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return printer;
  }

  /** A loopback port with nothing listening, so connections are refused. */
  static async unusedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  get host(): string {
    return '127.0.0.1';
  }

  get port(): number {
    return (this.server.address() as { port: number }).port;
  }

  /** Every label (^XA…^XZ) received so far, across jobs. */
  get labels(): string[] {
    return this.jobs.flatMap((job) => job.match(/\^XA[\s\S]*?\^XZ/g) ?? []);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    if (this.mode === 'hang') return;

    const mode = this.mode;
    let received = '';
    let labelStarted = false;
    let jobIndex = -1;

    socket.on('data', (chunk: Buffer) => {
      let text = chunk.toString('latin1');
      if (!labelStarted && text.startsWith(HOST_STATUS_REQUEST)) {
        this.statusQueries += 1;
        socket.write(formatHostStatus(this.status), 'latin1');
        text = text.slice(HOST_STATUS_REQUEST.length);
      }
      if (text.length === 0) return;
      if (!labelStarted) {
        labelStarted = true;
        jobIndex = this.jobs.push('') - 1;
      }
      received += text;
      if (mode === 'drop' && received.length >= this.dropAfterBytes) {
        this.jobs[jobIndex] = received.slice(0, this.dropAfterBytes);
        socket.resetAndDestroy();
        return;
      }
      this.jobs[jobIndex] = received;
    });
    socket.on('end', () => {
      socket.end();
    });
  }
}
