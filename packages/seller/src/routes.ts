import type { PaymentOption, RoutesConfig } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import { PAYMENT_IDENTIFIER, declarePaymentIdentifierExtension } from "@x402/extensions/payment-identifier";
import { int, type Env } from "./env.ts";

/**
 * Route table for the paid endpoints. One route per scheme or behaviour under test.
 *
 * | Route            | Gate                                  | Suites        |
 * |------------------|---------------------------------------|---------------|
 * | /paid/exact      | exact, EXACT_PRICE                    | A, B, E, F, H |
 * | /paid/upto       | upto, max UPTO_MAX_PRICE, ?charge=    | D             |
 * | /paid/exact-id   | exact + required payment-identifier   | E4            |
 * | /paid/fail500    | exact, handler returns 500            | E8            |
 * | /paid/slow       | exact, handler sleeps ?ms=            | E2 setup      |
 */
export function buildRoutes(env: Env): RoutesConfig {
  const network = env.NETWORK as Network;

  const exact: PaymentOption = {
    scheme: "exact",
    price: env.EXACT_PRICE,
    network,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: int(env.EXACT_MAX_TIMEOUT_SECONDS, 60),
  };

  const upto: PaymentOption = {
    scheme: "upto",
    price: env.UPTO_MAX_PRICE,
    network,
    payTo: env.PAY_TO,
    // The client derives the Permit2 deadline as now + maxTimeoutSeconds.
    // This value is the authorization window Suite D measures.
    maxTimeoutSeconds: int(env.UPTO_MAX_TIMEOUT_SECONDS, 172_800),
  };

  return {
    "GET /paid/exact": {
      accepts: exact,
      description: "x402-bench: fixed 1 KiB payload behind an exact payment",
      mimeType: "application/json",
    },
    "GET /paid/upto": {
      accepts: upto,
      description: "x402-bench: fixed 1 KiB payload behind an upto authorization; ?charge= sets the settled amount",
      mimeType: "application/json",
    },
    "GET /paid/exact-id": {
      accepts: exact,
      description: "x402-bench: exact payment that requires a client payment identifier",
      mimeType: "application/json",
      extensions: {
        [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
      },
    },
    "GET /paid/fail500": {
      accepts: exact,
      description: "x402-bench: handler fails with 500 after verification; settlement must not happen",
      mimeType: "application/json",
    },
    "GET /paid/slow": {
      accepts: exact,
      description: "x402-bench: handler sleeps ?ms= milliseconds before responding",
      mimeType: "application/json",
    },
  };
}
