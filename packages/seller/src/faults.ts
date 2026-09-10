import { AsyncLocalStorage } from "node:async_hooks";
import { FacilitatorTimeoutError } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import type { SellerRecord } from "@x402-bench/shared";

/**
 * Per-request store for the bench record.
 *
 * The lifecycle hooks can find their record through the transport context, but a
 * FacilitatorClient's verify()/settle() receive only the payload and requirements,
 * so the fault for the current request has to travel out of band. AsyncLocalStorage
 * works on Workers under the nodejs_compat flag and is request-scoped, which a
 * module-level variable would not be once requests overlap.
 */
export const currentRecord = new AsyncLocalStorage<SellerRecord>();

/**
 * Facilitator client that fails on demand, for Suite E1 and E2.
 *
 * Why this wraps the client instead of throwing from an onBeforeVerify /
 * onBeforeSettle hook: @x402/core catches whatever a hook throws, logs
 * "hook threw", and then carries on and calls the real facilitator anyway. Only
 * two hook return values change the flow ({ abort } and { skip }), and an abort is
 * a deliberate rejection, not an outage. An error raised by the facilitator client
 * itself takes the SDK's genuine failure path: onVerifyFailure / onSettleFailure
 * run and can recover, otherwise the error propagates. That is what a dead
 * facilitator actually looks like, so it is what the fault has to imitate.
 */
export class BenchFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly delegate: FacilitatorClient,
    /** Milliseconds reported in the injected timeout error, for the record only. */
    private readonly reportedTimeoutMs: number,
  ) {}

  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    if (currentRecord.getStore()?.fault === "verify-block") {
      throw new FacilitatorTimeoutError("verify", this.reportedTimeoutMs);
    }
    return this.delegate.verify(paymentPayload, paymentRequirements);
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    if (currentRecord.getStore()?.fault === "settle-block") {
      throw new FacilitatorTimeoutError("settle", this.reportedTimeoutMs);
    }
    return this.delegate.settle(paymentPayload, paymentRequirements);
  }

  /** Never faulted: /supported runs at startup, outside any faulted request. */
  async getSupported(): Promise<SupportedResponse> {
    return this.delegate.getSupported();
  }
}
