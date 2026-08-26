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
  paymentId: "payment-1",
  providerEventPaymentId: "payment-1",
  providerPaymentEventAuthenticated: true,
  providerPaymentEventVerified: true,
  refundWebhookPaymentId: "payment-1",
  refundTransactionId: "refund-1",
  refundWebhookRefundTransactionId: "refund-1",
  refundWebhookAuthenticated: true,
  refundWebhookVerified: true,
  refundWebhookStatus: "succeeded",
  captureWindowClosed: true,
  captureCutoffSet: true,
  providerVoidOutboxCreated: true,
  scopedRefundTransactionCreated: true,
  refundPriceAdjustmentActivated: true,
  singleOrderPhaseCreated: true,
  immutableFulfilmentSlotsCreated: true,
  setupAtomic: true,
  completeReservationCaptured: true,
  verifiedQcReadiness: true,
  balancePaymentRole: "balance",
  balancePaymentOrderMatches: true,
  balancePaymentCreated: true,
  balancePaymentScheduleComplete: true,
  balanceDueAtSet: true,
  balancePaymentDeadlineSetupAtomic: true,
  completeShipmentReadiness: true,
  verifiedPostQcFailure: true,
  replacementObligationCreated: true,
  balanceCaptureClosed: true,
  immutableOrderSettlementCompleted: true,
  recoveryFinancialSettlementCompleted: true,
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
  cancellationReason: "routing_exhausted",
  offersClosed: true,
  productionReservationReleased: true,
  failureStage: "machine",
  failureReason: "machine fault",
  replacementRequestCreated: true,
  replacementDeadlineSet: true,
  productionSliceFromReservationSnapshot: true,
  reproductionArtifactSealed: true,
  qcPhotoAssetStored: true,
  photoRetentionDeadlineSet: true,
  qcApprovalVerified: true,
  qcRejectionVerified: true,
  shipmentStatus: "returned",
  custodyConfirmed: true,
  freshQcPassed: true,
  cleanPostDeliveryQualityClaim: true,
  remedyCancellationCompleted: true,
  verifiedShipmentIncident: true,
  reshipmentAuthorizationConsumed: true,
  reshipmentHandoffCompleted: true,
  reshipmentAuthorizationCreated: true,
  reshipmentAuthorizationSetupAtomic: true,
  replacementSetProjected: true,
  replacementResourcePlanProjected: true,
  replacementReservationsCreated: true,
  replacementShipmentsCreated: true,
  replacementJobLineageCreated: true,
  replacementFulfilmentAuthorizationConsumed: true,
  replacementFulfilmentHandoffCompleted: true,
  preHandoffShipmentCancellationsCompleted: true,
  shipmentId: "shipment-1",
  providerEventShipmentId: "shipment-1",
  providerEventAuthenticated: true,
  providerEventVerified: true,
  currentRemedyShipmentLineageLeafId: "shipment-1",
  currentRemedyShipmentLineageLeafStatus: "delivered",
  shipmentJobsAndReservationsReleased: true,
  parentCancellationBarrierReleased: true,
  labelInvalidated: true,
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
    refundWebhookProjectedTarget: target,
    providerPaymentEventStatus: target,
    providerEventStatus:
      target === "delivered_reship" || target === "delivered_reprint"
        ? "delivered"
        : target,
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
    [paymentPolicy, "refund_pending", "partially_refunded"],
    [paymentPolicy, "refund_pending", "refunded"],
    [orderPolicy, "quoted", "confirmed"],
    [orderPolicy, "in_production", "qc_passed"],
    [orderPolicy, "recovery_pending", "qc_passed"],
    [orderPolicy, "qc_passed", "awaiting_balance"],
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
    [jobPolicy, "packed", "handed_over"],
    [shipmentPolicy, "label_created", "handed_over"],
    [shipmentPolicy, "cancellation_pending", "handed_over"],
    [shipmentPolicy, "cancellation_pending", "cancelled"],
    [shipmentPolicy, "in_transit", "delivered"],
    [shipmentPolicy, "in_transit", "lost"],
    [shipmentPolicy, "in_transit", "returned"],
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
    [claimSlotResolutionPolicy, "reship_shipped", "delivered_reship"],
    [claimSlotResolutionPolicy, "replacement_shipped", "delivered_reprint"],
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
        context: {
          verifiedProviderVoid: true,
          shipmentJobsAndReservationsReleased: true,
          parentCancellationBarrierReleased: true,
        },
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

      const sparseShipmentStatuses = ["delivered"] as string[];
      sparseShipmentStatuses.length = 2;
      expect(() =>
        transition(policy, {
          current: "shipped",
          target: "delivered",
          idempotencyKey: "delivery-leaves-sparse",
          context: {
            shipmentLineageLeafStatuses: sparseShipmentStatuses,
          },
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
        context: {
          amountDueMinor: 0n,
          refundableBalanceMinor: 0n,
          completeShipmentReadiness: true,
        },
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
      reshipmentAuthorizationCreated: true,
      reshipmentAuthorizationSetupAtomic: true,
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
            reshipmentAuthorizationCreated: true,
            reshipmentAuthorizationSetupAtomic: true,
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
        reshipmentAuthorizationCreated: true,
        reshipmentAuthorizationSetupAtomic: true,
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
            reshipmentAuthorizationCreated: true,
            reshipmentAuthorizationSetupAtomic: true,
          },
        }),
      ).toEqual({
        kind: "changed",
        previous: current,
        current: "reship_pending",
      });
    },
  );

  it.each(["refundWebhookAuthenticated", "refundWebhookVerified"] as const)(
    "requires %s before a Payment can record a refund webhook result",
    (missingFlag) => {
      expect(() =>
        transition(paymentPolicy, {
          current: "refund_pending",
          target: "partially_refunded",
          idempotencyKey: `payment-refund-${missingFlag}`,
          context: {
            paymentId: "payment-1",
            refundWebhookPaymentId: "payment-1",
            refundTransactionId: "refund-1",
            refundWebhookRefundTransactionId: "refund-1",
            refundWebhookAuthenticated: true,
            refundWebhookVerified: true,
            refundWebhookStatus: "succeeded",
            refundWebhookProjectedTarget: "partially_refunded",
            [missingFlag]: false,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["refundWebhookPaymentId", "another-payment"],
    ["refundWebhookRefundTransactionId", "another-refund"],
    ["refundWebhookStatus", "failed"],
    ["refundWebhookProjectedTarget", "partially_refunded"],
  ] as const)(
    "rejects a refund webhook with non-matching %s",
    (field, value) => {
      expect(() =>
        transition(paymentPolicy, {
          current: "refund_pending",
          target: "refunded",
          idempotencyKey: `payment-refund-${field}`,
          context: {
            paymentId: "payment-1",
            refundWebhookPaymentId: "payment-1",
            refundTransactionId: "refund-1",
            refundWebhookRefundTransactionId: "refund-1",
            refundWebhookAuthenticated: true,
            refundWebhookVerified: true,
            refundWebhookStatus: "succeeded",
            refundWebhookProjectedTarget: "refunded",
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each(["partially_refunded", "refunded"] as const)(
    "records Payment %s only from its matching successful verified refund webhook",
    (target) => {
      expect(
        transition(paymentPolicy, {
          current: "refund_pending",
          target,
          idempotencyKey: `payment-refund-success-${target}`,
          context: {
            paymentId: "payment-1",
            refundWebhookPaymentId: "payment-1",
            refundTransactionId: "refund-1",
            refundWebhookRefundTransactionId: "refund-1",
            refundWebhookAuthenticated: true,
            refundWebhookVerified: true,
            refundWebhookStatus: "succeeded",
            refundWebhookProjectedTarget: target,
          },
        }),
      ).toEqual({
        kind: "changed",
        previous: "refund_pending",
        current: target,
      });
    },
  );

  it.each([
    "balancePaymentOrderMatches",
    "balancePaymentCreated",
    "balancePaymentScheduleComplete",
    "balanceDueAtSet",
    "balancePaymentDeadlineSetupAtomic",
  ] as const)(
    "requires %s before Order qc_passed -> awaiting_balance",
    (missingFlag) => {
      expect(() =>
        transition(orderPolicy, {
          current: "qc_passed",
          target: "awaiting_balance",
          idempotencyKey: `balance-setup-${missingFlag}`,
          context: {
            balancePaymentRole: "balance",
            balancePaymentOrderMatches: true,
            balancePaymentCreated: true,
            balancePaymentScheduleComplete: true,
            balanceDueAtSet: true,
            balancePaymentDeadlineSetupAtomic: true,
            [missingFlag]: false,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["balancePaymentRole", undefined],
    ["balancePaymentRole", "deposit"],
    ["balancePaymentOrderMatches", false],
  ] as const)(
    "rejects balance setup with invalid %s evidence",
    (field, value) => {
      expect(() =>
        transition(orderPolicy, {
          current: "qc_passed",
          target: "awaiting_balance",
          idempotencyKey: `balance-setup-${field}-${String(value)}`,
          context: {
            balancePaymentRole: "balance",
            balancePaymentOrderMatches: true,
            balancePaymentCreated: true,
            balancePaymentScheduleComplete: true,
            balanceDueAtSet: true,
            balancePaymentDeadlineSetupAtomic: true,
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("enters awaiting_balance only after the balance Payment and deadline are atomically set", () => {
    expect(
      transition(orderPolicy, {
        current: "qc_passed",
        target: "awaiting_balance",
        idempotencyKey: "balance-setup-complete",
        context: {
          balancePaymentRole: "balance",
          balancePaymentOrderMatches: true,
          balancePaymentCreated: true,
          balancePaymentScheduleComplete: true,
          balanceDueAtSet: true,
          balancePaymentDeadlineSetupAtomic: true,
        },
      }),
    ).toEqual({
      kind: "changed",
      previous: "qc_passed",
      current: "awaiting_balance",
    });
  });

  it("requires the complete shipment handoff transaction before a packed Job is handed over", () => {
    expect(() =>
      transition(jobPolicy, {
        current: "packed",
        target: "handed_over",
        idempotencyKey: "job-handoff-missing",
      }),
    ).toThrow(TransitionGuardError);
    expect(
      transition(jobPolicy, {
        current: "packed",
        target: "handed_over",
        idempotencyKey: "job-handoff-complete",
        context: { contextHandoffCompleted: true },
      }),
    ).toEqual({ kind: "changed", previous: "packed", current: "handed_over" });
  });

  it.each([
    ["providerEventAuthenticated", false],
    ["providerEventVerified", false],
    ["providerEventShipmentId", "another-shipment"],
    ["providerEventStatus", "lost"],
  ] as const)(
    "rejects an in-transit delivery event with non-matching %s",
    (field, value) => {
      expect(() =>
        transition(shipmentPolicy, {
          current: "in_transit",
          target: "delivered",
          idempotencyKey: `shipment-delivery-${field}`,
          context: {
            shipmentId: "shipment-1",
            providerEventShipmentId: "shipment-1",
            providerEventAuthenticated: true,
            providerEventVerified: true,
            providerEventStatus: "delivered",
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each(["delivered", "lost", "returned"] as const)(
    "accepts in_transit -> %s only from its matching authenticated provider event",
    (target) => {
      expect(
        transition(shipmentPolicy, {
          current: "in_transit",
          target,
          idempotencyKey: `shipment-event-${target}`,
          context: {
            shipmentId: "shipment-1",
            providerEventShipmentId: "shipment-1",
            providerEventAuthenticated: true,
            providerEventVerified: true,
            providerEventStatus: target,
          },
        }),
      ).toEqual({ kind: "changed", previous: "in_transit", current: target });
    },
  );

  it.each([
    ["currentRemedyShipmentLineageLeafStatus", "in_transit"],
    ["providerEventShipmentId", "superseded-remedy-shipment"],
    ["providerEventAuthenticated", false],
    ["providerEventVerified", false],
    ["providerEventStatus", "lost"],
  ] as const)(
    "rejects a remedy delivery without exact current lineage proof (%s)",
    (field, value) => {
      expect(() =>
        transition(claimSlotResolutionPolicy, {
          current: "reship_shipped",
          target: "delivered_reship",
          idempotencyKey: `reship-delivery-${field}`,
          context: {
            currentRemedyShipmentLineageLeafId: "remedy-shipment-1",
            currentRemedyShipmentLineageLeafStatus: "delivered",
            providerEventShipmentId: "remedy-shipment-1",
            providerEventAuthenticated: true,
            providerEventVerified: true,
            providerEventStatus: "delivered",
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["reship_shipped", "delivered_reship"],
    ["replacement_shipped", "delivered_reprint"],
  ] as const)(
    "records %s -> %s only from the matching delivered remedy lineage leaf",
    (current, target) => {
      expect(
        transition(claimSlotResolutionPolicy, {
          current,
          target,
          idempotencyKey: `remedy-delivery-${target}`,
          context: {
            currentRemedyShipmentLineageLeafId: "remedy-shipment-1",
            currentRemedyShipmentLineageLeafStatus: "delivered",
            providerEventShipmentId: "remedy-shipment-1",
            providerEventAuthenticated: true,
            providerEventVerified: true,
            providerEventStatus: "delivered",
          },
        }),
      ).toEqual({ kind: "changed", previous: current, current: target });
    },
  );

  it.each([
    [
      jobPolicy,
      "created",
      "cancelled",
      ["offersClosed", "productionReservationReleased"],
    ],
    [
      jobPolicy,
      "accepted",
      "gcode_ready",
      ["productionSliceFromReservationSnapshot", "reproductionArtifactSealed"],
    ],
    [
      jobPolicy,
      "printed",
      "photo_submitted",
      ["qcPhotoAssetStored", "photoRetentionDeadlineSet"],
    ],
    [jobPolicy, "photo_submitted", "qc_approved", ["qcApprovalVerified"]],
    [
      jobPolicy,
      "photo_submitted",
      "qc_rejected",
      [
        "qcRejectionVerified",
        "replacementRequestCreated",
        "replacementDeadlineSet",
      ],
    ],
    [
      jobPolicy,
      "accepted",
      "failed",
      ["replacementRequestCreated", "replacementDeadlineSet"],
    ],
    [
      paymentPolicy,
      "pending",
      "failed",
      ["providerPaymentEventAuthenticated", "providerPaymentEventVerified"],
    ],
    [
      paymentPolicy,
      "pending",
      "voided",
      ["captureWindowClosed", "captureCutoffSet", "providerVoidOutboxCreated"],
    ],
    [
      paymentPolicy,
      "captured",
      "refund_pending",
      ["scopedRefundTransactionCreated", "refundPriceAdjustmentActivated"],
    ],
    [
      paymentPolicy,
      "partially_refunded",
      "refund_pending",
      ["scopedRefundTransactionCreated", "refundPriceAdjustmentActivated"],
    ],
    [
      orderPolicy,
      "draft",
      "quoted",
      [
        "singleOrderPhaseCreated",
        "immutableFulfilmentSlotsCreated",
        "setupAtomic",
      ],
    ],
    [orderPolicy, "qc_passed", "ready_to_ship", ["completeShipmentReadiness"]],
    [
      orderPolicy,
      "qc_passed",
      "recovery_pending",
      ["verifiedPostQcFailure", "replacementObligationCreated"],
    ],
    [
      orderPolicy,
      "awaiting_balance",
      "recovery_pending",
      ["verifiedPostQcFailure", "replacementObligationCreated"],
    ],
    [
      orderPolicy,
      "ready_to_ship",
      "recovery_pending",
      ["verifiedPostQcFailure", "replacementObligationCreated"],
    ],
    [
      singleOrderPhasePolicy,
      "qc_passed",
      "recovery_pending",
      ["verifiedPostQcFailure", "replacementObligationCreated"],
    ],
    [
      orderPolicy,
      "awaiting_balance",
      "cancelled_settled",
      ["balanceCaptureClosed", "immutableOrderSettlementCompleted"],
    ],
    [
      orderPolicy,
      "shipped",
      "cancelled",
      ["recoveryFinancialSettlementCompleted"],
    ],
    [
      orderPolicy,
      "recovery_pending",
      "cancelled",
      ["recoveryFinancialSettlementCompleted"],
    ],
    [
      singleOrderPhasePolicy,
      "shipped",
      "cancelled_refunded",
      ["recoveryFinancialSettlementCompleted"],
    ],
    [
      singleOrderPhasePolicy,
      "recovery_pending",
      "cancelled_refunded",
      ["recoveryFinancialSettlementCompleted"],
    ],
    [
      shipmentPolicy,
      "planned",
      "cancelled",
      [
        "shipmentJobsAndReservationsReleased",
        "parentCancellationBarrierReleased",
      ],
    ],
    [
      shipmentPolicy,
      "label_created",
      "cancellation_pending",
      ["labelInvalidated", "providerVoidOutboxCreated"],
    ],
    [
      shipmentPolicy,
      "cancellation_pending",
      "cancelled",
      [
        "shipmentJobsAndReservationsReleased",
        "parentCancellationBarrierReleased",
      ],
    ],
    [
      shipmentPolicy,
      "handed_over",
      "in_transit",
      ["providerEventAuthenticated", "providerEventVerified"],
    ],
    [
      shipmentPolicy,
      "lost",
      "recovered",
      [
        "providerEventAuthenticated",
        "providerEventVerified",
        "custodyConfirmed",
      ],
    ],
    [
      claimSlotResolutionPolicy,
      "pending",
      "reship_pending",
      ["reshipmentAuthorizationCreated", "reshipmentAuthorizationSetupAtomic"],
    ],
    [
      claimSlotResolutionPolicy,
      "recovery_pending",
      "reship_pending",
      ["reshipmentAuthorizationCreated", "reshipmentAuthorizationSetupAtomic"],
    ],
  ] as const)(
    "rejects %s -> %s when %s is missing",
    (policy, current, target, flags) => {
      for (const flag of flags) {
        expect(() =>
          transition(policy, {
            current,
            target,
            idempotencyKey: `missing-${current}-${target}-${flag}`,
            context: { ...contextForTransition(target), [flag]: false },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it.each([
    [jobPolicy, "created", "cancelled"],
    [jobPolicy, "accepted", "gcode_ready"],
    [jobPolicy, "printed", "photo_submitted"],
    [jobPolicy, "photo_submitted", "qc_approved"],
    [jobPolicy, "photo_submitted", "qc_rejected"],
    [paymentPolicy, "pending", "failed"],
    [paymentPolicy, "pending", "voided"],
    [paymentPolicy, "captured", "refund_pending"],
    [paymentPolicy, "partially_refunded", "refund_pending"],
    [orderPolicy, "draft", "quoted"],
    [orderPolicy, "qc_passed", "ready_to_ship"],
    [orderPolicy, "qc_passed", "recovery_pending"],
    [orderPolicy, "awaiting_balance", "recovery_pending"],
    [orderPolicy, "ready_to_ship", "recovery_pending"],
    [orderPolicy, "awaiting_balance", "cancelled_settled"],
    [orderPolicy, "shipped", "cancelled"],
    [orderPolicy, "recovery_pending", "cancelled"],
    [singleOrderPhasePolicy, "qc_passed", "recovery_pending"],
    [singleOrderPhasePolicy, "shipped", "cancelled_refunded"],
    [singleOrderPhasePolicy, "recovery_pending", "cancelled_refunded"],
    [shipmentPolicy, "planned", "cancelled"],
    [shipmentPolicy, "label_created", "cancellation_pending"],
    [shipmentPolicy, "cancellation_pending", "cancelled"],
    [shipmentPolicy, "handed_over", "in_transit"],
    [shipmentPolicy, "lost", "recovered"],
    [claimSlotResolutionPolicy, "pending", "reship_pending"],
    [claimSlotResolutionPolicy, "recovery_pending", "reship_pending"],
  ] as const)(
    "accepts %s -> %s with complete command evidence",
    (policy, current, target) => {
      expect(
        transition(policy, {
          current,
          target,
          idempotencyKey: `complete-${current}-${target}`,
          context: contextForTransition(target),
        }),
      ).toEqual({ kind: "changed", previous: current, current: target });
    },
  );

  it.each([
    ["created", "cancelled"],
    ["accepted", "failed"],
    ["gcode_ready", "failed"],
    ["printing", "failed"],
    ["printed", "failed"],
    ["photo_submitted", "failed"],
    ["qc_approved", "failed"],
    ["packed", "failed"],
  ] as const)(
    "requires valid Job cancellation/failure details for %s -> %s",
    (current, target) => {
      const context = contextForTransition(target);
      expect(() =>
        transition(jobPolicy, {
          current,
          target,
          idempotencyKey: `job-details-${current}-${target}`,
          context: {
            ...context,
            ...(target === "cancelled"
              ? { cancellationReason: "not-a-reason" }
              : { failureStage: "not-a-stage", failureReason: " " }),
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["providerEventPaymentId", "another-payment"],
    ["providerPaymentEventStatus", "voided"],
  ] as const)(
    "rejects Payment failure with a non-matching provider event %s",
    (field, value) => {
      expect(() =>
        transition(paymentPolicy, {
          current: "pending",
          target: "failed",
          idempotencyKey: `payment-failure-${field}`,
          context: { ...contextForTransition("failed"), [field]: value },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["failureStage", "not-a-stage"],
    ["failureReason", "   "],
  ] as const)("rejects a failed Job with invalid %s", (field, value) => {
    expect(() =>
      transition(jobPolicy, {
        current: "printing",
        target: "failed",
        idempotencyKey: `job-failure-${field}`,
        context: { ...contextForTransition("failed"), [field]: value },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    ["providerEventShipmentId", "another-shipment"],
    ["providerEventStatus", "lost"],
  ] as const)(
    "rejects Shipment recovery with a non-matching provider event %s",
    (field, value) => {
      expect(() =>
        transition(shipmentPolicy, {
          current: "lost",
          target: "recovered",
          idempotencyKey: `shipment-recovery-${field}`,
          context: { ...contextForTransition("recovered"), [field]: value },
        }),
      ).toThrow(TransitionGuardError);
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

  it("rejects sparse child disposition arrays", () => {
    const sparseClaimStatuses = ["refunded"] as string[];
    sparseClaimStatuses.length = 2;

    expect(() =>
      transition(claimPolicy, {
        current: "active",
        target: "resolved_refund",
        idempotencyKey: "claim-sparse-dispositions",
        context: {
          claimSlotResolutionStatuses: sparseClaimStatuses,
          cleanPostDeliveryQualityClaim: true,
        },
      }),
    ).toThrow(TransitionGuardError);
  });
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
