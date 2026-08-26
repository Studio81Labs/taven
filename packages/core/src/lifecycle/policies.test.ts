import { describe, expect, it } from "vitest";
import {
  canAcceptQuote,
  claimPolicy,
  claimSlotResolutionPolicy,
  isQuoteAvailable,
  jobPolicy,
  orderPolicy,
  paymentPolicy,
  quoteRequestPolicy,
  shipmentPolicy,
  singleOrderPhasePolicy,
  type IssuedQuote,
} from "./policies.js";
import {
  InvalidTransitionError,
  transition,
  TransitionGuardError,
  type TransitionPolicy,
} from "./transition.js";
import { Instant } from "../primitives/time.js";

const permittedContext = {
  quoteAvailable: true,
  captureAuthorized: true,
  verifiedLateCapture: true,
  completeReservationCaptured: true,
  shipmentHandoffAuthorized: true,
  handoffReconciliation: true,
  amountDueMinor: 0n,
  refundableBalanceMinor: 0n,
  verifiedProviderScan: true,
  contextHandoffCompleted: true,
  nodeAssigned: true,
  shipmentStatus: "returned",
  custodyConfirmed: true,
  freshQcPassed: true,
  cleanPostDeliveryQualityClaim: true,
  remedyCancellationCompleted: true,
  verifiedShipmentIncident: true,
  completionProjected: true,
} as const;

function claimSlotStatusesForTarget(target: string): readonly string[] {
  switch (target) {
    case "resolved_rejected":
      return ["rejected"];
    case "resolved_reprint":
      return ["delivered_reprint"];
    case "resolved_reship":
      return ["delivered_reship"];
    case "resolved_refund":
      return ["refunded"];
    case "resolved_mixed":
      return ["delivered_reprint", "refunded"];
    case "withdrawn":
      return ["withdrawn"];
    default:
      return ["refunded"];
  }
}

function contextForTransition(target: string) {
  return {
    ...permittedContext,
    claimSlotResolutionStatuses: claimSlotStatusesForTarget(target),
  };
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof InvalidTransitionError ? error.code : undefined;
  }
  return undefined;
}

function verifyEveryStatePair<S extends string>(
  policy: TransitionPolicy<S>,
): void {
  const states = [
    ...new Set([
      ...policy.initial,
      ...policy.terminal,
      ...Object.keys(policy.transitions),
      ...Object.values(policy.transitions).flat(),
    ]),
  ] as S[];

  for (const current of states) {
    for (const target of states) {
      const allowed = (policy.transitions[current] ?? []).includes(target);
      const name = `${policy.name}: ${current} -> ${target}`;
      if (current === target || !allowed) {
        expect(
          () =>
            transition(policy, {
              current,
              target,
              idempotencyKey: "new",
              context: contextForTransition(target),
            }),
          name,
        ).toThrow(InvalidTransitionError);
      } else {
        expect(
          transition(policy, {
            current,
            target,
            idempotencyKey: "new",
            context: contextForTransition(target),
          }),
          name,
        ).toEqual({
          kind: "changed",
          previous: current,
          current: target,
        });
      }
    }
  }
}

describe("v0 lifecycle policy tables", () => {
  const policies = [
    quoteRequestPolicy,
    paymentPolicy,
    orderPolicy,
    singleOrderPhasePolicy,
    jobPolicy,
    shipmentPolicy,
    claimPolicy,
    claimSlotResolutionPolicy,
  ];

  for (const policy of policies) {
    it(`enumerates every allowed and rejected state pair for ${policy.name}`, () => {
      verifyEveryStatePair(policy);
      for (const terminal of policy.terminal) {
        expect(policy.transitions[terminal] ?? []).toEqual([]);
      }
    });
  }

  it("only accepts a retry when it is the command that produced the current state", () => {
    expect(
      transition(orderPolicy, {
        current: "quoted",
        target: "quoted",
        idempotencyKey: "command-1",
        currentStateCommandKey: "command-1",
      }),
    ).toEqual({ kind: "already_applied", current: "quoted" });
    expect(
      errorCode(() =>
        transition(orderPolicy, {
          current: "quoted",
          target: "quoted",
          idempotencyKey: "another-command",
          currentStateCommandKey: "command-1",
        }),
      ),
    ).toBe("INVALID_TRANSITION");
  });

  it.each([
    [quoteRequestPolicy, "quoted", "accepted"],
    [paymentPolicy, "pending", "captured"],
    [paymentPolicy, "voided", "refund_pending"],
    [orderPolicy, "quoted", "confirmed"],
    [orderPolicy, "ready_to_ship", "shipped"],
    [singleOrderPhasePolicy, "quoted", "active"],
    [jobPolicy, "created", "accepted"],
    [shipmentPolicy, "cancellation_pending", "handed_over"],
    [claimPolicy, "active", "withdrawn"],
    [claimSlotResolutionPolicy, "replacement_shipped", "recovery_pending"],
  ] as const)(
    "rejects %s exceptional edge without its command guard",
    (policy, current, target) => {
      expect(() =>
        transition(policy, { current, target, idempotencyKey: "guarded" }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("blocks ordinary handoff while either financial balance is non-zero", () => {
    expect(() =>
      transition(orderPolicy, {
        current: "ready_to_ship",
        target: "shipped",
        idempotencyKey: "handoff",
        context: {
          shipmentHandoffAuthorized: true,
          amountDueMinor: 1n,
          refundableBalanceMinor: 0n,
        },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    ["pending", "lost"],
    ["recovery_pending", "lost"],
  ] as const)(
    "requires a returned or recovered shipment before %s -> reship_pending",
    (current, shipmentStatus) => {
      expect(() =>
        transition(claimSlotResolutionPolicy, {
          current,
          target: "reship_pending",
          idempotencyKey: "reship-lost",
          context: {
            shipmentStatus,
            custodyConfirmed: true,
            freshQcPassed: true,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each(["custodyConfirmed", "freshQcPassed"] as const)(
    "requires %s before selecting a reship",
    (missingFlag) => {
      const context = {
        shipmentStatus: "recovered",
        custodyConfirmed: true,
        freshQcPassed: true,
        [missingFlag]: false,
      };
      expect(() =>
        transition(claimSlotResolutionPolicy, {
          current: "recovery_pending",
          target: "reship_pending",
          idempotencyKey: `reship-missing-${missingFlag}`,
          context,
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["pending", "returned"],
    ["pending", "recovered"],
    ["recovery_pending", "returned"],
    ["recovery_pending", "recovered"],
  ] as const)(
    "allows %s -> reship_pending after %s shipment custody and fresh QC",
    (current, shipmentStatus) => {
      expect(
        transition(claimSlotResolutionPolicy, {
          current,
          target: "reship_pending",
          idempotencyKey: `reship-${current}-${shipmentStatus}`,
          context: {
            shipmentStatus,
            custodyConfirmed: true,
            freshQcPassed: true,
          },
        }),
      ).toEqual({
        kind: "changed",
        previous: current,
        current: "reship_pending",
      });
    },
  );

  it.each([
    ["resolved_reprint", ["refunded"]],
    ["resolved_refund", ["delivered_reprint"]],
    ["resolved_reship", ["delivered_reprint", "refunded"]],
    ["resolved_mixed", ["rejected", "refunded"]],
  ] as const)(
    "rejects parent target %s when child dispositions project elsewhere",
    (target, claimSlotResolutionStatuses) => {
      expect(() =>
        transition(claimPolicy, {
          current: "active",
          target,
          idempotencyKey: `claim-mismatch-${target}`,
          context: {
            claimSlotResolutionStatuses,
            cleanPostDeliveryQualityClaim: true,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["resolved_refund", ["refunded"]],
    ["resolved_mixed", ["delivered_reprint", "refunded"]],
  ] as const)(
    "accepts parent target %s for the matching child dispositions",
    (target, claimSlotResolutionStatuses) => {
      expect(
        transition(claimPolicy, {
          current: "active",
          target,
          idempotencyKey: `claim-match-${target}`,
          context: {
            claimSlotResolutionStatuses,
            cleanPostDeliveryQualityClaim: true,
          },
        }),
      ).toEqual({ kind: "changed", previous: "active", current: target });
    },
  );
});

describe("Quote ownership", () => {
  const quote: IssuedQuote = {
    id: "quote-1",
    quoteRequestId: "request-1",
    issuedAt: Instant.parse("2026-01-01T00:00:00.000Z"),
    expiresAt: Instant.parse("2026-01-02T00:00:00.000Z"),
  };

  it("derives availability from the immutable quote and owning request", () => {
    expect(
      isQuoteAvailable(
        quote,
        "quoted",
        Instant.parse("2026-01-01T12:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isQuoteAvailable(
        quote,
        "accepted",
        Instant.parse("2026-01-01T12:00:00.000Z"),
      ),
    ).toBe(false);
    expect(isQuoteAvailable(quote, "quoted", quote.expiresAt)).toBe(false);
    expect(
      isQuoteAvailable(
        quote,
        "quoted",
        Instant.parse("2025-12-31T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      canAcceptQuote(
        quote,
        "quoted",
        Instant.parse("2026-01-01T12:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
