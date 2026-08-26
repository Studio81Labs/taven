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
  isTerminal,
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
  verifiedQcReadiness: true,
  shipmentHandoffAuthorized: true,
  handoffReconciliation: true,
  handoffSettlementCompleted: true,
  amountDueMinor: 0n,
  refundableBalanceMinor: 0n,
  reconciliationRefundAllocated: true,
  shipmentLineageLeafStatuses: ["delivered"],
  verifiedProviderScan: true,
  verifiedProviderVoid: true,
  contextHandoffCompleted: true,
  nodeAssigned: true,
  shipmentStatus: "returned",
  custodyConfirmed: true,
  freshQcPassed: true,
  cleanPostDeliveryQualityClaim: true,
  remedyCancellationCompleted: true,
  verifiedShipmentIncident: true,
  reshipmentAuthorizationConsumed: true,
  reshipmentHandoffCompleted: true,
  replacementSetProjected: true,
  replacementResourcePlanProjected: true,
  replacementReservationsCreated: true,
  replacementShipmentsCreated: true,
  replacementJobLineageCreated: true,
  replacementFulfilmentAuthorizationConsumed: true,
  replacementFulfilmentHandoffCompleted: true,
  preHandoffShipmentCancellationsCompleted: true,
  claimCreditScopeCreated: true,
  claimSlotCreditActivated: true,
  scopedRefundTransactionSucceeded: true,
  refundPaymentWebhookVerified: true,
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
    financialTerminalTarget: target,
    completionProjectedTarget: target,
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
    [orderPolicy, "in_production", "qc_passed"],
    [orderPolicy, "recovery_pending", "qc_passed"],
    [orderPolicy, "qc_passed", "ready_to_ship"],
    [orderPolicy, "ready_to_ship", "shipped"],
    [orderPolicy, "awaiting_balance", "shipped"],
    [orderPolicy, "awaiting_balance", "ready_to_ship"],
    [orderPolicy, "shipped", "delivered"],
    [singleOrderPhasePolicy, "quoted", "active"],
    [singleOrderPhasePolicy, "in_production", "qc_passed"],
    [singleOrderPhasePolicy, "recovery_pending", "qc_passed"],
    [singleOrderPhasePolicy, "shipped", "delivered"],
    [jobPolicy, "created", "accepted"],
    [shipmentPolicy, "label_created", "handed_over"],
    [shipmentPolicy, "cancellation_pending", "handed_over"],
    [shipmentPolicy, "cancellation_pending", "cancelled"],
    [claimPolicy, "active", "withdrawn"],
    [claimSlotResolutionPolicy, "pending", "rejected"],
    [claimSlotResolutionPolicy, "pending", "refund_pending"],
    [claimSlotResolutionPolicy, "replacement_shipped", "recovery_pending"],
    [claimSlotResolutionPolicy, "reship_pending", "reship_shipped"],
    [claimSlotResolutionPolicy, "reprint_pending", "replacement_in_production"],
    [
      claimSlotResolutionPolicy,
      "replacement_in_production",
      "replacement_shipped",
    ],
    [claimSlotResolutionPolicy, "refund_pending", "refunded"],
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

  it("blocks balance clearance while either financial balance is non-zero", () => {
    expect(() =>
      transition(orderPolicy, {
        current: "awaiting_balance",
        target: "ready_to_ship",
        idempotencyKey: "balance-clearance",
        context: {
          amountDueMinor: 0n,
          refundableBalanceMinor: 1n,
        },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each(["handoffReconciliation", "handoffSettlementCompleted"] as const)(
    "requires %s before reconciling an unauthorized handoff",
    (missingFlag) => {
      expect(() =>
        transition(orderPolicy, {
          current: "awaiting_balance",
          target: "shipped",
          idempotencyKey: `reconciliation-${missingFlag}`,
          context: {
            handoffReconciliation: true,
            handoffSettlementCompleted: true,
            amountDueMinor: 0n,
            refundableBalanceMinor: 0n,
            [missingFlag]: false,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("requires zero amount due before reconciling an unauthorized handoff", () => {
    expect(() =>
      transition(orderPolicy, {
        current: "awaiting_balance",
        target: "shipped",
        idempotencyKey: "reconciliation-amount-due",
        context: {
          handoffReconciliation: true,
          handoffSettlementCompleted: true,
          amountDueMinor: 1n,
          refundableBalanceMinor: 0n,
        },
      }),
    ).toThrow(TransitionGuardError);
  });

  it("requires a pending reconciliation refund to be explicitly allocated", () => {
    const context = {
      handoffReconciliation: true,
      handoffSettlementCompleted: true,
      amountDueMinor: 0n,
      refundableBalanceMinor: 1n,
    };
    expect(() =>
      transition(orderPolicy, {
        current: "awaiting_balance",
        target: "shipped",
        idempotencyKey: "reconciliation-unallocated-refund",
        context,
      }),
    ).toThrow(TransitionGuardError);
    expect(
      transition(orderPolicy, {
        current: "awaiting_balance",
        target: "shipped",
        idempotencyKey: "reconciliation-allocated-refund",
        context: { ...context, reconciliationRefundAllocated: true },
      }),
    ).toEqual({
      kind: "changed",
      previous: "awaiting_balance",
      current: "shipped",
    });
  });

  it.each([
    ["Order", orderPolicy, "refunded", "cancelled_settled"],
    ["Order", orderPolicy, "cancelled_settled", "refunded"],
    [
      "OrderPhase(single)",
      singleOrderPhasePolicy,
      "cancelled_refunded",
      "cancelled_settled",
    ],
    [
      "OrderPhase(single)",
      singleOrderPhasePolicy,
      "cancelled_settled",
      "cancelled_refunded",
    ],
  ] as const)(
    "rejects %s cancellation terminal target %s when finance projects %s",
    (_lifecycle, policy, target, financialTerminalTarget) => {
      expect(() =>
        transition(policy, {
          current: "cancelled",
          target,
          idempotencyKey: `financial-mismatch-${target}`,
          context: {
            amountDueMinor: 0n,
            refundableBalanceMinor: 0n,
            completionProjected: true,
            completionProjectedTarget: target,
            financialTerminalTarget,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["Order", orderPolicy, "refunded"],
    ["Order", orderPolicy, "cancelled_settled"],
    ["OrderPhase(single)", singleOrderPhasePolicy, "cancelled_refunded"],
    ["OrderPhase(single)", singleOrderPhasePolicy, "cancelled_settled"],
  ] as const)(
    "uses the adapter-projected financial terminal target for %s cancellation",
    (_lifecycle, policy, target) => {
      expect(
        transition(policy, {
          current: "cancelled",
          target,
          idempotencyKey: `financial-match-${target}`,
          context: {
            amountDueMinor: 0n,
            refundableBalanceMinor: 0n,
            completionProjected: true,
            completionProjectedTarget: target,
            financialTerminalTarget: target,
          },
        }),
      ).toEqual({ kind: "changed", previous: "cancelled", current: target });
    },
  );

  it.each([
    "quoted",
    "confirmed",
    "in_production",
    "qc_passed",
    "awaiting_balance",
    "ready_to_ship",
    "shipped",
    "recovery_pending",
  ] as const)(
    "requires shipment cancellation completion before Order %s -> cancelled",
    (current) => {
      expect(() =>
        transition(orderPolicy, {
          current,
          target: "cancelled",
          idempotencyKey: `order-cancellation-${current}`,
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each(["quoted", "active", "in_production", "qc_passed"] as const)(
    "requires shipment cancellation completion before single phase %s -> cancelled",
    (current) => {
      expect(() =>
        transition(singleOrderPhasePolicy, {
          current,
          target: "cancelled",
          idempotencyKey: `phase-cancellation-${current}`,
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each(["shipped", "recovery_pending"] as const)(
    "requires shipment cancellation completion before single phase %s -> cancelled_refunded",
    (current) => {
      expect(() =>
        transition(singleOrderPhasePolicy, {
          current,
          target: "cancelled_refunded",
          idempotencyKey: `phase-direct-cancellation-${current}`,
          context: {
            completionProjected: true,
            completionProjectedTarget: "cancelled_refunded",
            amountDueMinor: 0n,
            refundableBalanceMinor: 0n,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("requires a complete result before a labelled shipment is handed over", () => {
    expect(() =>
      transition(shipmentPolicy, {
        current: "label_created",
        target: "handed_over",
        idempotencyKey: "label-handoff-incomplete",
      }),
    ).toThrow(TransitionGuardError);
    expect(
      transition(shipmentPolicy, {
        current: "label_created",
        target: "handed_over",
        idempotencyKey: "label-handoff-complete",
        context: { contextHandoffCompleted: true },
      }),
    ).toEqual({
      kind: "changed",
      previous: "label_created",
      current: "handed_over",
    });
  });

  it("requires a verified provider void before cancelling a pending shipment", () => {
    expect(() =>
      transition(shipmentPolicy, {
        current: "cancellation_pending",
        target: "cancelled",
        idempotencyKey: "provider-void-missing",
      }),
    ).toThrow(TransitionGuardError);
    expect(
      transition(shipmentPolicy, {
        current: "cancellation_pending",
        target: "cancelled",
        idempotencyKey: "provider-void-verified",
        context: { verifiedProviderVoid: true },
      }),
    ).toEqual({
      kind: "changed",
      previous: "cancellation_pending",
      current: "cancelled",
    });
  });

  it.each([
    ["Order", orderPolicy],
    ["OrderPhase(single)", singleOrderPhasePolicy],
  ] as const)(
    "requires verified QC readiness before %s recovers into qc_passed",
    (_lifecycle, policy) => {
      expect(() =>
        transition(policy, {
          current: "recovery_pending",
          target: "qc_passed",
          idempotencyKey: "recovery-qc-readiness-missing",
        }),
      ).toThrow(TransitionGuardError);
      expect(
        transition(policy, {
          current: "recovery_pending",
          target: "qc_passed",
          idempotencyKey: "recovery-qc-readiness-verified",
          context: { verifiedQcReadiness: true },
        }),
      ).toEqual({
        kind: "changed",
        previous: "recovery_pending",
        current: "qc_passed",
      });
    },
  );

  it.each([
    [1n, 0n],
    [0n, 1n],
  ] as const)(
    "blocks Order qc_passed -> ready_to_ship with amount due %sn and refundable balance %sn",
    (amountDueMinor, refundableBalanceMinor) => {
      expect(() =>
        transition(orderPolicy, {
          current: "qc_passed",
          target: "ready_to_ship",
          idempotencyKey: `qc-ready-${amountDueMinor}-${refundableBalanceMinor}`,
          context: { amountDueMinor, refundableBalanceMinor },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("allows Order qc_passed -> ready_to_ship only with cleared balances", () => {
    expect(
      transition(orderPolicy, {
        current: "qc_passed",
        target: "ready_to_ship",
        idempotencyKey: "qc-ready-cleared",
        context: { amountDueMinor: 0n, refundableBalanceMinor: 0n },
      }),
    ).toEqual({
      kind: "changed",
      previous: "qc_passed",
      current: "ready_to_ship",
    });
  });

  it.each([
    ["Order", orderPolicy, "delivered", "completed"],
    ["Order", orderPolicy, "shipped", "partially_fulfilled"],
    ["Order", orderPolicy, "cancelled", "refunded"],
    ["Order", orderPolicy, "cancelled", "cancelled_settled"],
    ["OrderPhase(single)", singleOrderPhasePolicy, "delivered", "completed"],
    [
      "OrderPhase(single)",
      singleOrderPhasePolicy,
      "shipped",
      "partially_fulfilled",
    ],
    [
      "OrderPhase(single)",
      singleOrderPhasePolicy,
      "cancelled",
      "cancelled_refunded",
    ],
    [
      "OrderPhase(single)",
      singleOrderPhasePolicy,
      "cancelled",
      "cancelled_settled",
    ],
  ] as const)(
    "rejects %s completion target %s when the completion projection names a different target",
    (_lifecycle, policy, current, target) => {
      expect(() =>
        transition(policy, {
          current,
          target,
          idempotencyKey: `completion-target-mismatch-${target}`,
          context: {
            completionProjected: true,
            completionProjectedTarget: "not-the-target",
            amountDueMinor: 0n,
            refundableBalanceMinor: 0n,
            financialTerminalTarget: target,
            preHandoffShipmentCancellationsCompleted: true,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["Order", orderPolicy, "delivered", "completed"],
    ["Order", orderPolicy, "shipped", "partially_fulfilled"],
    ["Order", orderPolicy, "cancelled", "refunded"],
    ["Order", orderPolicy, "cancelled", "cancelled_settled"],
    ["OrderPhase(single)", singleOrderPhasePolicy, "delivered", "completed"],
    [
      "OrderPhase(single)",
      singleOrderPhasePolicy,
      "shipped",
      "partially_fulfilled",
    ],
    [
      "OrderPhase(single)",
      singleOrderPhasePolicy,
      "cancelled",
      "cancelled_refunded",
    ],
    [
      "OrderPhase(single)",
      singleOrderPhasePolicy,
      "cancelled",
      "cancelled_settled",
    ],
  ] as const)(
    "accepts %s completion target %s only when its projection matches",
    (_lifecycle, policy, current, target) => {
      expect(
        transition(policy, {
          current,
          target,
          idempotencyKey: `completion-target-match-${target}`,
          context: {
            completionProjected: true,
            completionProjectedTarget: target,
            amountDueMinor: 0n,
            refundableBalanceMinor: 0n,
            financialTerminalTarget: target,
            preHandoffShipmentCancellationsCompleted: true,
          },
        }),
      ).toEqual({ kind: "changed", previous: current, current: target });
    },
  );

  it.each([
    ["pending", "claimCreditScopeCreated"],
    ["pending", "claimSlotCreditActivated"],
    ["reship_pending", "claimCreditScopeCreated"],
    ["reship_pending", "claimSlotCreditActivated"],
    ["reprint_pending", "claimCreditScopeCreated"],
    ["reprint_pending", "claimSlotCreditActivated"],
    ["replacement_in_production", "claimCreditScopeCreated"],
    ["replacement_in_production", "claimSlotCreditActivated"],
    ["recovery_pending", "claimCreditScopeCreated"],
    ["recovery_pending", "claimSlotCreditActivated"],
  ] as const)(
    "requires %s before %s enters refund_pending",
    (current, missingFlag) => {
      const isDirectRefund =
        current === "pending" || current === "recovery_pending";
      expect(() =>
        transition(claimSlotResolutionPolicy, {
          current,
          target: "refund_pending",
          idempotencyKey: `claim-refund-${current}-${missingFlag}`,
          context: {
            claimCreditScopeCreated: true,
            claimSlotCreditActivated: true,
            ...(isDirectRefund ? {} : { remedyCancellationCompleted: true }),
            [missingFlag]: false,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each(["pending", "recovery_pending"] as const)(
    "allows direct claim refund from %s once its scoped credit is active",
    (current) => {
      expect(
        transition(claimSlotResolutionPolicy, {
          current,
          target: "refund_pending",
          idempotencyKey: `direct-claim-refund-${current}`,
          context: {
            claimCreditScopeCreated: true,
            claimSlotCreditActivated: true,
          },
        }),
      ).toEqual({
        kind: "changed",
        previous: current,
        current: "refund_pending",
      });
    },
  );

  it.each([
    "reship_pending",
    "reprint_pending",
    "replacement_in_production",
  ] as const)(
    "keeps the remedy cancellation barrier before %s enters refund_pending",
    (current) => {
      expect(() =>
        transition(claimSlotResolutionPolicy, {
          current,
          target: "refund_pending",
          idempotencyKey: `claim-remedy-cancellation-${current}`,
          context: {
            claimCreditScopeCreated: true,
            claimSlotCreditActivated: true,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["Order", orderPolicy],
    ["OrderPhase(single)", singleOrderPhasePolicy],
  ] as const)(
    "requires all current shipment lineage leaves before %s enters delivered",
    (_lifecycle, policy) => {
      expect(() =>
        transition(policy, {
          current: "shipped",
          target: "delivered",
          idempotencyKey: "delivery-leaves",
          context: { shipmentLineageLeafStatuses: ["delivered", "in_transit"] },
        }),
      ).toThrow(TransitionGuardError);
      expect(
        transition(policy, {
          current: "shipped",
          target: "delivered",
          idempotencyKey: "delivery-leaves-complete",
          context: { shipmentLineageLeafStatuses: ["delivered", "delivered"] },
        }),
      ).toEqual({ kind: "changed", previous: "shipped", current: "delivered" });
    },
  );

  it.each([
    ["Order", orderPolicy, "confirmed"],
    ["OrderPhase(single)", singleOrderPhasePolicy, "active"],
  ] as const)(
    "models unpaid %s cancellation as terminal and routes captured cancellations through settlement",
    (_lifecycle, policy, current) => {
      expect(isTerminal(policy, "cancelled")).toBe(false);
      expect(isTerminal(policy, "cancelled", { paymentStatus: "unpaid" })).toBe(
        true,
      );
      expect(isTerminal(policy, "cancelled", { paymentStatus: "paid" })).toBe(
        false,
      );
      expect(
        transition(policy, {
          current,
          target: "cancelled",
          idempotencyKey: "captured-cancellation",
          context: {
            paymentStatus: "paid",
            preHandoffShipmentCancellationsCompleted: true,
          },
        }),
      ).toEqual({
        kind: "changed",
        previous: current,
        current: "cancelled",
      });
      expect(
        transition(policy, {
          current: "cancelled",
          target: policy === orderPolicy ? "refunded" : "cancelled_refunded",
          idempotencyKey: "captured-cancellation-refund",
          context: {
            paymentStatus: "paid",
            amountDueMinor: 0n,
            refundableBalanceMinor: 0n,
            completionProjected: true,
            completionProjectedTarget:
              policy === orderPolicy ? "refunded" : "cancelled_refunded",
            financialTerminalTarget:
              policy === orderPolicy ? "refunded" : "cancelled_refunded",
          },
        }),
      ).toEqual({
        kind: "changed",
        previous: "cancelled",
        current: policy === orderPolicy ? "refunded" : "cancelled_refunded",
      });
    },
  );

  it.each([
    "reshipmentAuthorizationConsumed",
    "reshipmentHandoffCompleted",
  ] as const)("requires %s before shipping a reship remedy", (missingFlag) => {
    const context = {
      reshipmentAuthorizationConsumed: true,
      reshipmentHandoffCompleted: true,
      [missingFlag]: false,
    };
    expect(() =>
      transition(claimSlotResolutionPolicy, {
        current: "reship_pending",
        target: "reship_shipped",
        idempotencyKey: `reship-handoff-${missingFlag}`,
        context,
      }),
    ).toThrow(TransitionGuardError);
  });

  it("ships a reship remedy only after its authorization-backed handoff", () => {
    expect(
      transition(claimSlotResolutionPolicy, {
        current: "reship_pending",
        target: "reship_shipped",
        idempotencyKey: "reship-handoff-complete",
        context: {
          reshipmentAuthorizationConsumed: true,
          reshipmentHandoffCompleted: true,
        },
      }),
    ).toEqual({
      kind: "changed",
      previous: "reship_pending",
      current: "reship_shipped",
    });
  });

  it.each([
    ["Order", orderPolicy],
    ["OrderPhase(single)", singleOrderPhasePolicy],
  ] as const)(
    "requires the complete QC readiness projection before %s enters qc_passed",
    (_lifecycle, policy) => {
      expect(() =>
        transition(policy, {
          current: "in_production",
          target: "qc_passed",
          idempotencyKey: "qc-readiness-missing",
        }),
      ).toThrow(TransitionGuardError);
      expect(
        transition(policy, {
          current: "in_production",
          target: "qc_passed",
          idempotencyKey: "qc-readiness-complete",
          context: { verifiedQcReadiness: true },
        }),
      ).toEqual({
        kind: "changed",
        previous: "in_production",
        current: "qc_passed",
      });
    },
  );

  it.each([
    "replacementSetProjected",
    "replacementResourcePlanProjected",
    "replacementReservationsCreated",
    "replacementShipmentsCreated",
    "replacementJobLineageCreated",
  ] as const)(
    "requires %s before starting all-or-none replacement production",
    (missingFlag) => {
      const context = {
        replacementSetProjected: true,
        replacementResourcePlanProjected: true,
        replacementReservationsCreated: true,
        replacementShipmentsCreated: true,
        replacementJobLineageCreated: true,
        [missingFlag]: false,
      };
      expect(() =>
        transition(claimSlotResolutionPolicy, {
          current: "reprint_pending",
          target: "replacement_in_production",
          idempotencyKey: `replacement-production-${missingFlag}`,
          context,
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("starts replacement production only after its complete all-or-none setup", () => {
    expect(
      transition(claimSlotResolutionPolicy, {
        current: "reprint_pending",
        target: "replacement_in_production",
        idempotencyKey: "replacement-production-complete",
        context: {
          replacementSetProjected: true,
          replacementResourcePlanProjected: true,
          replacementReservationsCreated: true,
          replacementShipmentsCreated: true,
          replacementJobLineageCreated: true,
        },
      }),
    ).toEqual({
      kind: "changed",
      previous: "reprint_pending",
      current: "replacement_in_production",
    });
  });

  it.each([
    "replacementFulfilmentAuthorizationConsumed",
    "replacementFulfilmentHandoffCompleted",
  ] as const)(
    "requires %s before shipping a replacement remedy",
    (missingFlag) => {
      const context = {
        replacementFulfilmentAuthorizationConsumed: true,
        replacementFulfilmentHandoffCompleted: true,
        [missingFlag]: false,
      };
      expect(() =>
        transition(claimSlotResolutionPolicy, {
          current: "replacement_in_production",
          target: "replacement_shipped",
          idempotencyKey: `replacement-handoff-${missingFlag}`,
          context,
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("ships a replacement remedy only after consuming its fulfilment authorization", () => {
    expect(
      transition(claimSlotResolutionPolicy, {
        current: "replacement_in_production",
        target: "replacement_shipped",
        idempotencyKey: "replacement-handoff-complete",
        context: {
          replacementFulfilmentAuthorizationConsumed: true,
          replacementFulfilmentHandoffCompleted: true,
        },
      }),
    ).toEqual({
      kind: "changed",
      previous: "replacement_in_production",
      current: "replacement_shipped",
    });
  });

  it.each([
    "scopedRefundTransactionSucceeded",
    "refundPaymentWebhookVerified",
  ] as const)("requires %s before completing a claim refund", (missingFlag) => {
    const context = {
      scopedRefundTransactionSucceeded: true,
      refundPaymentWebhookVerified: true,
      [missingFlag]: false,
    };
    expect(() =>
      transition(claimSlotResolutionPolicy, {
        current: "refund_pending",
        target: "refunded",
        idempotencyKey: `claim-refund-completion-${missingFlag}`,
        context,
      }),
    ).toThrow(TransitionGuardError);
  });

  it("completes a claim refund only from its scoped transaction webhook result", () => {
    expect(
      transition(claimSlotResolutionPolicy, {
        current: "refund_pending",
        target: "refunded",
        idempotencyKey: "claim-refund-completion",
        context: {
          scopedRefundTransactionSucceeded: true,
          refundPaymentWebhookVerified: true,
        },
      }),
    ).toEqual({
      kind: "changed",
      previous: "refund_pending",
      current: "refunded",
    });
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
