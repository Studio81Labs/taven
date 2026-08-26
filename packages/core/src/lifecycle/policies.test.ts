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
  quoteRequestId: "quote-request-1",
  issuedQuoteId: "quote-1",
  issuedQuoteRequestId: "quote-request-1",
  quoteExpirationQuoteRequestId: "quote-request-1",
  quoteExpirationIssuedQuoteId: "quote-1",
  issuedQuoteExpiresAt: Instant.parse("2026-01-02T00:00:00.000Z"),
  quoteExpirationEvaluatedAt: Instant.parse("2026-01-02T00:00:00.000Z"),
  createdOrderQuoteRequestId: "quote-request-1",
  createdOrderSourceQuoteId: "quote-1",
  acceptedOrderId: "order-1",
  createdOrderStatus: "draft",
  orderCreated: true,
  quoteAcceptanceOrderCreationAtomic: true,
  captureAuthorized: true,
  verifiedLateCapture: true,
  paymentId: "payment-1",
  paymentRole: "full",
  paymentCaptureKind: "settlement",
  providerEventPaymentId: "payment-1",
  providerPaymentTransactionId: "provider-transaction-1",
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
  orderId: "order-1",
  initialPaymentId: "payment-1",
  initialPaymentOrderId: "order-1",
  initialCaptureCloseOrderId: "order-1",
  initialCaptureClosePaymentId: "payment-1",
  initialPaymentRole: "full",
  initialPaymentStatus: "voided",
  initialCaptureWindowClosed: true,
  initialCaptureCutoffSet: true,
  initialPaymentVoidOutboxCreated: true,
  preCapturePhaseCancelled: true,
  preCaptureFulfilmentSlotsCancelled: true,
  preCaptureReservationsReleased: true,
  initialCaptureCloseAtomic: true,
  phaseReservationSetId: "phase-reservation-set-1",
  initialCapacityReacquisitionOrderId: "order-1",
  initialCapacityReacquisitionPhaseId: "phase-1",
  initialCapacityReacquisitionReservationSetId: "phase-reservation-set-1",
  initialCaptureBeforeCutoff: true,
  initialCapacityReacquisitionAttempted: true,
  initialCapacityReacquisitionWholeSet: true,
  initialCapacityReacquisitionFailed: true,
  capacityCaptureCompensationPaymentId: "payment-1",
  capacityCaptureRefundTransactionPaymentId: "payment-1",
  capacityCaptureCompensationProviderTransactionId: "provider-transaction-1",
  capacityCaptureRefundTransactionProviderTransactionId:
    "provider-transaction-1",
  capacityCaptureCompensationRefundTransactionId: "refund-1",
  capacityCaptureCompensationCreated: true,
  capacityCaptureRefundIsFull: true,
  capacityCaptureRefundIdempotencyKeyValid: true,
  capacityCaptureExcludedFromSettlement: true,
  capacityCaptureActivationSuppressed: true,
  initialCapacityCaptureWindowClosed: true,
  initialCapacityCaptureCutoffSet: true,
  capacityCaptureCompensationAtomic: true,
  capacityCaptureCompensationKind: "initial_checkout_capacity",
  capacityCaptureOrderTargetStatus: "cancelled",
  capacityCapturePhaseTargetStatus: "cancelled",
  capacityCaptureJobsCreated: false,
  compensationRefundOutstanding: true,
  compensationRefundRetryAtomic: true,
  lateCaptureCompensationPaymentId: "payment-1",
  lateCaptureCompensationProviderTransactionId: "provider-transaction-1",
  lateCaptureRefundTransactionPaymentId: "payment-1",
  lateCaptureRefundTransactionProviderTransactionId: "provider-transaction-1",
  lateCaptureCompensationRefundTransactionId: "refund-1",
  lateCaptureCompensationCreated: true,
  lateCaptureRefundIsFull: true,
  lateCaptureRefundIdempotencyKeyValid: true,
  lateCaptureExcludedFromSettlement: true,
  lateCaptureCompensationAtomic: true,
  scopedRefundTransactionCreated: true,
  refundPriceAdjustmentActivated: true,
  singleOrderPhaseCreated: true,
  immutableFulfilmentSlotsCreated: true,
  setupAtomic: true,
  completeReservationCaptured: true,
  confirmationActivationOrderId: "order-1",
  confirmationActivationPhaseId: "phase-1",
  confirmationActivationPhaseReservationSetId: "phase-reservation-set-1",
  confirmationActivationPaymentId: "payment-1",
  confirmationActivationProviderTransactionId: "provider-transaction-1",
  confirmationOrderPreviousStatus: "quoted",
  confirmationOrderTargetStatus: "confirmed",
  confirmationPhasePreviousStatus: "quoted",
  confirmationPhaseTargetStatus: "active",
  confirmationActivationAtomic: true,
  initialCaptureConfirmationAtomic: true,
  phaseReservationSetPlannedJobKeys: ["planned-job-1", "planned-job-2"],
  confirmationReservationJobLinks: [
    {
      plannedJobKey: "planned-job-1",
      productionReservationId: "confirmation-reservation-1",
      jobId: "confirmation-job-1",
      reservationOrderId: "order-1",
      reservationPhaseId: "phase-1",
      reservationSetId: "phase-reservation-set-1",
      reservationPlannedJobKey: "planned-job-1",
      reservationJobId: "confirmation-job-1",
      jobOrderId: "order-1",
      jobPhaseId: "phase-1",
      jobProductionReservationId: "confirmation-reservation-1",
      jobPlannedJobKey: "planned-job-1",
      jobStatus: "created",
    },
    {
      plannedJobKey: "planned-job-2",
      productionReservationId: "confirmation-reservation-2",
      jobId: "confirmation-job-2",
      reservationOrderId: "order-1",
      reservationPhaseId: "phase-1",
      reservationSetId: "phase-reservation-set-1",
      reservationPlannedJobKey: "planned-job-2",
      reservationJobId: "confirmation-job-2",
      jobOrderId: "order-1",
      jobPhaseId: "phase-1",
      jobProductionReservationId: "confirmation-reservation-2",
      jobPlannedJobKey: "planned-job-2",
      jobStatus: "created",
    },
  ],
  confirmationJobsCreated: true,
  confirmationJobCreationAtomic: true,
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
  jobId: "job-1",
  phaseId: "phase-1",
  phaseKind: "single",
  phaseCancellationOrderId: "order-1",
  phaseCancellationPhaseOrderId: "order-1",
  phaseCancellationPhaseId: "phase-1",
  phaseCancellationOrderPreviousStatus: "confirmed",
  phaseCancellationOrderTargetStatus: "cancelled",
  phaseCancellationPhasePreviousStatus: "active",
  phaseCancellationPhaseTargetStatus: "cancelled",
  phaseCancellationCompleted: true,
  phaseCancellationAtomic: true,
  orderCompletionOrderId: "order-1",
  orderCompletionPhaseOrderId: "order-1",
  orderCompletionPhaseId: "phase-1",
  orderCompletionOrderPreviousStatus: "delivered",
  orderCompletionOrderTargetStatus: "completed",
  orderCompletionPhasePreviousStatus: "delivered",
  orderCompletionPhaseTargetStatus: "completed",
  phaseCompletionCompleted: true,
  orderPhaseCompletionAtomic: true,
  productionStartOrderId: "order-1",
  productionStartPhaseOrderId: "order-1",
  productionStartPhaseId: "phase-1",
  productionStartOrderPreviousStatus: "confirmed",
  productionStartOrderTargetStatus: "in_production",
  productionStartPhasePreviousStatus: "active",
  productionStartPhaseTargetStatus: "in_production",
  productionStartCompleted: true,
  productionStartAtomic: true,
  orderTerminalPhaseOrderId: "order-1",
  orderTerminalPhaseOwnerOrderId: "order-1",
  orderTerminalPhaseId: "phase-1",
  orderTerminalPhaseOrderPreviousStatus: "cancelled",
  orderTerminalPhaseOrderTargetStatus: "refunded",
  orderTerminalPhasePreviousStatus: "cancelled",
  orderTerminalPhaseTargetStatus: "cancelled_refunded",
  orderTerminalPhaseIntermediateStatus: undefined,
  orderTerminalPhaseCancellationCompleted: true,
  orderTerminalPhaseCompleted: true,
  orderTerminalPhaseCommittedBeforeOrder: false,
  orderTerminalPhaseAtomic: true,
  orderItemId: "order-item-1",
  nodeAssigned: true,
  cancellationReason: "order_cancelled",
  offersClosed: true,
  productionReservationReleased: true,
  productionReservationId: "production-reservation-1",
  productionReservationJobId: "job-1",
  acceptanceReservationJobId: "job-1",
  acceptanceProductionReservationId: "production-reservation-1",
  acceptanceMaterialPreviousState: "held",
  acceptanceMaterialTargetState: "allocated",
  acceptanceCapacityPreviousState: "held",
  acceptanceCapacityTargetState: "scheduled",
  reproductionArtifactVersionId: "artifact-version-1",
  acceptanceArtifactVersionId: "artifact-version-1",
  reproductionArtifactVersionStatus: "draft",
  reproductionArtifactVersionJobId: "job-1",
  reproductionArtifactVersionOrderItemId: "order-item-1",
  reproductionArtifactVersionPhaseId: "phase-1",
  reproductionArtifactVersionProductionReservationId:
    "production-reservation-1",
  productionReservationCandidateResourceEstimateId: "estimate-1",
  reproductionArtifactVersionCandidateResourceEstimateId: "estimate-1",
  productionReservationMachineProfileId: "profile-1",
  reproductionArtifactVersionMachineProfileId: "profile-1",
  productionReservationMachineCalibrationId: "calibration-1",
  reproductionArtifactVersionMachineCalibrationId: "calibration-1",
  productionReservationPrintConfigRevisionId: "config-revision-1",
  reproductionArtifactVersionPrintConfigRevisionId: "config-revision-1",
  acceptanceArtifactCreated: true,
  jobAcceptanceAtomic: true,
  jobResourceSettlementJobId: "job-1",
  jobResourceSettlementProductionReservationId: "production-reservation-1",
  jobResourceSettlementAtomic: true,
  printingReservationJobId: "job-1",
  printingReservationProductionReservationId: "production-reservation-1",
  printingReservationState: "printing",
  printingReservationCommitAtomic: true,
  materialConsumptionMode: "zero_pre_print",
  materialConsumptionSettled: true,
  inventoryReservationReleased: true,
  capacityReservationReleased: true,
  labelCancellationBarrierCompleted: true,
  failureStage: "machine",
  failureReason: "machine fault",
  replacementRequestCreated: true,
  replacementDeadlineSet: true,
  postQcFailureJobId: "job-1",
  postQcFailurePhaseId: "phase-1",
  postQcFailurePhaseKind: "single",
  postQcFailureOrderId: "order-1",
  postQcFailureResolutionAtomic: true,
  postQcFailureResolutionKind: "pre_handoff_recovery",
  phaseHasPriorHandoff: false,
  postQcFailurePhasePreviousStatus: "qc_passed",
  postQcFailurePhaseTargetStatus: "recovery_pending",
  postQcFailureOrderPreviousStatus: "qc_passed",
  postQcFailureOrderTargetStatus: "recovery_pending",
  postQcFailureBalanceDeadlineResult: "not_active",
  jobShipmentPlanId: "shipment-plan-1",
  jobFulfilmentSlotIds: ["slot-1"],
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
  claimId: "claim-1",
  claimResolutionSetClaimId: "claim-1",
  expectedClaimSlotResolutionIds: ["claim-resolution-1"],
  expectedClaimSlotIds: ["claim-slot-1"],
  expectedClaimResolutionSlots: [
    { resolutionId: "claim-resolution-1", slotId: "claim-slot-1" },
  ],
  claimSlotResolutions: [
    {
      id: "claim-resolution-1",
      claimId: "claim-1",
      slotId: "claim-slot-1",
      activeClaimIdBefore: "claim-1",
      activeClaimIdAfter: null,
      status: "refunded",
    },
  ],
  claimResolutionSetComplete: true,
  claimSlotOwnershipReleased: true,
  claimRetentionClaimId: "claim-1",
  claimRetentionHoldPreviousStatus: "active_claim",
  claimRetentionHoldTargetStatus: "released",
  claimRetentionPreviousDeleteAfter: Instant.parse("2026-02-01T00:00:00.000Z"),
  claimRetentionTargetDeleteAfter: Instant.parse("2026-02-02T00:00:00.000Z"),
  claimRetentionDeadlineRecomputed: true,
  claimRetentionReleased: true,
  claimTerminalCleanupAtomic: true,
  remedyCancellationCompleted: true,
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
  incidentShipmentId: "shipment-1",
  incidentOrderId: "order-1",
  incidentPhaseId: "phase-1",
  shipmentFulfilmentSlotIds: ["slot-1", "slot-2"],
  incidentAffectedSlotIds: ["slot-1", "slot-2"],
  shipmentIncidentSlotOwnerships: [
    { slotId: "slot-1", activeClaimId: null },
    { slotId: "slot-2", activeClaimId: null },
  ],
  shipmentOriginClaimId: null,
  shipmentIncidentNewClaim: {
    id: "incident-claim-1",
    origin: "shipment_incident",
    shipmentId: "shipment-1",
    orderId: "order-1",
    phaseId: "phase-1",
    status: "active",
    retentionHoldActive: true,
  },
  shipmentIncidentSlotRoutes: [
    {
      slotId: "slot-1",
      ownerClaimId: null,
      routedClaimId: "incident-claim-1",
      incidentRecordId: "incident-record-1",
      incidentRecordShipmentId: "shipment-1",
      incidentRecordClaimId: "incident-claim-1",
      incidentRecordSlotId: "slot-1",
      childResolutionId: "incident-resolution-1",
      childResolutionClaimId: "incident-claim-1",
      childResolutionSlotId: "slot-1",
      childResolutionShipmentId: "shipment-1",
      childResolutionStatus: "recovery_pending",
      claimStatus: "active",
      claimRetentionHoldActive: true,
      createdNewClaim: true,
    },
    {
      slotId: "slot-2",
      ownerClaimId: null,
      routedClaimId: "incident-claim-1",
      incidentRecordId: "incident-record-2",
      incidentRecordShipmentId: "shipment-1",
      incidentRecordClaimId: "incident-claim-1",
      incidentRecordSlotId: "slot-2",
      childResolutionId: "incident-resolution-2",
      childResolutionClaimId: "incident-claim-1",
      childResolutionSlotId: "slot-2",
      childResolutionShipmentId: "shipment-1",
      childResolutionStatus: "recovery_pending",
      claimStatus: "active",
      claimRetentionHoldActive: true,
      createdNewClaim: true,
    },
  ],
  shipmentIncidentRouted: true,
  shipmentIncidentRoutingAtomic: true,
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

function claimResolutionEvidence(statuses: readonly string[]) {
  const expectedClaimSlotResolutionIds = statuses.map(
    (_status, index) => `claim-resolution-${index + 1}`,
  );
  const expectedClaimSlotIds = statuses.map(
    (_status, index) => `claim-slot-${index + 1}`,
  );
  return {
    claimId: "claim-1",
    claimResolutionSetClaimId: "claim-1",
    expectedClaimSlotResolutionIds,
    expectedClaimSlotIds,
    expectedClaimResolutionSlots: expectedClaimSlotResolutionIds.map(
      (resolutionId, index) => ({
        resolutionId,
        slotId: expectedClaimSlotIds[index],
      }),
    ),
    claimSlotResolutions: statuses.map((status, index) => ({
      id: expectedClaimSlotResolutionIds[index],
      claimId: "claim-1",
      slotId: expectedClaimSlotIds[index],
      activeClaimIdBefore: "claim-1",
      activeClaimIdAfter: null,
      status,
    })),
    claimResolutionSetComplete: true,
    claimSlotOwnershipReleased: true,
    claimRetentionClaimId: "claim-1",
    claimRetentionHoldPreviousStatus: "active_claim",
    claimRetentionHoldTargetStatus: "released",
    claimRetentionPreviousDeleteAfter: Instant.parse(
      "2026-02-01T00:00:00.000Z",
    ),
    claimRetentionTargetDeleteAfter: Instant.parse("2026-02-02T00:00:00.000Z"),
    claimRetentionDeadlineRecomputed: true,
    claimRetentionReleased: true,
    claimTerminalCleanupAtomic: true,
  };
}

function orderCancellationPhaseDisposition(current?: string): {
  readonly previous: string;
  readonly target: string;
} {
  if (current === "confirmed") {
    return { previous: "active", target: "cancelled" };
  }
  if (current === "in_production") {
    return { previous: "in_production", target: "cancelled" };
  }
  if (current === "shipped") {
    return { previous: "shipped", target: "cancelled_refunded" };
  }
  if (current === "recovery_pending") {
    return { previous: "recovery_pending", target: "cancelled_refunded" };
  }
  return { previous: "qc_passed", target: "cancelled" };
}

function orderTerminalPhaseDisposition(
  current?: string,
  target?: string,
): {
  readonly previous: string;
  readonly intermediate: string | undefined;
  readonly target: string;
} {
  if (target === "partially_fulfilled") {
    return {
      previous: current === "recovery_pending" ? "recovery_pending" : "shipped",
      intermediate: undefined,
      target: "partially_fulfilled",
    };
  }
  if (current === "awaiting_balance" && target === "cancelled_settled") {
    return {
      previous: "qc_passed",
      intermediate: "cancelled",
      target: "cancelled_settled",
    };
  }
  return {
    previous: "cancelled",
    intermediate: undefined,
    target: target === "refunded" ? "cancelled_refunded" : "cancelled_settled",
  };
}

function contextForTransition(target: string, current?: string) {
  const cancellationPhaseDisposition =
    orderCancellationPhaseDisposition(current);
  const terminalPhaseDisposition = orderTerminalPhaseDisposition(
    current,
    target,
  );
  const claimSlotResolutionStatuses = claimSlotStatusesForTarget(target);
  const resolutionEvidence = claimResolutionEvidence(
    claimSlotResolutionStatuses,
  );
  const capacityCaptureCompensation =
    current === "pending" && target === "refund_pending";
  const lateCaptureCompensation =
    current === "voided" && target === "refund_pending";
  const remedyIncident =
    target === "recovery_pending" &&
    (current === "replacement_shipped" || current === "reship_shipped");
  const failureStage =
    current === "printing"
      ? "printing"
      : current === "printed" || current === "photo_submitted"
        ? "post_print"
        : current === "qc_approved"
          ? "post_qc"
          : current === "packed"
            ? "packing"
            : "machine";
  const materialConsumptionMode =
    current === "gcode_ready" && target === "printing"
      ? "actual_recorded"
      : current === "accepted" || current === "gcode_ready"
        ? "zero_pre_print"
        : "actual_recorded";
  return {
    ...permittedContext,
    failureStage,
    materialConsumptionMode,
    initialPaymentStatus: capacityCaptureCompensation
      ? "refund_pending"
      : permittedContext.initialPaymentStatus,
    paymentCaptureKind: capacityCaptureCompensation
      ? "initial_checkout_capacity"
      : lateCaptureCompensation
        ? "late_capture"
        : permittedContext.paymentCaptureKind,
    refundWebhookProjectedTarget: target,
    providerPaymentEventStatus:
      (current === "voided" || current === "pending") &&
      target === "refund_pending"
        ? "captured"
        : target,
    initialCaptureCloseReason:
      target === "expired" ? "checkout_expired" : "checkout_cancelled",
    currentRemedyShipmentLineageLeafStatus: remedyIncident
      ? "lost"
      : permittedContext.currentRemedyShipmentLineageLeafStatus,
    providerEventStatus: remedyIncident
      ? "lost"
      : target === "delivered_reship" || target === "delivered_reprint"
        ? "delivered"
        : target,
    claimSlotResolutionStatuses,
    ...resolutionEvidence,
    financialTerminalTarget: target,
    completionProjectedTarget: target,
    phaseCancellationOrderPreviousStatus: current,
    phaseCancellationPhasePreviousStatus: cancellationPhaseDisposition.previous,
    phaseCancellationPhaseTargetStatus: cancellationPhaseDisposition.target,
    orderTerminalPhaseOrderPreviousStatus: current,
    orderTerminalPhaseOrderTargetStatus: target,
    orderTerminalPhasePreviousStatus: terminalPhaseDisposition.previous,
    orderTerminalPhaseIntermediateStatus: terminalPhaseDisposition.intermediate,
    orderTerminalPhaseTargetStatus: terminalPhaseDisposition.target,
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
              context: contextForTransition(target, current),
            }),
          name,
        ).toThrow(InvalidTransitionError);
      } else {
        expect(
          transition(policy, {
            current,
            target,
            idempotencyKey: "new",
            context: contextForTransition(target, current),
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
    [quoteRequestPolicy, "quoted", "expired"],
    [paymentPolicy, "pending", "captured"],
    [paymentPolicy, "pending", "refund_pending"],
    [paymentPolicy, "voided", "refund_pending"],
    [paymentPolicy, "refund_pending", "partially_refunded"],
    [paymentPolicy, "refund_pending", "refunded"],
    [orderPolicy, "quoted", "confirmed"],
    [orderPolicy, "confirmed", "in_production"],
    [orderPolicy, "in_production", "qc_passed"],
    [orderPolicy, "recovery_pending", "qc_passed"],
    [orderPolicy, "qc_passed", "awaiting_balance"],
    [orderPolicy, "qc_passed", "ready_to_ship"],
    [orderPolicy, "ready_to_ship", "shipped"],
    [orderPolicy, "awaiting_balance", "shipped"],
    [orderPolicy, "awaiting_balance", "ready_to_ship"],
    [orderPolicy, "shipped", "delivered"],
    [singleOrderPhasePolicy, "quoted", "active"],
    [singleOrderPhasePolicy, "active", "in_production"],
    [singleOrderPhasePolicy, "in_production", "qc_passed"],
    [singleOrderPhasePolicy, "recovery_pending", "qc_passed"],
    [singleOrderPhasePolicy, "shipped", "delivered"],
    [jobPolicy, "created", "accepted"],
    [jobPolicy, "gcode_ready", "printing"],
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

  it.each([
    ["quoteAvailable", false],
    ["quoteRequestId", ""],
    ["quoteRequestId", " "],
    ["issuedQuoteRequestId", "another-request"],
    ["createdOrderQuoteRequestId", "another-request"],
    ["issuedQuoteId", ""],
    ["issuedQuoteId", "\t"],
    ["createdOrderSourceQuoteId", "another-quote"],
    ["orderId", ""],
    ["orderId", "\n"],
    ["acceptedOrderId", "another-order"],
    ["createdOrderStatus", "quoted"],
    ["orderCreated", false],
    ["quoteAcceptanceOrderCreationAtomic", false],
  ] as const)(
    "rejects quote acceptance with invalid atomic Order evidence (%s)",
    (field, value) => {
      expect(() =>
        transition(quoteRequestPolicy, {
          current: "quoted",
          target: "accepted",
          idempotencyKey: `quote-acceptance-${field}`,
          context: { ...permittedContext, [field]: value },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["quoteRequestId", " "],
    ["issuedQuoteRequestId", "another-request"],
    ["quoteExpirationQuoteRequestId", "another-request"],
    ["issuedQuoteId", "\t"],
    ["quoteExpirationIssuedQuoteId", "another-quote"],
    ["issuedQuoteExpiresAt", "2026-01-02T00:00:00.000Z"],
    ["quoteExpirationEvaluatedAt", "2026-01-02T00:00:00.000Z"],
    ["quoteExpirationEvaluatedAt", Instant.parse("2026-01-01T23:59:59.999Z")],
  ] as const)("rejects quote expiration with invalid %s", (field, value) => {
    expect(() =>
      transition(quoteRequestPolicy, {
        current: "quoted",
        target: "expired",
        idempotencyKey: `quote-expiration-${field}`,
        context: { ...permittedContext, [field]: value },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    ["orderId", ""],
    ["orderId", " "],
    ["confirmationActivationOrderId", "another-order"],
    ["phaseId", ""],
    ["phaseId", "\t"],
    ["confirmationActivationPhaseId", "another-phase"],
    ["phaseReservationSetId", ""],
    ["phaseReservationSetId", "\n"],
    ["confirmationActivationPhaseReservationSetId", "another-reservation-set"],
    ["confirmationActivationPaymentId", "another-payment"],
    ["paymentRole", "balance"],
    ["initialPaymentRole", "balance"],
    ["initialPaymentId", "another-payment"],
    ["initialPaymentOrderId", "another-order"],
    [
      "confirmationActivationProviderTransactionId",
      "another-provider-transaction",
    ],
    ["phaseKind", "sample"],
    ["confirmationOrderPreviousStatus", "draft"],
    ["confirmationOrderTargetStatus", "quoted"],
    ["confirmationPhasePreviousStatus", "active"],
    ["confirmationPhaseTargetStatus", "quoted"],
    ["completeReservationCaptured", false],
    ["confirmationActivationAtomic", false],
    ["phaseReservationSetPlannedJobKeys", []],
    ["confirmationReservationJobLinks", []],
    ["confirmationJobsCreated", false],
    ["confirmationJobCreationAtomic", false],
  ] as const)(
    "rejects partial Order/phase confirmation with invalid %s",
    (field, value) => {
      for (const [policy, current, target] of [
        [orderPolicy, "quoted", "confirmed"],
        [singleOrderPhasePolicy, "quoted", "active"],
        [paymentPolicy, "pending", "captured"],
      ] as const) {
        expect(() =>
          transition(policy, {
            current,
            target,
            idempotencyKey: `confirmation-activation-${target}-${field}`,
            context: { ...permittedContext, [field]: value },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it.each(["full", "deposit"] as const)(
    "atomically activates checkout for an initial %s capture",
    (paymentRole) => {
      expect(
        transition(paymentPolicy, {
          current: "pending",
          target: "captured",
          idempotencyKey: `initial-capture-activation-${paymentRole}`,
          context: {
            ...contextForTransition("captured", "pending"),
            paymentRole,
            initialPaymentRole: paymentRole,
          },
        }),
      ).toEqual({
        kind: "changed",
        previous: "pending",
        current: "captured",
      });
    },
  );

  it.each([
    ["paymentRole", undefined],
    ["paymentRole", "adjustment"],
    ["initialPaymentRole", "balance"],
    ["initialPaymentId", "another-payment"],
    ["initialPaymentOrderId", "another-order"],
    ["initialCaptureConfirmationAtomic", false],
  ] as const)(
    "rejects initial capture activation with invalid %s",
    (field, value) => {
      expect(() =>
        transition(paymentPolicy, {
          current: "pending",
          target: "captured",
          idempotencyKey: `initial-capture-activation-${field}`,
          context: {
            ...contextForTransition("captured", "pending"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("captures a balance Payment without reactivating initial checkout", () => {
    expect(
      transition(paymentPolicy, {
        current: "pending",
        target: "captured",
        idempotencyKey: "balance-capture-without-checkout-activation",
        context: {
          ...contextForTransition("captured", "pending"),
          paymentRole: "balance",
          balancePaymentRole: "balance",
          confirmationActivationAtomic: false,
          initialCaptureConfirmationAtomic: false,
        },
      }),
    ).toEqual({
      kind: "changed",
      previous: "pending",
      current: "captured",
    });
  });

  it.each([undefined, "deposit"] as const)(
    "rejects a balance capture with persisted balance role %s",
    (balancePaymentRole) => {
      expect(() =>
        transition(paymentPolicy, {
          current: "pending",
          target: "captured",
          idempotencyKey: `balance-capture-role-${balancePaymentRole}`,
          context: {
            ...contextForTransition("captured", "pending"),
            paymentRole: "balance",
            balancePaymentRole,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("rejects incomplete or non-bijective confirmation Job links", () => {
    const firstLink = permittedContext.confirmationReservationJobLinks[0];
    const secondLink = permittedContext.confirmationReservationJobLinks[1];
    const sparseKeys = ["planned-job-1"] as string[];
    sparseKeys.length = 2;
    const sparseLinks = [firstLink] as Array<typeof firstLink | undefined>;
    sparseLinks.length = 2;
    const invalidContexts = [
      {
        phaseReservationSetPlannedJobKeys: ["planned-job-1"],
      },
      {
        phaseReservationSetPlannedJobKeys: ["planned-job-1", "planned-job-1"],
      },
      { phaseReservationSetPlannedJobKeys: sparseKeys },
      { confirmationReservationJobLinks: sparseLinks },
      { confirmationReservationJobLinks: [firstLink] },
      {
        confirmationReservationJobLinks: [
          firstLink,
          {
            ...secondLink,
            plannedJobKey: "foreign-key",
            reservationPlannedJobKey: "foreign-key",
            jobPlannedJobKey: "foreign-key",
          },
        ],
      },
      {
        confirmationReservationJobLinks: [
          firstLink,
          {
            ...secondLink,
            productionReservationId: firstLink.productionReservationId,
            jobProductionReservationId: firstLink.productionReservationId,
          },
        ],
      },
      {
        confirmationReservationJobLinks: [
          firstLink,
          {
            ...secondLink,
            jobId: firstLink.jobId,
            reservationJobId: firstLink.jobId,
          },
        ],
      },
      {
        confirmationReservationJobLinks: [
          firstLink,
          { ...secondLink, reservationJobId: "another-job" },
        ],
      },
      {
        confirmationReservationJobLinks: [
          firstLink,
          { ...secondLink, reservationOrderId: "another-order" },
        ],
      },
      {
        confirmationReservationJobLinks: [
          firstLink,
          { ...secondLink, reservationPhaseId: "another-phase" },
        ],
      },
      {
        confirmationReservationJobLinks: [
          firstLink,
          { ...secondLink, reservationSetId: "another-set" },
        ],
      },
      {
        confirmationReservationJobLinks: [
          firstLink,
          { ...secondLink, jobProductionReservationId: "another-reservation" },
        ],
      },
      {
        confirmationReservationJobLinks: [
          firstLink,
          { ...secondLink, jobStatus: "accepted" },
        ],
      },
    ];
    for (const [index, invalidContext] of invalidContexts.entries()) {
      for (const [policy, current, target] of [
        [paymentPolicy, "pending", "captured"],
        [orderPolicy, "quoted", "confirmed"],
        [singleOrderPhasePolicy, "quoted", "active"],
      ] as const) {
        expect(() =>
          transition(policy, {
            current,
            target,
            idempotencyKey: `confirmation-job-links-${index}-${target}`,
            context: {
              ...contextForTransition(target, current),
              ...invalidContext,
            },
          }),
        ).toThrow(TransitionGuardError);
      }
    }
  });

  it.each([
    [orderPolicy, "delivered", "completed"],
    [orderPolicy, "shipped", "partially_fulfilled"],
    [orderPolicy, "recovery_pending", "partially_fulfilled"],
    [singleOrderPhasePolicy, "delivered", "completed"],
    [singleOrderPhasePolicy, "shipped", "partially_fulfilled"],
    [singleOrderPhasePolicy, "recovery_pending", "partially_fulfilled"],
  ] as const)(
    "blocks terminal fulfilment for %s %s -> %s until both balances settle",
    (policy, current, target) => {
      for (const [amountDueMinor, refundableBalanceMinor] of [
        [1n, 0n],
        [0n, 1n],
      ] as const) {
        expect(() =>
          transition(policy, {
            current,
            target,
            idempotencyKey: `terminal-balance-${current}-${target}-${amountDueMinor}-${refundableBalanceMinor}`,
            context: {
              ...permittedContext,
              completionProjected: true,
              completionProjectedTarget: target,
              amountDueMinor,
              refundableBalanceMinor,
            },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it.each([
    ["orderId", " "],
    ["orderCompletionOrderId", "another-order"],
    ["orderCompletionPhaseOrderId", "another-order"],
    ["phaseId", "\t"],
    ["orderCompletionPhaseId", "another-phase"],
    ["phaseKind", "sample"],
    ["orderCompletionOrderPreviousStatus", "shipped"],
    ["orderCompletionOrderTargetStatus", "delivered"],
    ["orderCompletionPhasePreviousStatus", "shipped"],
    ["orderCompletionPhaseTargetStatus", "delivered"],
    ["phaseCompletionCompleted", false],
    ["orderPhaseCompletionAtomic", false],
  ] as const)(
    "rejects Order/phase completion with invalid %s",
    (field, value) => {
      for (const policy of [orderPolicy, singleOrderPhasePolicy] as const) {
        expect(() =>
          transition(policy, {
            current: "delivered",
            target: "completed",
            idempotencyKey: `order-phase-completion-${policy.name}-${field}`,
            context: {
              ...contextForTransition("completed", "delivered"),
              [field]: value,
            },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it.each([
    ["orderId", " "],
    ["productionStartOrderId", "another-order"],
    ["productionStartPhaseOrderId", "another-order"],
    ["phaseId", "\t"],
    ["productionStartPhaseId", "another-phase"],
    ["phaseKind", "sample"],
    ["productionStartOrderPreviousStatus", "quoted"],
    ["productionStartOrderTargetStatus", "confirmed"],
    ["productionStartPhasePreviousStatus", "quoted"],
    ["productionStartPhaseTargetStatus", "active"],
    ["productionStartCompleted", false],
    ["productionStartAtomic", false],
  ] as const)(
    "rejects atomic production start with invalid %s",
    (field, value) => {
      for (const [policy, current] of [
        [orderPolicy, "confirmed"],
        [singleOrderPhasePolicy, "active"],
      ] as const) {
        expect(() =>
          transition(policy, {
            current,
            target: "in_production",
            idempotencyKey: `production-start-${policy.name}-${field}`,
            context: {
              ...contextForTransition("in_production", current),
              [field]: value,
            },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it.each([
    ["shipped", "partially_fulfilled"],
    ["recovery_pending", "partially_fulfilled"],
    ["cancelled", "refunded"],
    ["cancelled", "cancelled_settled"],
    ["awaiting_balance", "cancelled_settled"],
  ] as const)(
    "persists the exact terminal single-phase result for Order %s -> %s",
    (current, target) => {
      expect(
        transition(orderPolicy, {
          current,
          target,
          idempotencyKey: `order-terminal-phase-${current}-${target}`,
          context: contextForTransition(target, current),
        }),
      ).toEqual({ kind: "changed", previous: current, current: target });

      const baseContext = contextForTransition(target, current);
      for (const [field, value] of [
        ["orderId", " "],
        ["orderTerminalPhaseOrderId", "another-order"],
        ["orderTerminalPhaseOwnerOrderId", "another-order"],
        ["phaseId", "\t"],
        ["orderTerminalPhaseId", "another-phase"],
        ["phaseKind", "sample"],
        ["orderTerminalPhaseOrderPreviousStatus", "quoted"],
        ["orderTerminalPhaseOrderTargetStatus", "completed"],
        ["orderTerminalPhasePreviousStatus", "active"],
        ["orderTerminalPhaseTargetStatus", "completed"],
        ["orderTerminalPhaseCompleted", false],
        ["orderTerminalPhaseAtomic", false],
      ] as const) {
        expect(() =>
          transition(orderPolicy, {
            current,
            target,
            idempotencyKey: `order-terminal-phase-${current}-${target}-${field}`,
            context: { ...baseContext, [field]: value },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it.each([
    ["orderTerminalPhaseIntermediateStatus", undefined],
    ["orderTerminalPhaseCancellationCompleted", false],
    ["preHandoffShipmentCancellationsCompleted", false],
  ] as const)(
    "rejects direct balance settlement with invalid %s",
    (field, value) => {
      expect(() =>
        transition(orderPolicy, {
          current: "awaiting_balance",
          target: "cancelled_settled",
          idempotencyKey: `direct-balance-terminal-phase-${field}`,
          context: {
            ...contextForTransition("cancelled_settled", "awaiting_balance"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["shipped", "partially_fulfilled", "partially_fulfilled"],
    ["recovery_pending", "partially_fulfilled", "partially_fulfilled"],
    ["cancelled", "refunded", "cancelled_refunded"],
    ["cancelled", "cancelled_settled", "cancelled_settled"],
    ["awaiting_balance", "cancelled_settled", "cancelled_settled"],
  ] as const)(
    "accepts a terminal phase committed before Order %s -> %s",
    (current, target, phaseTarget) => {
      const context = {
        ...contextForTransition(target, current),
        orderTerminalPhasePreviousStatus: phaseTarget,
        orderTerminalPhaseIntermediateStatus: undefined,
        orderTerminalPhaseCommittedBeforeOrder: true,
        orderTerminalPhaseAtomic: false,
      };
      expect(
        transition(orderPolicy, {
          current,
          target,
          idempotencyKey: `terminal-phase-before-order-${current}-${target}`,
          context,
        }),
      ).toEqual({ kind: "changed", previous: current, current: target });
      expect(() =>
        transition(orderPolicy, {
          current,
          target,
          idempotencyKey: `terminal-phase-before-order-uncommitted-${current}-${target}`,
          context: {
            ...context,
            orderTerminalPhaseCommittedBeforeOrder: false,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("does not expose the phased in-production partial outcome in v0", () => {
    expect(() =>
      transition(orderPolicy, {
        current: "in_production",
        target: "partially_fulfilled",
        idempotencyKey: "v0-no-phased-partial-outcome",
        context: contextForTransition("partially_fulfilled", "in_production"),
      }),
    ).toThrow(InvalidTransitionError);
  });

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
            ...contextForTransition(target, "cancelled"),
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

  it.each([
    ["confirmed", "active", "cancelled"],
    ["in_production", "in_production", "cancelled"],
    ["qc_passed", "qc_passed", "cancelled"],
    ["awaiting_balance", "qc_passed", "cancelled"],
    ["ready_to_ship", "qc_passed", "cancelled"],
    ["shipped", "shipped", "cancelled_refunded"],
    ["recovery_pending", "recovery_pending", "cancelled_refunded"],
  ] as const)(
    "atomically cancels the exact %s Order phase from %s to %s",
    (current, phasePreviousStatus, phaseTargetStatus) => {
      for (const paymentStatus of ["unpaid", "paid"] as const) {
        expect(
          transition(orderPolicy, {
            current,
            target: "cancelled",
            idempotencyKey: `phase-parent-cancellation-${current}-${paymentStatus}`,
            context: {
              ...contextForTransition("cancelled", current),
              paymentStatus,
              phaseCancellationPhasePreviousStatus: phasePreviousStatus,
              phaseCancellationPhaseTargetStatus: phaseTargetStatus,
            },
          }),
        ).toEqual({ kind: "changed", previous: current, current: "cancelled" });
      }
    },
  );

  it.each([
    ["confirmed", "active", "cancelled"],
    ["in_production", "in_production", "cancelled"],
    ["qc_passed", "qc_passed", "cancelled"],
    ["awaiting_balance", "qc_passed", "cancelled"],
    ["ready_to_ship", "qc_passed", "cancelled"],
    ["shipped", "shipped", "cancelled_refunded"],
    ["recovery_pending", "recovery_pending", "cancelled_refunded"],
  ] as const)(
    "rejects %s Order cancellation without its exact %s to %s phase result",
    (current, phasePreviousStatus, phaseTargetStatus) => {
      const validContext = {
        ...contextForTransition("cancelled", current),
        paymentStatus: "unpaid",
        phaseCancellationPhasePreviousStatus: phasePreviousStatus,
        phaseCancellationPhaseTargetStatus: phaseTargetStatus,
      };
      for (const [field, value] of [
        ["orderId", " "],
        ["phaseCancellationOrderId", "another-order"],
        ["phaseCancellationPhaseOrderId", "another-order"],
        ["phaseId", "\t"],
        ["phaseCancellationPhaseId", "another-phase"],
        ["phaseKind", "sample"],
        ["phaseCancellationOrderPreviousStatus", "quoted"],
        ["phaseCancellationOrderTargetStatus", "confirmed"],
        ["phaseCancellationPhasePreviousStatus", "quoted"],
        ["phaseCancellationPhaseTargetStatus", "active"],
        ["phaseCancellationCompleted", false],
        ["phaseCancellationAtomic", false],
      ] as const) {
        expect(() =>
          transition(orderPolicy, {
            current,
            target: "cancelled",
            idempotencyKey: `phase-parent-cancellation-${current}-${field}`,
            context: { ...validContext, [field]: value },
          }),
        ).toThrow(TransitionGuardError);
      }
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
            ...contextForTransition(target, current),
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
            ...contextForTransition(target, current),
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
            ...contextForTransition("cancelled", current),
            paymentStatus: "paid",
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
            ...contextForTransition(
              policy === orderPolicy ? "refunded" : "cancelled_refunded",
              "cancelled",
            ),
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
            ...contextForTransition(target, "in_transit"),
            providerEventStatus: target,
          },
        }),
      ).toEqual({ kind: "changed", previous: "in_transit", current: target });
    },
  );

  it("rejects incomplete Shipment incident routing", () => {
    const firstRoute = permittedContext.shipmentIncidentSlotRoutes[0];
    const secondRoute = permittedContext.shipmentIncidentSlotRoutes[1];
    const sparseRoutes = [firstRoute] as Array<typeof firstRoute | undefined>;
    sparseRoutes.length = 2;
    const invalidContexts = [
      { incidentShipmentId: "another-shipment" },
      { incidentOrderId: "another-order" },
      { incidentPhaseId: "another-phase" },
      { shipmentFulfilmentSlotIds: [] },
      { shipmentFulfilmentSlotIds: ["slot-1", "slot-1"] },
      { incidentAffectedSlotIds: ["slot-1"] },
      { incidentAffectedSlotIds: ["slot-1", "foreign-slot"] },
      { shipmentIncidentSlotOwnerships: [] },
      {
        shipmentIncidentSlotOwnerships: [
          { slotId: "slot-1", activeClaimId: null },
          { slotId: "foreign-slot", activeClaimId: null },
        ],
      },
      {
        shipmentIncidentSlotOwnerships: [
          { slotId: "slot-1", activeClaimId: null },
          { slotId: "slot-1", activeClaimId: null },
        ],
      },
      { shipmentIncidentSlotRoutes: [] },
      { shipmentIncidentSlotRoutes: sparseRoutes },
      { shipmentOriginClaimId: " " },
      { shipmentIncidentNewClaim: null },
      { shipmentIncidentRouted: false },
      { shipmentIncidentRoutingAtomic: false },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, slotId: "slot-1" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, routedClaimId: "another-claim" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          {
            ...firstRoute,
            ownerClaimId: "existing-claim",
            routedClaimId: "existing-claim",
            incidentRecordClaimId: "existing-claim",
            createdNewClaim: false,
          },
          secondRoute,
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, incidentRecordShipmentId: "another-shipment" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, incidentRecordClaimId: "another-claim" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, incidentRecordId: firstRoute.incidentRecordId },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, childResolutionId: firstRoute.childResolutionId },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, childResolutionClaimId: "another-claim" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, childResolutionSlotId: "slot-1" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, childResolutionShipmentId: "another-shipment" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, childResolutionStatus: "refund_pending" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, claimStatus: "resolved_refund" },
        ],
      },
      {
        shipmentIncidentSlotRoutes: [
          firstRoute,
          { ...secondRoute, claimRetentionHoldActive: false },
        ],
      },
      {
        shipmentIncidentNewClaim: {
          ...permittedContext.shipmentIncidentNewClaim,
          status: "opened",
        },
      },
    ];
    for (const target of ["lost", "returned"] as const) {
      for (const [index, invalidContext] of invalidContexts.entries()) {
        expect(() =>
          transition(shipmentPolicy, {
            current: "in_transit",
            target,
            idempotencyKey: `shipment-incident-${target}-${index}`,
            context: {
              ...contextForTransition(target, "in_transit"),
              ...invalidContext,
            },
          }),
        ).toThrow(TransitionGuardError);
      }
    }
  });

  it.each(["existing owners", "mixed ownership", "origin Claim"] as const)(
    "routes a Shipment incident across %s",
    (ownership) => {
      const baseRoutes = permittedContext.shipmentIncidentSlotRoutes;
      const existingRoute = {
        ...baseRoutes[0],
        ownerClaimId: "existing-claim-1",
        routedClaimId: "existing-claim-1",
        incidentRecordClaimId: "existing-claim-1",
        childResolutionClaimId: "existing-claim-1",
        createdNewClaim: false,
      };
      const context =
        ownership === "origin Claim"
          ? {
              ...contextForTransition("lost", "in_transit"),
              shipmentOriginClaimId: "origin-claim-1",
              shipmentIncidentNewClaim: null,
              shipmentIncidentSlotRoutes: baseRoutes.map((route) => ({
                ...route,
                routedClaimId: "origin-claim-1",
                incidentRecordClaimId: "origin-claim-1",
                childResolutionClaimId: "origin-claim-1",
                createdNewClaim: false,
              })),
            }
          : {
              ...contextForTransition("lost", "in_transit"),
              shipmentIncidentNewClaim:
                ownership === "existing owners"
                  ? null
                  : permittedContext.shipmentIncidentNewClaim,
              shipmentIncidentSlotOwnerships:
                ownership === "existing owners"
                  ? [
                      { slotId: "slot-1", activeClaimId: "existing-claim-1" },
                      { slotId: "slot-2", activeClaimId: "existing-claim-2" },
                    ]
                  : [
                      { slotId: "slot-1", activeClaimId: "existing-claim-1" },
                      { slotId: "slot-2", activeClaimId: null },
                    ],
              shipmentIncidentSlotRoutes:
                ownership === "existing owners"
                  ? [
                      existingRoute,
                      {
                        ...baseRoutes[1],
                        ownerClaimId: "existing-claim-2",
                        routedClaimId: "existing-claim-2",
                        incidentRecordClaimId: "existing-claim-2",
                        childResolutionClaimId: "existing-claim-2",
                        createdNewClaim: false,
                      },
                    ]
                  : [existingRoute, baseRoutes[1]],
            };
      expect(
        transition(shipmentPolicy, {
          current: "in_transit",
          target: "lost",
          idempotencyKey: `shipment-incident-${ownership}`,
          context,
        }),
      ).toEqual({ kind: "changed", previous: "in_transit", current: "lost" });
    },
  );

  it.each([
    ["currentRemedyShipmentLineageLeafId", ""],
    ["providerEventShipmentId", "sibling-remedy-shipment"],
    ["providerEventAuthenticated", false],
    ["providerEventVerified", false],
    ["providerEventStatus", "delivered"],
    ["currentRemedyShipmentLineageLeafStatus", "in_transit"],
    ["currentRemedyShipmentLineageLeafStatus", "returned"],
  ] as const)(
    "rejects a remedy incident without exact current lineage proof (%s)",
    (field, value) => {
      expect(() =>
        transition(claimSlotResolutionPolicy, {
          current: "replacement_shipped",
          target: "recovery_pending",
          idempotencyKey: `remedy-incident-${field}`,
          context: {
            currentRemedyShipmentLineageLeafId: "remedy-shipment-1",
            currentRemedyShipmentLineageLeafStatus: "lost",
            providerEventShipmentId: "remedy-shipment-1",
            providerEventAuthenticated: true,
            providerEventVerified: true,
            providerEventStatus: "lost",
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["replacement_shipped", "lost"],
    ["replacement_shipped", "returned"],
    ["reship_shipped", "lost"],
    ["reship_shipped", "returned"],
  ] as const)(
    "records %s -> recovery_pending only for its matching %s remedy event",
    (current, providerEventStatus) => {
      expect(
        transition(claimSlotResolutionPolicy, {
          current,
          target: "recovery_pending",
          idempotencyKey: `remedy-incident-${current}-${providerEventStatus}`,
          context: {
            currentRemedyShipmentLineageLeafId: "remedy-shipment-1",
            currentRemedyShipmentLineageLeafStatus: providerEventStatus,
            providerEventShipmentId: "remedy-shipment-1",
            providerEventAuthenticated: true,
            providerEventVerified: true,
            providerEventStatus,
          },
        }),
      ).toEqual({
        kind: "changed",
        previous: current,
        current: "recovery_pending",
      });
    },
  );

  it("does not accept the legacy remedy incident boolean without provider evidence", () => {
    expect(() =>
      transition(claimSlotResolutionPolicy, {
        current: "reship_shipped",
        target: "recovery_pending",
        idempotencyKey: "remedy-incident-legacy-boolean",
        context: { verifiedShipmentIncident: true },
      }),
    ).toThrow(TransitionGuardError);
  });

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
      "accepted",
      ["nodeAssigned", "acceptanceArtifactCreated", "jobAcceptanceAtomic"],
    ],
    [
      jobPolicy,
      "created",
      "cancelled",
      ["offersClosed", "productionReservationReleased"],
    ],
    [
      jobPolicy,
      "accepted",
      "cancelled",
      [
        "materialConsumptionSettled",
        "inventoryReservationReleased",
        "capacityReservationReleased",
        "jobResourceSettlementAtomic",
        "labelCancellationBarrierCompleted",
      ],
    ],
    [
      jobPolicy,
      "accepted",
      "gcode_ready",
      ["productionSliceFromReservationSnapshot", "reproductionArtifactSealed"],
    ],
    [jobPolicy, "gcode_ready", "printing", ["printingReservationCommitAtomic"]],
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
        "materialConsumptionSettled",
        "inventoryReservationReleased",
        "capacityReservationReleased",
        "jobResourceSettlementAtomic",
        "labelCancellationBarrierCompleted",
        "replacementRequestCreated",
        "replacementDeadlineSet",
      ],
    ],
    [
      jobPolicy,
      "accepted",
      "failed",
      [
        "materialConsumptionSettled",
        "inventoryReservationReleased",
        "capacityReservationReleased",
        "jobResourceSettlementAtomic",
        "labelCancellationBarrierCompleted",
        "replacementRequestCreated",
        "replacementDeadlineSet",
      ],
    ],
    [
      paymentPolicy,
      "pending",
      "refund_pending",
      [
        "captureAuthorized",
        "initialCaptureBeforeCutoff",
        "providerPaymentEventAuthenticated",
        "providerPaymentEventVerified",
        "initialCapacityReacquisitionAttempted",
        "initialCapacityReacquisitionWholeSet",
        "initialCapacityReacquisitionFailed",
        "capacityCaptureCompensationCreated",
        "scopedRefundTransactionCreated",
        "capacityCaptureRefundIsFull",
        "capacityCaptureRefundIdempotencyKeyValid",
        "capacityCaptureExcludedFromSettlement",
        "capacityCaptureActivationSuppressed",
        "initialCapacityCaptureWindowClosed",
        "initialCapacityCaptureCutoffSet",
        "preCapturePhaseCancelled",
        "preCaptureFulfilmentSlotsCancelled",
        "preCaptureReservationsReleased",
        "capacityCaptureCompensationAtomic",
      ],
    ],
    [
      paymentPolicy,
      "pending",
      "captured",
      [
        "captureAuthorized",
        "providerPaymentEventAuthenticated",
        "providerPaymentEventVerified",
      ],
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
      paymentPolicy,
      "voided",
      "refund_pending",
      [
        "verifiedLateCapture",
        "providerPaymentEventAuthenticated",
        "providerPaymentEventVerified",
        "lateCaptureCompensationCreated",
        "scopedRefundTransactionCreated",
        "lateCaptureRefundIsFull",
        "lateCaptureRefundIdempotencyKeyValid",
        "lateCaptureExcludedFromSettlement",
        "lateCaptureCompensationAtomic",
      ],
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
    [
      orderPolicy,
      "quoted",
      "expired",
      [
        "initialPaymentRole",
        "initialPaymentStatus",
        "initialCaptureWindowClosed",
        "initialCaptureCutoffSet",
        "initialPaymentVoidOutboxCreated",
        "preCapturePhaseCancelled",
        "preCaptureFulfilmentSlotsCancelled",
        "preCaptureReservationsReleased",
        "initialCaptureCloseAtomic",
        "initialCaptureCloseReason",
      ],
    ],
    [
      orderPolicy,
      "quoted",
      "cancelled",
      [
        "initialPaymentRole",
        "initialPaymentStatus",
        "initialCaptureWindowClosed",
        "initialCaptureCutoffSet",
        "initialPaymentVoidOutboxCreated",
        "preCapturePhaseCancelled",
        "preCaptureFulfilmentSlotsCancelled",
        "preCaptureReservationsReleased",
        "initialCaptureCloseAtomic",
        "initialCaptureCloseReason",
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
    [
      claimSlotResolutionPolicy,
      "replacement_shipped",
      "recovery_pending",
      ["providerEventAuthenticated", "providerEventVerified"],
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
            context: {
              ...contextForTransition(target, current),
              [flag]: false,
            },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it.each([
    [jobPolicy, "created", "accepted"],
    [jobPolicy, "created", "cancelled"],
    [jobPolicy, "accepted", "cancelled"],
    [jobPolicy, "accepted", "failed"],
    [jobPolicy, "accepted", "gcode_ready"],
    [jobPolicy, "gcode_ready", "printing"],
    [jobPolicy, "printed", "photo_submitted"],
    [jobPolicy, "photo_submitted", "qc_approved"],
    [jobPolicy, "photo_submitted", "qc_rejected"],
    [paymentPolicy, "pending", "captured"],
    [paymentPolicy, "pending", "refund_pending"],
    [paymentPolicy, "pending", "failed"],
    [paymentPolicy, "pending", "voided"],
    [paymentPolicy, "captured", "refund_pending"],
    [paymentPolicy, "partially_refunded", "refund_pending"],
    [paymentPolicy, "voided", "refund_pending"],
    [orderPolicy, "draft", "quoted"],
    [orderPolicy, "quoted", "expired"],
    [orderPolicy, "quoted", "cancelled"],
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
    [claimSlotResolutionPolicy, "replacement_shipped", "recovery_pending"],
  ] as const)(
    "accepts %s -> %s with complete command evidence",
    (policy, current, target) => {
      expect(
        transition(policy, {
          current,
          target,
          idempotencyKey: `complete-${current}-${target}`,
          context: contextForTransition(target, current),
        }),
      ).toEqual({ kind: "changed", previous: current, current: target });
    },
  );

  it.each([
    ["created", "cancelled"],
    ["accepted", "cancelled"],
    ["gcode_ready", "cancelled"],
    ["printing", "cancelled"],
    ["printed", "cancelled"],
    ["photo_submitted", "cancelled"],
    ["qc_approved", "cancelled"],
    ["packed", "cancelled"],
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
      const context = contextForTransition(target, current);
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
    ["productionReservationJobId", "another-job"],
    ["acceptanceReservationJobId", "another-job"],
    ["acceptanceProductionReservationId", "another-reservation"],
    ["acceptanceMaterialPreviousState", "released"],
    ["acceptanceMaterialTargetState", "held"],
    ["acceptanceCapacityPreviousState", "released"],
    ["acceptanceCapacityTargetState", "held"],
    ["acceptanceArtifactVersionId", "another-artifact"],
    ["reproductionArtifactVersionStatus", "sealed"],
    ["reproductionArtifactVersionJobId", "another-job"],
    ["reproductionArtifactVersionOrderItemId", "another-item"],
    ["reproductionArtifactVersionPhaseId", "another-phase"],
    [
      "reproductionArtifactVersionProductionReservationId",
      "another-reservation",
    ],
    [
      "reproductionArtifactVersionCandidateResourceEstimateId",
      "another-estimate",
    ],
    ["reproductionArtifactVersionMachineProfileId", "another-profile"],
    ["reproductionArtifactVersionMachineCalibrationId", "another-calibration"],
    ["reproductionArtifactVersionPrintConfigRevisionId", "another-config"],
  ] as const)("rejects Job acceptance with invalid %s", (field, value) => {
    expect(() =>
      transition(jobPolicy, {
        current: "created",
        target: "accepted",
        idempotencyKey: `job-acceptance-${field}`,
        context: {
          ...contextForTransition("accepted", "created"),
          [field]: value,
        },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    ["printingReservationJobId", "another-job"],
    ["productionReservationJobId", "another-job"],
    ["printingReservationProductionReservationId", "another-reservation"],
    ["printingReservationState", "allocated"],
    ["materialConsumptionMode", "zero_pre_print"],
  ] as const)(
    "rejects gcode_ready -> printing with invalid %s",
    (field, value) => {
      expect(() =>
        transition(jobPolicy, {
          current: "gcode_ready",
          target: "printing",
          idempotencyKey: `printing-reservation-${field}`,
          context: {
            ...contextForTransition("printing", "gcode_ready"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["jobResourceSettlementJobId", "another-job"],
    ["productionReservationJobId", "another-job"],
    ["jobResourceSettlementProductionReservationId", "another-reservation"],
    ["materialConsumptionMode", "zero_pre_print"],
  ] as const)(
    "rejects photo_submitted -> qc_rejected with invalid settlement %s",
    (field, value) => {
      expect(() =>
        transition(jobPolicy, {
          current: "photo_submitted",
          target: "qc_rejected",
          idempotencyKey: `qc-rejection-settlement-${field}`,
          context: {
            ...contextForTransition("qc_rejected", "photo_submitted"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    "accepted",
    "gcode_ready",
    "printing",
    "printed",
    "photo_submitted",
    "qc_approved",
    "packed",
  ] as const)(
    "settles every resource and label barrier before %s -> cancelled",
    (current) => {
      for (const flag of [
        "materialConsumptionSettled",
        "inventoryReservationReleased",
        "capacityReservationReleased",
        "jobResourceSettlementAtomic",
        "labelCancellationBarrierCompleted",
      ] as const) {
        expect(() =>
          transition(jobPolicy, {
            current,
            target: "cancelled",
            idempotencyKey: `job-cancellation-${current}-${flag}`,
            context: {
              ...contextForTransition("cancelled", current),
              [flag]: false,
            },
          }),
        ).toThrow(TransitionGuardError);
      }

      expect(
        transition(jobPolicy, {
          current,
          target: "cancelled",
          idempotencyKey: `job-cancellation-complete-${current}`,
          context: {
            ...contextForTransition("cancelled", current),
            offersClosed: false,
          },
        }),
      ).toEqual({ kind: "changed", previous: current, current: "cancelled" });
    },
  );

  it.each([
    ["created", "phase_cancelled"],
    ["accepted", "routing_exhausted"],
    ["packed", "routing_exhausted"],
  ] as const)(
    "rejects %s -> cancelled with lifecycle-incompatible reason %s",
    (current, cancellationReason) => {
      expect(() =>
        transition(jobPolicy, {
          current,
          target: "cancelled",
          idempotencyKey: `job-cancellation-reason-${current}`,
          context: {
            ...contextForTransition("cancelled", current),
            cancellationReason,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    "accepted",
    "gcode_ready",
    "printing",
    "printed",
    "photo_submitted",
    "qc_approved",
    "packed",
  ] as const)(
    "settles the exact original reservation before %s -> failed",
    (current) => {
      for (const flag of [
        "materialConsumptionSettled",
        "inventoryReservationReleased",
        "capacityReservationReleased",
        "jobResourceSettlementAtomic",
        "labelCancellationBarrierCompleted",
      ] as const) {
        expect(() =>
          transition(jobPolicy, {
            current,
            target: "failed",
            idempotencyKey: `job-failure-settlement-${current}-${flag}`,
            context: {
              ...contextForTransition("failed", current),
              [flag]: false,
            },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it.each([
    ["jobResourceSettlementJobId", "another-job"],
    ["productionReservationJobId", "another-job"],
    ["jobResourceSettlementProductionReservationId", "another-reservation"],
  ] as const)(
    "rejects Job failure settlement with mismatched %s",
    (field, value) => {
      expect(() =>
        transition(jobPolicy, {
          current: "printing",
          target: "failed",
          idempotencyKey: `job-failure-identity-${field}`,
          context: {
            ...contextForTransition("failed", "printing"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["accepted", "preparation"],
    ["accepted", "gcode"],
    ["gcode_ready", "machine"],
    ["printing", "printing"],
    ["printed", "post_print"],
    ["photo_submitted", "post_print"],
    ["qc_approved", "post_qc"],
    ["packed", "packing"],
  ] as const)("accepts %s -> failed with stage %s", (current, failureStage) => {
    expect(
      transition(jobPolicy, {
        current,
        target: "failed",
        idempotencyKey: `job-failure-stage-valid-${current}-${failureStage}`,
        context: {
          ...contextForTransition("failed", current),
          failureStage,
        },
      }),
    ).toEqual({ kind: "changed", previous: current, current: "failed" });
  });

  it.each([
    ["accepted", "packing"],
    ["gcode_ready", "printing"],
    ["printing", "machine"],
    ["printed", "printing"],
    ["photo_submitted", "post_qc"],
    ["qc_approved", "preparation"],
    ["qc_approved", "packing"],
    ["packed", "preparation"],
    ["packed", "post_qc"],
  ] as const)("rejects %s -> failed with stage %s", (current, failureStage) => {
    expect(() =>
      transition(jobPolicy, {
        current,
        target: "failed",
        idempotencyKey: `job-failure-stage-invalid-${current}-${failureStage}`,
        context: {
          ...contextForTransition("failed", current),
          failureStage,
        },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    ["accepted", "actual_recorded"],
    ["gcode_ready", "actual_recorded"],
    ["printing", "zero_pre_print"],
    ["packed", "zero_pre_print"],
  ] as const)(
    "rejects %s -> failed with material settlement mode %s",
    (current, materialConsumptionMode) => {
      expect(() =>
        transition(jobPolicy, {
          current,
          target: "failed",
          idempotencyKey: `job-failure-material-mode-${current}`,
          context: {
            ...contextForTransition("failed", current),
            materialConsumptionMode,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["qc_approved", "qc_passed", "not_active"],
    ["qc_approved", "awaiting_balance", "invalidated"],
    ["packed", "ready_to_ship", "not_active"],
  ] as const)(
    "applies pre-handoff aggregate recovery for %s failure from Order %s",
    (current, postQcFailureOrderPreviousStatus, balanceDeadlineResult) => {
      expect(
        transition(jobPolicy, {
          current,
          target: "failed",
          idempotencyKey: `post-qc-pre-handoff-${current}-${postQcFailureOrderPreviousStatus}`,
          context: {
            ...contextForTransition("failed", current),
            postQcFailureOrderPreviousStatus,
            postQcFailureBalanceDeadlineResult: balanceDeadlineResult,
          },
        }),
      ).toEqual({ kind: "changed", previous: current, current: "failed" });
    },
  );

  it.each([
    ["phaseHasPriorHandoff", true],
    ["postQcFailurePhaseTargetStatus", "shipped"],
    ["postQcFailureOrderTargetStatus", "shipped"],
    ["postQcFailureBalanceDeadlineResult", "invalidated"],
    ["postQcFailureJobId", "another-job"],
    ["postQcFailurePhaseId", "another-phase"],
    ["postQcFailurePhaseKind", "sample"],
    ["postQcFailureOrderId", "another-order"],
    ["postQcFailureSlotRecoveryBlocked", true],
  ] as const)(
    "rejects invalid pre-handoff post-QC result %s",
    (field, value) => {
      expect(() =>
        transition(jobPolicy, {
          current: "qc_approved",
          target: "failed",
          idempotencyKey: `post-qc-pre-handoff-invalid-${field}`,
          context: {
            ...contextForTransition("failed", "qc_approved"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["qc_approved", "shipped"],
    ["packed", "shipped"],
  ] as const)(
    "blocks exact failed slots after prior handoff for %s with Order %s",
    (current, postQcFailureOrderTargetStatus) => {
      expect(
        transition(jobPolicy, {
          current,
          target: "failed",
          idempotencyKey: `post-qc-post-handoff-${current}`,
          context: {
            ...contextForTransition("failed", current),
            postQcFailureResolutionKind: "post_handoff_slot_block",
            phaseHasPriorHandoff: true,
            postQcFailurePhasePreviousStatus: "shipped",
            postQcFailurePhaseTargetStatus: "shipped",
            postQcFailureOrderPreviousStatus: postQcFailureOrderTargetStatus,
            postQcFailureOrderTargetStatus,
            postQcFailureShipmentPlanId: "shipment-plan-1",
            postQcFailureSlotIds: ["slot-1"],
            postQcFailureSlotRecoveryBlocked: true,
          },
        }),
      ).toEqual({ kind: "changed", previous: current, current: "failed" });
    },
  );

  it.each([
    ["phaseHasPriorHandoff", false],
    ["postQcFailurePhasePreviousStatus", "qc_passed"],
    ["postQcFailurePhaseTargetStatus", "recovery_pending"],
    ["postQcFailureOrderPreviousStatus", "awaiting_balance"],
    ["postQcFailureOrderTargetStatus", "recovery_pending"],
    ["postQcFailureOrderTargetStatus", "in_production"],
    ["postQcFailureBalanceDeadlineResult", "invalidated"],
    ["postQcFailurePhaseKind", "sample"],
    ["postQcFailureSlotRecoveryBlocked", false],
    ["postQcFailureShipmentPlanId", "another-plan"],
    ["postQcFailureSlotIds", []],
    ["postQcFailureSlotIds", ["another-slot"]],
    ["postQcFailureSlotIds", ["slot-1", "slot-1"]],
    ["postQcFailureResolutionAtomic", false],
  ] as const)(
    "rejects invalid post-handoff post-QC result %s",
    (field, value) => {
      expect(() =>
        transition(jobPolicy, {
          current: "packed",
          target: "failed",
          idempotencyKey: `post-qc-post-handoff-invalid-${field}`,
          context: {
            ...contextForTransition("failed", "packed"),
            postQcFailureResolutionKind: "post_handoff_slot_block",
            phaseHasPriorHandoff: true,
            postQcFailurePhasePreviousStatus: "shipped",
            postQcFailurePhaseTargetStatus: "shipped",
            postQcFailureOrderPreviousStatus: "shipped",
            postQcFailureOrderTargetStatus: "shipped",
            postQcFailureShipmentPlanId: "shipment-plan-1",
            postQcFailureSlotIds: ["slot-1"],
            postQcFailureSlotRecoveryBlocked: true,
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["initialPaymentStatus", "voided"],
    ["providerEventPaymentId", "another-payment"],
    ["initialPaymentId", "another-payment"],
    ["initialPaymentOrderId", "another-order"],
    ["initialCapacityReacquisitionOrderId", "another-order"],
    ["initialCapacityReacquisitionPhaseId", "another-phase"],
    ["initialCapacityReacquisitionReservationSetId", "another-reservation-set"],
    [
      "capacityCaptureCompensationProviderTransactionId",
      "another-provider-transaction",
    ],
    ["capacityCaptureCompensationRefundTransactionId", "another-refund"],
    ["initialPaymentRole", "balance"],
    ["providerPaymentEventStatus", "failed"],
    ["capacityCaptureCompensationKind", "initial_checkout_expired"],
    ["capacityCaptureOrderTargetStatus", "confirmed"],
    ["capacityCapturePhaseTargetStatus", "active"],
    ["capacityCaptureJobsCreated", true],
  ] as const)(
    "rejects initial capacity capture compensation with invalid %s",
    (field, value) => {
      expect(() =>
        transition(paymentPolicy, {
          current: "pending",
          target: "refund_pending",
          idempotencyKey: `initial-capacity-compensation-${field}`,
          context: {
            ...contextForTransition("refund_pending", "pending"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("atomically closes the quoted Order for a capacity-compensated capture", () => {
    const capacityContext = contextForTransition("refund_pending", "pending");
    expect(
      transition(orderPolicy, {
        current: "quoted",
        target: "cancelled",
        idempotencyKey: "initial-capacity-order-close",
        context: capacityContext,
      }),
    ).toEqual({
      kind: "changed",
      previous: "quoted",
      current: "cancelled",
    });
    expect(() =>
      transition(orderPolicy, {
        current: "quoted",
        target: "expired",
        idempotencyKey: "initial-capacity-order-wrong-target",
        context: capacityContext,
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    ["initial_checkout_capacity", "pending"],
    ["late_capture", "voided"],
  ] as const)(
    "retries a partial %s compensation without a price adjustment",
    (compensationRefundRetryKind, originalState) => {
      const compensationContext = {
        ...contextForTransition("refund_pending", originalState),
        compensationRefundRetryKind,
        refundPriceAdjustmentActivated: false,
      };
      expect(
        transition(paymentPolicy, {
          current: "partially_refunded",
          target: "refund_pending",
          idempotencyKey: `compensation-refund-retry-${compensationRefundRetryKind}`,
          context: compensationContext,
        }),
      ).toEqual({
        kind: "changed",
        previous: "partially_refunded",
        current: "refund_pending",
      });
      for (const flag of [
        "compensationRefundOutstanding",
        "compensationRefundRetryAtomic",
      ] as const) {
        expect(() =>
          transition(paymentPolicy, {
            current: "partially_refunded",
            target: "refund_pending",
            idempotencyKey: `compensation-refund-retry-${compensationRefundRetryKind}-${flag}`,
            context: { ...compensationContext, [flag]: false },
          }),
        ).toThrow(TransitionGuardError);
      }
    },
  );

  it("does not route capacity compensation retries through the ordinary refund branch", () => {
    const capacityContext = {
      ...contextForTransition("refund_pending", "pending"),
      refundPriceAdjustmentActivated: true,
    };
    expect(() =>
      transition(paymentPolicy, {
        current: "partially_refunded",
        target: "refund_pending",
        idempotencyKey: "capacity-compensation-ordinary-retry",
        context: capacityContext,
      }),
    ).toThrow(TransitionGuardError);
    expect(() =>
      transition(paymentPolicy, {
        current: "partially_refunded",
        target: "refund_pending",
        idempotencyKey: "capacity-compensation-wrong-retry-kind",
        context: {
          ...capacityContext,
          compensationRefundRetryKind: "late_capture",
        },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    ["initial_checkout_capacity", "pending", "captured"],
    ["late_capture", "pending", "captured"],
    ["initial_checkout_capacity", "captured", "refund_pending"],
    ["late_capture", "captured", "refund_pending"],
  ] as const)(
    "does not route a %s Payment through ordinary %s -> %s",
    (paymentCaptureKind, current, target) => {
      expect(() =>
        transition(paymentPolicy, {
          current,
          target,
          idempotencyKey: `compensation-ordinary-${paymentCaptureKind}-${current}-${target}`,
          context: {
            ...contextForTransition(target, current),
            paymentCaptureKind,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["expired", "full"],
    ["expired", "deposit"],
    ["cancelled", "full"],
    ["cancelled", "deposit"],
  ] as const)(
    "closes initial capture before quoted -> %s for a %s Payment",
    (target, initialPaymentRole) => {
      expect(
        transition(orderPolicy, {
          current: "quoted",
          target,
          idempotencyKey: `initial-capture-close-${target}-${initialPaymentRole}`,
          context: {
            ...contextForTransition(target, "quoted"),
            initialPaymentRole,
          },
        }),
      ).toEqual({ kind: "changed", previous: "quoted", current: target });
    },
  );

  it.each([
    ["expired", "checkout_cancelled"],
    ["cancelled", "checkout_expired"],
  ] as const)(
    "rejects quoted -> %s with mismatched initial close reason %s",
    (target, initialCaptureCloseReason) => {
      expect(() =>
        transition(orderPolicy, {
          current: "quoted",
          target,
          idempotencyKey: `initial-capture-reason-${target}`,
          context: {
            ...contextForTransition(target, "quoted"),
            initialCaptureCloseReason,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["initialPaymentOrderId", "another-order"],
    ["initialCaptureCloseOrderId", "another-order"],
    ["initialCaptureClosePaymentId", "another-payment"],
  ] as const)(
    "rejects initial capture close evidence with mismatched %s",
    (field, value) => {
      expect(() =>
        transition(orderPolicy, {
          current: "quoted",
          target: "expired",
          idempotencyKey: `initial-capture-identity-${field}`,
          context: {
            ...contextForTransition("expired"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["providerEventPaymentId", "another-payment"],
    ["providerPaymentEventStatus", "failed"],
    ["lateCaptureCompensationPaymentId", "another-payment"],
    ["lateCaptureRefundTransactionPaymentId", "another-payment"],
    [
      "lateCaptureCompensationProviderTransactionId",
      "another-provider-transaction",
    ],
    [
      "lateCaptureRefundTransactionProviderTransactionId",
      "another-provider-transaction",
    ],
    ["lateCaptureCompensationRefundTransactionId", "another-refund"],
  ] as const)(
    "rejects late capture compensation with mismatched %s",
    (field, value) => {
      expect(() =>
        transition(paymentPolicy, {
          current: "voided",
          target: "refund_pending",
          idempotencyKey: `late-capture-identity-${field}`,
          context: {
            ...contextForTransition("refund_pending", "voided"),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it.each([
    ["captured", "providerEventPaymentId", "another-payment"],
    ["captured", "providerPaymentEventStatus", "failed"],
    ["failed", "providerEventPaymentId", "another-payment"],
    ["failed", "providerPaymentEventStatus", "voided"],
  ] as const)(
    "rejects Payment %s with a non-matching provider event %s",
    (target, field, value) => {
      expect(() =>
        transition(paymentPolicy, {
          current: "pending",
          target,
          idempotencyKey: `payment-${target}-${field}`,
          context: {
            ...contextForTransition(target, "pending"),
            [field]: value,
          },
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
        context: {
          ...contextForTransition("failed", "printing"),
          [field]: value,
        },
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
            ...claimResolutionEvidence(claimSlotResolutionStatuses),
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
            ...claimResolutionEvidence(claimSlotResolutionStatuses),
            cleanPostDeliveryQualityClaim: true,
          },
        }),
      ).toEqual({ kind: "changed", previous: "active", current: target });
    },
  );

  it("rejects sparse child disposition arrays", () => {
    const evidence = claimResolutionEvidence(["refunded", "refunded"]);
    const sparseClaimResolutions = [evidence.claimSlotResolutions[0]];
    sparseClaimResolutions.length = 2;

    expect(() =>
      transition(claimPolicy, {
        current: "active",
        target: "resolved_refund",
        idempotencyKey: "claim-sparse-dispositions",
        context: {
          ...evidence,
          claimSlotResolutions: sparseClaimResolutions,
          cleanPostDeliveryQualityClaim: true,
        },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    [
      "omitted child",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: evidence.claimSlotResolutions.slice(0, 1),
      }),
    ],
    [
      "foreign child",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: [
          evidence.claimSlotResolutions[0],
          { ...evidence.claimSlotResolutions[1], id: "foreign-resolution" },
        ],
      }),
    ],
    [
      "duplicate expected identity",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        expectedClaimSlotResolutionIds: [
          evidence.expectedClaimSlotResolutionIds[0],
          evidence.expectedClaimSlotResolutionIds[0],
        ],
      }),
    ],
    [
      "duplicate projected identity",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: [
          evidence.claimSlotResolutions[0],
          {
            ...evidence.claimSlotResolutions[1],
            id: evidence.claimSlotResolutions[0]?.id,
          },
        ],
      }),
    ],
    [
      "foreign Claim owner",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: [
          evidence.claimSlotResolutions[0],
          { ...evidence.claimSlotResolutions[1], claimId: "another-claim" },
        ],
      }),
    ],
    [
      "duplicate expected slot identity",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        expectedClaimSlotIds: [
          evidence.expectedClaimSlotIds[0],
          evidence.expectedClaimSlotIds[0],
        ],
      }),
    ],
    [
      "foreign projected slot",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: [
          evidence.claimSlotResolutions[0],
          { ...evidence.claimSlotResolutions[1], slotId: "foreign-slot" },
        ],
      }),
    ],
    [
      "duplicate projected slot",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: [
          evidence.claimSlotResolutions[0],
          {
            ...evidence.claimSlotResolutions[1],
            slotId: evidence.claimSlotResolutions[0]?.slotId,
          },
        ],
      }),
    ],
    [
      "swapped resolution-to-slot binding",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: [
          {
            ...evidence.claimSlotResolutions[0],
            slotId: evidence.claimSlotResolutions[1]?.slotId,
          },
          {
            ...evidence.claimSlotResolutions[1],
            slotId: evidence.claimSlotResolutions[0]?.slotId,
          },
        ],
      }),
    ],
    [
      "foreign active Claim owner",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: [
          evidence.claimSlotResolutions[0],
          {
            ...evidence.claimSlotResolutions[1],
            activeClaimIdBefore: "another-claim",
          },
        ],
      }),
    ],
    [
      "retained active Claim owner",
      (evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotResolutions: [
          evidence.claimSlotResolutions[0],
          {
            ...evidence.claimSlotResolutions[1],
            activeClaimIdAfter: "claim-1",
          },
        ],
      }),
    ],
    [
      "incomplete-set flag",
      (_evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimResolutionSetComplete: false,
      }),
    ],
    [
      "ownership-release flag",
      (_evidence: ReturnType<typeof claimResolutionEvidence>) => ({
        claimSlotOwnershipReleased: false,
      }),
    ],
  ] as const)("rejects Claim resolution with %s", (_case, mutate) => {
    const evidence = claimResolutionEvidence(["delivered_reprint", "refunded"]);
    expect(() =>
      transition(claimPolicy, {
        current: "active",
        target: "resolved_mixed",
        idempotencyKey: `claim-complete-set-${_case}`,
        context: {
          ...evidence,
          ...mutate(evidence),
        },
      }),
    ).toThrow(TransitionGuardError);
  });

  it.each([
    ["claimRetentionClaimId", "another-claim"],
    ["claimRetentionHoldPreviousStatus", "released"],
    ["claimRetentionHoldTargetStatus", "active_claim"],
    ["claimRetentionPreviousDeleteAfter", "not-an-instant"],
    [
      "claimRetentionTargetDeleteAfter",
      Instant.parse("2026-01-31T00:00:00.000Z"),
    ],
    ["claimRetentionDeadlineRecomputed", false],
    ["claimRetentionReleased", false],
    ["claimTerminalCleanupAtomic", false],
  ] as const)(
    "rejects Claim terminal cleanup with invalid %s",
    (field, value) => {
      expect(() =>
        transition(claimPolicy, {
          current: "active",
          target: "resolved_refund",
          idempotencyKey: `claim-terminal-cleanup-${field}`,
          context: {
            ...claimResolutionEvidence(["refunded"]),
            [field]: value,
          },
        }),
      ).toThrow(TransitionGuardError);
    },
  );

  it("accepts a complete reordered Claim child set", () => {
    const evidence = claimResolutionEvidence(["delivered_reprint", "refunded"]);
    expect(
      transition(claimPolicy, {
        current: "active",
        target: "resolved_mixed",
        idempotencyKey: "claim-complete-set-reordered",
        context: {
          ...evidence,
          claimSlotResolutions: [...evidence.claimSlotResolutions].reverse(),
        },
      }),
    ).toEqual({
      kind: "changed",
      previous: "active",
      current: "resolved_mixed",
    });
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
