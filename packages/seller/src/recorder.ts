import type { MiddlewareHandler } from "hono";
import {
  FAULT_HEADER,
  REQUEST_ID_HEADER,
  SERVER_TIMING,
  isFault,
  round,
  type Fault,
  type SellerRecord,
} from "@x402-bench/shared";
import { currentRecord } from "./faults.ts";

/**
 * In-flight records for this isolate, keyed by request id. Entries live only for
 * the duration of one request; the payment hooks look them up through the
 * transport context that @x402/core passes to every hook.
 */
const inflight = new Map<string, SellerRecord>();

interface RecorderOptions {
  facilitatorUrl: string;
  network: string;
  faultsEnabled: boolean;
}

/** Extract the bench record for the request behind an x402 hook context. */
export function recordFromTransport(transportContext: unknown): SellerRecord | undefined {
  const ctx = transportContext as
    | { request?: { adapter?: { getHeader?: (name: string) => string | undefined } } }
    | undefined;
  const id = ctx?.request?.adapter?.getHeader?.(REQUEST_ID_HEADER);
  return id ? inflight.get(id) : undefined;
}

export function now(): number {
  return performance.now();
}

/**
 * Outermost middleware. Creates the record, times the whole request, and after the
 * payment middleware has finished (including settlement) attaches a Server-Timing
 * header and prints the record as one JSON line for Workers Logs / wrangler tail.
 */
export function benchRecorder(opts: RecorderOptions): MiddlewareHandler {
  return async (c, next) => {
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? crypto.randomUUID();
    const requestedFault = c.req.header(FAULT_HEADER);
    const fault: Fault | undefined = opts.faultsEnabled && isFault(requestedFault) ? requestedFault : undefined;
    const cf = (c.req.raw as Request & { cf?: { colo?: string } }).cf;

    const rec: SellerRecord = {
      kind: "seller",
      v: 1,
      requestId,
      startedAt: new Date().toISOString(),
      method: c.req.method,
      path: c.req.path,
      colo: cf?.colo,
      hasPaymentHeader: Boolean(c.req.header("payment-signature") ?? c.req.header("x-payment")),
      fault,
      facilitator: opts.facilitatorUrl,
      network: opts.network,
    };
    inflight.set(requestId, rec);
    const t0 = now();

    try {
      // The record travels in AsyncLocalStorage as well as the inflight map: the
      // facilitator wrapper in faults.ts has no transport context to look it up with.
      await currentRecord.run(rec, next);
    } catch (err) {
      rec.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw err;
    } finally {
      rec.totalMs = round(now() - t0);
      rec.status = c.res?.status;
      // Handler time is the gap between verify finishing and settlement starting
      // (after-handler flow). It includes the middleware buffering the body.
      if (rec.verifyEndMs !== undefined && rec.settleStartMs !== undefined) {
        rec.handlerMs = round(rec.settleStartMs - rec.verifyEndMs);
      }
      attachTimingHeaders(c.res, rec);
      // Normalise the internal clock values to durations before emitting.
      const emitted = {
        ...rec,
        verifyMs: duration(rec.verifyStartMs, rec.verifyEndMs),
        settleMs: duration(rec.settleStartMs, rec.settleEndMs),
      };
      delete (emitted as Partial<SellerRecord>).verifyStartMs;
      delete (emitted as Partial<SellerRecord>).verifyEndMs;
      delete (emitted as Partial<SellerRecord>).settleStartMs;
      delete (emitted as Partial<SellerRecord>).settleEndMs;
      console.log(JSON.stringify(emitted));
      inflight.delete(requestId);
    }
  };
}

function duration(start?: number, end?: number): number | undefined {
  return start !== undefined && end !== undefined ? round(end - start) : undefined;
}

function attachTimingHeaders(res: Response | undefined, rec: SellerRecord): void {
  if (!res) return;
  const parts: string[] = [];
  const verify = duration(rec.verifyStartMs, rec.verifyEndMs);
  const settle = duration(rec.settleStartMs, rec.settleEndMs);
  if (verify !== undefined) parts.push(`${SERVER_TIMING.verify};dur=${verify}`);
  if (settle !== undefined) parts.push(`${SERVER_TIMING.settle};dur=${settle}`);
  if (rec.handlerMs !== undefined) parts.push(`${SERVER_TIMING.handler};dur=${rec.handlerMs}`);
  if (rec.totalMs !== undefined) parts.push(`${SERVER_TIMING.total};dur=${rec.totalMs}`);
  try {
    res.headers.set(REQUEST_ID_HEADER, rec.requestId);
    if (parts.length > 0) res.headers.set("Server-Timing", parts.join(", "));
  } catch {
    // Immutable headers (e.g. a passthrough Response). Timing is still in the log line.
  }
}
