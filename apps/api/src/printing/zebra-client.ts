import { connect } from 'node:net';
import {
  HOST_STATUS_REQUEST,
  HostStatusFormatError,
  hostStatusProblem,
  parseHostStatus,
} from './host-status.js';

/** Where to send labels. Always comes from server-side printer configuration. */
export interface PrinterTarget {
  host: string;
  port: number;
  /** Ask for host status (~HS) before sending, and don't send if the printer reports a problem. */
  checkStatus: boolean;
}

/**
 * What happened to one send, judged only by what the connection proves:
 * - `sent`: every byte was written and the connection closed cleanly;
 * - `not_sent`: no label byte left this process (refused, timed out, printer reported a
 *   problem), so an automatic retry can't print twice;
 * - `uncertain`: label bytes may have reached the printer but the outcome is unknown, so only a
 *   person may decide to resend.
 */
export type SendOutcome =
  | { result: 'sent' }
  | { result: 'not_sent'; error: string; printerMessage: string | null }
  | { result: 'uncertain'; error: string };

/** Testing seam: the worker only depends on this. */
export interface PrinterTransport {
  send(target: PrinterTarget, payload: string): Promise<SendOutcome>;
}

export interface ZebraTcpOptions {
  connectTimeoutMs: number;
  statusTimeoutMs: number;
  /** From the first label byte to the printer closing the connection. */
  sendTimeoutMs: number;
}

export const DEFAULT_ZEBRA_TCP_OPTIONS: ZebraTcpOptions = {
  connectTimeoutMs: 5_000,
  statusTimeoutMs: 3_000,
  sendTimeoutMs: 20_000,
};

function describeSocketError(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return 'Printer refused the connection';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Printer is not reachable on the network';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Printer host name not found';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'Printer dropped the connection';
    case 'ETIMEDOUT':
      return 'Printer did not respond';
    default:
      return `Printer connection error (${error.code ?? 'unknown'})`;
  }
}

/** Raw TCP (port 9100) client for Zebra printers. */
export class ZebraTcpTransport implements PrinterTransport {
  constructor(private readonly options: ZebraTcpOptions = DEFAULT_ZEBRA_TCP_OPTIONS) {}

  send(target: PrinterTarget, payload: string): Promise<SendOutcome> {
    const { connectTimeoutMs, statusTimeoutMs, sendTimeoutMs } = this.options;
    return new Promise<SendOutcome>((resolve) => {
      // Phases before 'sending' have written no label byte; from 'sending' on, any doubt is
      // uncertain.
      let phase: 'connecting' | 'status' | 'sending' | 'flushed' = 'connecting';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let statusResponse = '';

      const socket = connect({ host: target.host, port: target.port });
      socket.setNoDelay(true);

      const finish = (outcome: SendOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(outcome);
      };
      const notSent = (error: string, printerMessage: string | null = null) =>
        finish({ result: 'not_sent', error, printerMessage });
      const uncertain = (error: string) => finish({ result: 'uncertain', error });
      const labelBytesMayHaveLeft = () => phase === 'sending' || phase === 'flushed';

      const startSending = () => {
        clearTimeout(timer);
        phase = 'sending';
        timer = setTimeout(
          () => uncertain('Printer stopped responding while receiving labels'),
          sendTimeoutMs,
        );
        // end() writes everything, then half-closes; the callback runs once it is all flushed.
        socket.end(payload, () => {
          if (phase === 'sending') phase = 'flushed';
        });
      };

      timer = setTimeout(
        () => notSent("Printer didn't respond (connection timed out)"),
        connectTimeoutMs,
      );

      socket.once('connect', () => {
        clearTimeout(timer);
        if (!target.checkStatus) {
          startSending();
          return;
        }
        phase = 'status';
        timer = setTimeout(
          () => notSent("Printer didn't answer the status check"),
          statusTimeoutMs,
        );
        socket.write(HOST_STATUS_REQUEST);
      });

      socket.on('data', (chunk: Buffer) => {
        if (phase !== 'status') return;
        statusResponse += chunk.toString('latin1');
        let status;
        try {
          status = parseHostStatus(statusResponse);
        } catch (error) {
          if (error instanceof HostStatusFormatError) {
            notSent('Printer sent an unexpected status response');
            return;
          }
          throw error;
        }
        if (!status) return;
        const problem = hostStatusProblem(status);
        if (problem) {
          notSent(problem, problem);
        } else {
          startSending();
        }
      });

      socket.on('error', (error: NodeJS.ErrnoException) => {
        const message = describeSocketError(error);
        if (labelBytesMayHaveLeft()) {
          uncertain(`${message} while receiving labels`);
        } else {
          notSent(message);
        }
      });

      socket.on('close', (hadError) => {
        if (settled) return;
        if (phase === 'flushed' && !hadError) {
          finish({ result: 'sent' });
        } else if (labelBytesMayHaveLeft()) {
          uncertain('Connection closed before the printer received every label');
        } else {
          notSent('Printer closed the connection');
        }
      });
    });
  }
}
