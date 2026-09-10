import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { BenchFacilitatorClient } from "./faults.ts";
import type { Network, PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { extractPaymentIdentifier, paymentIdentifierResourceServerExtension } from "@x402/extensions/payment-identifier";
import { int, type Env } from "./env.ts";
import { now, recordFromTransport } from "./recorder.ts";

/**
 * Payment identifiers this isolate has already accepted (Suite E4).
 * Observation aid only: a production seller would use KV or Durable Objects.
 */
const seenPaymentIds = new Set<string>();

/**
 * Build the x402 resource server: facilitator client, schemes, and the lifecycle
 * hooks that stamp T3 (verify) and T4 (settle) onto the bench record.
 */
export function buildResourceServer(env: Env): x402ResourceServer {
  const authHeaders =
    env.FACILITATOR_AUTH_HEADER && env.FACILITATOR_AUTH_VALUE
      ? { [env.FACILITATOR_AUTH_HEADER]: env.FACILITATOR_AUTH_VALUE }
      : undefined;

  const timeoutMs = int(env.FACILITATOR_TIMEOUT_MS, 10_000);
  // FACILITATOR_PROVIDER picks the service, and it is deliberate rather than inferred from the
  // presence of credentials: which facilitator produced a result is the single most important
  // caveat on the throughput and reliability numbers, so switching must be an explicit act.
  // CDP signs a fresh Ed25519 JWT per call (its tokens expire in minutes), which is why the
  // static FACILITATOR_AUTH_HEADER pair cannot be used for it.
  const useCdp = env.FACILITATOR_PROVIDER === "cdp";
  const cdp = useCdp ? createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) : undefined;
  if (useCdp && !(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET)) {
    throw new Error("FACILITATOR_PROVIDER=cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET.");
  }

  const httpFacilitator = new HTTPFacilitatorClient({
    url: cdp?.url ?? env.FACILITATOR_URL,
    timeoutMs,
    createAuthHeaders:
      cdp?.createAuthHeaders ??
      (authHeaders ? async () => ({ verify: authHeaders, settle: authHeaders, supported: authHeaders }) : undefined),
  });
  // Suites E1 and E2 inject facilitator failures here rather than in the hooks; see faults.ts
  // for why a hook throw cannot stop verify or settle.
  const facilitator = new BenchFacilitatorClient(httpFacilitator, timeoutMs);

  const network = env.NETWORK as Network;
  const server = new x402ResourceServer(facilitator)
    .register(network, new ExactEvmScheme())
    .register(network, new UptoEvmScheme());
  server.registerExtension(paymentIdentifierResourceServerExtension);

  server
    .onBeforeVerify(async (ctx) => {
      const rec = recordFromTransport(ctx.transportContext);
      const paymentId = extractPaymentIdentifier(ctx.paymentPayload as unknown as PaymentPayload) ?? undefined;
      if (rec) {
        rec.verifyStartMs = now();
        rec.scheme = ctx.requirements.scheme;
        rec.amount = ctx.requirements.amount;
        rec.maxTimeoutSeconds = ctx.requirements.maxTimeoutSeconds;
        rec.paymentId = paymentId;
      }
      // Suite E1's verify-block is injected by BenchFacilitatorClient, not here.
      // Suite E4: reject a payment identifier this isolate has already accepted.
      if (paymentId) {
        if (seenPaymentIds.has(paymentId)) {
          return {
            abort: true,
            reason: "duplicate_payment_id",
            message: `payment identifier ${paymentId} was already used`,
          };
        }
        seenPaymentIds.add(paymentId);
      }
    })
    .onAfterVerify(async (ctx) => {
      const rec = recordFromTransport(ctx.transportContext);
      if (!rec) return;
      rec.verifyEndMs = now();
      rec.verifyOk = ctx.result.isValid;
      rec.verifyReason = ctx.result.invalidReason;
      rec.payer = ctx.result.payer;
    })
    .onVerifyFailure(async (ctx) => {
      const rec = recordFromTransport(ctx.transportContext);
      if (!rec) return;
      rec.verifyEndMs = now();
      rec.verifyOk = false;
      rec.verifyError = `${ctx.error.name}: ${ctx.error.message}`;
    })
    .onBeforeSettle(async (ctx) => {
      const rec = recordFromTransport(ctx.transportContext);
      if (rec) {
        rec.settleStartMs = now();
        rec.settlePhase = ctx.phase;
      }
      // Suite E2's settle-block is injected by BenchFacilitatorClient, not here.
    })
    .onAfterSettle(async (ctx) => {
      const rec = recordFromTransport(ctx.transportContext);
      if (!rec) return;
      rec.settleEndMs = now();
      rec.settleOk = ctx.result.success;
      rec.settleTx = ctx.result.transaction;
      rec.settleAmount = ctx.result.amount;
      rec.settleError = ctx.result.errorReason;
    })
    .onSettleFailure(async (ctx) => {
      const rec = recordFromTransport(ctx.transportContext);
      if (!rec) return;
      rec.settleEndMs = now();
      rec.settleOk = false;
      rec.settleError = `${ctx.error.name}: ${ctx.error.message}`;
    })
    .onVerifiedPaymentCanceled(async (ctx) => {
      const rec = recordFromTransport(ctx.transportContext);
      if (!rec) return;
      rec.canceledReason = ctx.reason;
      rec.canceledStatus = ctx.responseStatus;
    });

  return server;
}
