/**
 * Shared contract between the seller Worker, the buyer script, and the report.
 *
 * The seller and buyer each emit one JSON record per request. Records are
 * correlated by `requestId`, which the buyer sends in the `x-bench-request-id`
 * header and the seller echoes back. The seller also returns its phase timings
 * in a `Server-Timing` header so the buyer can capture T3/T4 without a log join.
 */

/** Header the buyer sets on every request so both sides log the same id. */
export const REQUEST_ID_HEADER = "x-bench-request-id";

/** Header that asks the seller to inject a fault. Ignored unless BENCH_FAULTS_ENABLED=true. */
export const FAULT_HEADER = "x-bench-fault";

/** Faults the seller can inject. */
export const FAULTS = ["verify-block", "settle-block", "handler-500"] as const;
export type Fault = (typeof FAULTS)[number];

export function isFault(value: string | undefined | null): value is Fault {
  return value !== undefined && value !== null && (FAULTS as readonly string[]).includes(value);
}

/** Test suites from the plan. */
export const SUITES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "smoke"] as const;
export type Suite = (typeof SUITES)[number];

/**
 * The five phases from section 3 of the plan.
 *
 * T1  unpaid request -> 402 response            (buyer measures)
 * T2  client signature construction             (buyer measures via client hooks)
 * T3  POST /verify to the facilitator           (seller measures via server hooks)
 * T4  POST /settle to the facilitator           (seller measures via server hooks)
 * T5  resource delivery after settlement        (buyer: paid round trip minus T3+T4+handler)
 */
export type Phase = "T1" | "T2" | "T3" | "T4" | "T5";

/** Names used in the seller's Server-Timing header. */
export const SERVER_TIMING = {
  verify: "verify",
  settle: "settle",
  handler: "handler",
  total: "total",
} as const;

/** Emitted by the seller Worker once per request, as one JSON line. */
export interface SellerRecord {
  kind: "seller";
  v: 1;
  requestId: string;
  startedAt: string;
  method: string;
  path: string;
  colo?: string;
  hasPaymentHeader: boolean;
  fault?: Fault;
  facilitator: string;
  network: string;
  scheme?: string;
  /** Authorized amount in atomic units, from PaymentRequirements. */
  amount?: string;
  maxTimeoutSeconds?: number;
  paymentId?: string;
  payer?: string;
  verifyStartMs?: number;
  verifyEndMs?: number;
  verifyOk?: boolean;
  verifyReason?: string;
  verifyError?: string;
  settlePhase?: string;
  settleStartMs?: number;
  settleEndMs?: number;
  settleOk?: boolean;
  settleTx?: string;
  /** Actual settled amount in atomic units (differs from `amount` for upto). */
  settleAmount?: string;
  settleError?: string;
  canceledReason?: string;
  canceledStatus?: number;
  handlerMs?: number;
  totalMs?: number;
  status?: number;
  error?: string;
}

/** Parsed Server-Timing values from the seller, in milliseconds. */
export interface ServerTiming {
  verify?: number;
  settle?: number;
  handler?: number;
  total?: number;
}

/** Decoded PAYMENT-RESPONSE header, as far as the buyer needs it. */
export interface PaymentReceipt {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  amount?: string;
  errorReason?: string;
}

/** Emitted by the buyer once per logical request, as one JSON line. */
export interface BuyerRecord {
  kind: "buyer";
  v: 1;
  requestId: string;
  suite: Suite;
  test: string;
  label?: string;
  startedAt: string;
  url: string;
  path: string;
  buyer: string;
  network: string;
  scheme?: string;
  /** Authorized amount in atomic units (max for upto). */
  amount?: string;
  asset?: string;
  maxTimeoutSeconds?: number;
  paymentId?: string;
  fault?: Fault;
  /** Unpaid request -> 402 (or 200 for free routes). */
  t1Ms?: number;
  /** Client-side payment creation (signature). */
  t2Ms?: number;
  /** Paid request round trip, including seller-side verify + handler + settle. */
  paidRoundTripMs?: number;
  /** Facilitator verify, from Server-Timing. */
  t3Ms?: number;
  /** Facilitator settle, from Server-Timing. */
  t4Ms?: number;
  /** Seller handler time, from Server-Timing. */
  handlerMs?: number;
  /** paidRoundTripMs - (t3 + t4 + handler): network + Worker overhead. */
  t5Ms?: number;
  /** Whole flow as the caller experiences it. */
  totalMs: number;
  firstStatus?: number;
  finalStatus?: number;
  receipt?: PaymentReceipt;
  /** For Suite D: seconds between authorization and settlement. */
  holdSeconds?: number;
  authorizedAt?: string;
  error?: string;
  versions: Record<string, string>;
}

export type BenchRecord = SellerRecord | BuyerRecord;

/** Parse a Server-Timing header into milliseconds per metric. */
export function parseServerTiming(header: string | null | undefined): ServerTiming {
  const out: ServerTiming = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName?.trim();
    if (!name) continue;
    const dur = params
      .map((p) => p.trim())
      .find((p) => p.startsWith("dur="))
      ?.slice(4);
    if (dur === undefined) continue;
    const value = Number(dur);
    if (!Number.isFinite(value)) continue;
    if (name === "verify" || name === "settle" || name === "handler" || name === "total") {
      out[name] = value;
    }
  }
  return out;
}

export function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
