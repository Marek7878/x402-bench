/** Worker bindings. Values come from wrangler.jsonc `vars`, `.dev.vars`, or `wrangler secret`. */
export interface Env {
  /** Facilitator base URL. Public testnet facilitator by default. */
  FACILITATOR_URL: string;
  /**
   * Which facilitator to use: "public" (default, FACILITATOR_URL) or "cdp". Explicit rather than
   * inferred from credentials, because which facilitator produced a result is the biggest caveat
   * on every throughput and reliability number in the report.
   */
  FACILITATOR_PROVIDER?: string;
  /** CDP Secret API Key id. Needed only when FACILITATOR_PROVIDER=cdp. Secret, never committed. */
  CDP_API_KEY_ID?: string;
  /** CDP Secret API Key secret (Ed25519). Signs a fresh JWT per facilitator call. */
  CDP_API_KEY_SECRET?: string;
  /** Optional static auth header name. Works for a bearer-token facilitator, but not CDP. */
  FACILITATOR_AUTH_HEADER?: string;
  /** Optional auth header value for the facilitator. */
  FACILITATOR_AUTH_VALUE?: string;
  /** Per-call timeout for verify/settle/supported, in ms. SDK default is 30000. */
  FACILITATOR_TIMEOUT_MS?: string;
  /** CAIP-2 network id, e.g. eip155:84532. */
  NETWORK: string;
  /** Seller wallet address. Secret. */
  PAY_TO: string;
  /** Dollar-string price for exact routes, e.g. "$0.001". */
  EXACT_PRICE: string;
  /** Validity window for exact authorizations, in seconds. */
  EXACT_MAX_TIMEOUT_SECONDS: string;
  /** Dollar-string maximum for the upto route, e.g. "$0.01". */
  UPTO_MAX_PRICE: string;
  /** Validity window for upto authorizations, in seconds. Drives Suite D. */
  UPTO_MAX_TIMEOUT_SECONDS: string;
  /** "true" to call /supported on the first paid request. */
  SYNC_FACILITATOR_ON_START?: string;
  /** "true" to honour the x-bench-fault header. */
  BENCH_FAULTS_ENABLED?: string;
}

export function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

export function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function requireEnv(env: Env): void {
  const missing = (["FACILITATOR_URL", "NETWORK", "PAY_TO", "EXACT_PRICE", "UPTO_MAX_PRICE"] as const).filter(
    (k) => !env[k],
  );
  if (missing.length > 0) {
    throw new Error(`Missing seller configuration: ${missing.join(", ")}. See wrangler.jsonc and .dev.vars.example.`);
  }
}
