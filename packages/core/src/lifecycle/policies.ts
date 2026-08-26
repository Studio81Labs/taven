import { type Instant } from "../primitives/time.js";
import {
  TransitionGuardError,
  type TransitionCommand,
  type TransitionPolicy,
} from "./transition.js";

function requireFlag<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  flag: string,
  reason: string,
): void {
  if (command.context?.[flag] !== true) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      reason,
    );
  }
}

function requireZeroBalances<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (
    command.context?.amountDueMinor !== 0n ||
    command.context.refundableBalanceMinor !== 0n
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "handoff requires zero amount due and refundable balance",
    );
  }
}

function requireZeroAmountDue<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (command.context?.amountDueMinor !== 0n) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "handoff reconciliation requires zero amount due",
    );
  }
}

function requireReconciliationRefundAllocation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const refundableBalanceMinor = command.context?.refundableBalanceMinor;
  if (
    typeof refundableBalanceMinor !== "bigint" ||
    refundableBalanceMinor < 0n ||
    (refundableBalanceMinor > 0n &&
      command.context?.reconciliationRefundAllocated !== true)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "handoff reconciliation requires a zero or explicitly allocated refundable balance",
    );
  }
}

function requireProjectedFinancialTerminalTarget<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (command.context?.financialTerminalTarget !== command.target) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "terminal target must match the adapter-projected financial outcome",
    );
  }
}

function requireProjectedCompletionTarget<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (command.context?.completionProjectedTarget !== command.target) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "terminal target must match the projected fulfilment completion outcome",
    );
  }
}

function requireAllShipmentLineageLeavesDelivered<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const leaves = command.context?.shipmentLineageLeafStatuses;
  const normalizedLeaves = Array.isArray(leaves) ? [...leaves] : undefined;
  if (
    normalizedLeaves === undefined ||
    normalizedLeaves.length === 0 ||
    normalizedLeaves.some((status) => status !== "delivered")
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "delivery requires every current shipment lineage leaf to be delivered",
    );
  }
}

function requireVerifiedMatchingRefundWebhook<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const paymentId = command.context?.paymentId;
  const webhookPaymentId = command.context?.refundWebhookPaymentId;
  const refundTransactionId = command.context?.refundTransactionId;
  const webhookRefundTransactionId =
    command.context?.refundWebhookRefundTransactionId;
  if (
    typeof paymentId !== "string" ||
    paymentId.length === 0 ||
    webhookPaymentId !== paymentId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "refund completion requires a webhook for this exact payment",
    );
  }
  if (
    typeof refundTransactionId !== "string" ||
    refundTransactionId.length === 0 ||
    webhookRefundTransactionId !== refundTransactionId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "refund completion requires a webhook for this exact refund transaction",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "refundWebhookAuthenticated",
    "refund completion requires an authenticated provider webhook",
  );
  requireFlag(
    lifecycle,
    command,
    "refundWebhookVerified",
    "refund completion requires a verified provider webhook",
  );
  if (command.context?.refundWebhookStatus !== "succeeded") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "refund completion requires a successful refund webhook result",
    );
  }
  if (command.context?.refundWebhookProjectedTarget !== command.target) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "refund webhook result must project this exact refund target",
    );
  }
}

function requireBalancePaymentDeadlineSetup<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (command.context?.balancePaymentRole !== "balance") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "awaiting balance requires a Payment with the balance role",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "balancePaymentOrderMatches",
    "awaiting balance requires the balance payment to belong to this order",
  );
  requireFlag(
    lifecycle,
    command,
    "balancePaymentCreated",
    "awaiting balance requires its balance payment to be created",
  );
  requireFlag(
    lifecycle,
    command,
    "balancePaymentScheduleComplete",
    "awaiting balance requires a complete balance payment schedule",
  );
  requireFlag(
    lifecycle,
    command,
    "balanceDueAtSet",
    "awaiting balance requires a balance payment deadline",
  );
  requireFlag(
    lifecycle,
    command,
    "balancePaymentDeadlineSetupAtomic",
    "the balance payment and deadline must be persisted atomically",
  );
}

function requireVerifiedMatchingProviderPaymentEvent<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const paymentId = command.context?.paymentId;
  const eventPaymentId = command.context?.providerEventPaymentId;
  if (
    typeof paymentId !== "string" ||
    paymentId.length === 0 ||
    eventPaymentId !== paymentId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "provider event must match this exact payment",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "providerPaymentEventAuthenticated",
    "payment outcome requires an authenticated provider event",
  );
  requireFlag(
    lifecycle,
    command,
    "providerPaymentEventVerified",
    "payment outcome requires a verified provider event",
  );
  if (command.context?.providerPaymentEventStatus !== command.target) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "provider event outcome must match the payment transition target",
    );
  }
}

function requireVerifiedLateCaptureCompensation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (command.context?.paymentCaptureKind !== "late_capture") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "late compensation retry requires a late-capture Payment",
    );
  }
  const paymentId = command.context?.paymentId;
  const providerTransactionId = command.context?.providerPaymentTransactionId;
  const refundTransactionId = command.context?.refundTransactionId;
  if (
    typeof paymentId !== "string" ||
    paymentId.length === 0 ||
    command.context?.providerEventPaymentId !== paymentId ||
    command.context?.lateCaptureCompensationPaymentId !== paymentId ||
    command.context?.lateCaptureRefundTransactionPaymentId !== paymentId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "late capture compensation must belong to this exact Payment",
    );
  }
  if (
    typeof providerTransactionId !== "string" ||
    providerTransactionId.length === 0 ||
    command.context?.lateCaptureCompensationProviderTransactionId !==
      providerTransactionId ||
    command.context?.lateCaptureRefundTransactionProviderTransactionId !==
      providerTransactionId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "late capture compensation must match the exact provider transaction",
    );
  }
  if (
    typeof refundTransactionId !== "string" ||
    refundTransactionId.length === 0 ||
    command.context?.lateCaptureCompensationRefundTransactionId !==
      refundTransactionId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "late capture compensation must reference its exact RefundTransaction",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "verifiedLateCapture",
    "a voided payment may be refunded only after verified late capture",
  );
  requireFlag(
    lifecycle,
    command,
    "providerPaymentEventAuthenticated",
    "late capture requires an authenticated provider event",
  );
  requireFlag(
    lifecycle,
    command,
    "providerPaymentEventVerified",
    "late capture requires a verified provider event",
  );
  if (command.context?.providerPaymentEventStatus !== "captured") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "late capture requires a successful provider capture result",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "lateCaptureCompensationCreated",
    "late capture requires its full compensation operation",
  );
  requireFlag(
    lifecycle,
    command,
    "scopedRefundTransactionCreated",
    "late capture requires its scoped RefundTransaction",
  );
  requireFlag(
    lifecycle,
    command,
    "lateCaptureRefundIsFull",
    "late capture compensation must refund the full captured amount",
  );
  requireFlag(
    lifecycle,
    command,
    "lateCaptureRefundIdempotencyKeyValid",
    "late capture requires its provider-transaction-scoped idempotency key",
  );
  requireFlag(
    lifecycle,
    command,
    "lateCaptureExcludedFromSettlement",
    "late capture compensation must be excluded from Order settlement",
  );
  requireFlag(
    lifecycle,
    command,
    "lateCaptureCompensationAtomic",
    "late capture, compensation, and refund setup must be persisted atomically",
  );
}

function requireInitialCapacityCaptureCompensation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (command.context?.paymentCaptureKind !== "initial_checkout_capacity") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation requires a capacity-compensation Payment",
    );
  }
  const paymentId = command.context?.paymentId;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const phaseReservationSetId = command.context?.phaseReservationSetId;
  const providerTransactionId = command.context?.providerPaymentTransactionId;
  const refundTransactionId = command.context?.refundTransactionId;
  if (
    typeof paymentId !== "string" ||
    paymentId.length === 0 ||
    command.context?.providerEventPaymentId !== paymentId ||
    command.context?.initialPaymentId !== paymentId ||
    command.context?.capacityCaptureCompensationPaymentId !== paymentId ||
    command.context?.capacityCaptureRefundTransactionPaymentId !== paymentId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation must belong to this exact initial Payment",
    );
  }
  if (
    typeof orderId !== "string" ||
    orderId.length === 0 ||
    command.context?.initialPaymentOrderId !== orderId ||
    command.context?.initialCapacityReacquisitionOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.length === 0 ||
    command.context?.initialCapacityReacquisitionPhaseId !== phaseId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation must match the exact Order and pre-capture phase",
    );
  }
  if (
    typeof phaseReservationSetId !== "string" ||
    phaseReservationSetId.length === 0 ||
    command.context?.initialCapacityReacquisitionReservationSetId !==
      phaseReservationSetId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation requires the exact expired PhaseReservationSet",
    );
  }
  if (
    typeof providerTransactionId !== "string" ||
    providerTransactionId.length === 0 ||
    command.context?.capacityCaptureCompensationProviderTransactionId !==
      providerTransactionId ||
    command.context?.capacityCaptureRefundTransactionProviderTransactionId !==
      providerTransactionId ||
    typeof refundTransactionId !== "string" ||
    refundTransactionId.length === 0 ||
    command.context?.capacityCaptureCompensationRefundTransactionId !==
      refundTransactionId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation must match its provider and RefundTransaction identities",
    );
  }
  if (
    command.context?.initialPaymentRole !== "full" &&
    command.context?.initialPaymentRole !== "deposit"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation is limited to an initial full or deposit Payment",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "captureAuthorized",
    "capacity compensation requires a capture authorized before its cutoff",
  );
  requireFlag(
    lifecycle,
    command,
    "initialCaptureBeforeCutoff",
    "capacity compensation requires proof that capture beat the immutable cutoff",
  );
  requireFlag(
    lifecycle,
    command,
    "providerPaymentEventAuthenticated",
    "capacity compensation requires an authenticated provider event",
  );
  requireFlag(
    lifecycle,
    command,
    "providerPaymentEventVerified",
    "capacity compensation requires a verified provider event",
  );
  if (command.context?.providerPaymentEventStatus !== "captured") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation requires a successful capture result",
    );
  }
  for (const [flag, reason] of [
    [
      "initialCapacityReacquisitionAttempted",
      "the complete reservation set must be reacquired before compensation",
    ],
    [
      "initialCapacityReacquisitionWholeSet",
      "capacity reacquisition must cover the complete phase reservation set",
    ],
    [
      "initialCapacityReacquisitionFailed",
      "capacity compensation requires a failed complete reacquisition result",
    ],
    [
      "capacityCaptureCompensationCreated",
      "capacity failure requires its full compensation operation",
    ],
    [
      "scopedRefundTransactionCreated",
      "capacity failure requires its scoped RefundTransaction",
    ],
    [
      "capacityCaptureRefundIsFull",
      "capacity failure must refund the full capture",
    ],
    [
      "capacityCaptureRefundIdempotencyKeyValid",
      "capacity refund requires a provider-transaction-scoped idempotency key",
    ],
    [
      "capacityCaptureExcludedFromSettlement",
      "capacity compensation capture must be excluded from Order settlement",
    ],
    [
      "capacityCaptureActivationSuppressed",
      "capacity failure must not activate the phase or Order",
    ],
    [
      "initialCapacityCaptureWindowClosed",
      "capacity failure must close the initial capture window",
    ],
    [
      "initialCapacityCaptureCutoffSet",
      "capacity failure must record the capture cutoff",
    ],
    [
      "preCapturePhaseCancelled",
      "capacity failure must cancel the pre-capture phase",
    ],
    [
      "preCaptureFulfilmentSlotsCancelled",
      "capacity failure must cancel the pre-capture slots",
    ],
    [
      "preCaptureReservationsReleased",
      "capacity failure must release all pre-capture reservations",
    ],
    [
      "capacityCaptureCompensationAtomic",
      "capture audit, checkout closure, compensation, and refund must be atomic",
    ],
  ] as const) {
    requireFlag(lifecycle, command, flag, reason);
  }
  if (
    command.context?.capacityCaptureCompensationKind !==
      "initial_checkout_capacity" ||
    command.context?.capacityCaptureOrderTargetStatus !== "cancelled" ||
    command.context?.capacityCapturePhaseTargetStatus !== "cancelled" ||
    command.context?.capacityCaptureJobsCreated !== false
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation must close the checkout without creating Jobs",
    );
  }
}

function requireCompensationRefundRetry<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const kind = command.context?.compensationRefundRetryKind;
  if (kind === "initial_checkout_capacity") {
    requireInitialCapacityCaptureCompensation(lifecycle, command);
  } else if (kind === "late_capture") {
    requireVerifiedLateCaptureCompensation(lifecycle, command);
  } else {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "compensation retry requires an exact compensation kind",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "compensationRefundOutstanding",
    "compensation retry requires an outstanding captured balance",
  );
  requireFlag(
    lifecycle,
    command,
    "compensationRefundRetryAtomic",
    "compensation retry and refund outbox persistence must be atomic",
  );
}

function requireInitialCaptureWindowClosed<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const orderId = command.context?.orderId;
  const initialPaymentId = command.context?.initialPaymentId;
  if (
    typeof orderId !== "string" ||
    orderId.length === 0 ||
    command.context?.initialPaymentOrderId !== orderId ||
    command.context?.initialCaptureCloseOrderId !== orderId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capture-window close result must belong to this exact Order",
    );
  }
  if (
    typeof initialPaymentId !== "string" ||
    initialPaymentId.length === 0 ||
    command.context?.initialCaptureClosePaymentId !== initialPaymentId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capture-window close result must belong to this exact initial Payment",
    );
  }
  if (
    command.context?.initialPaymentRole !== "full" &&
    command.context?.initialPaymentRole !== "deposit"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "checkout termination requires its full or deposit Payment",
    );
  }
  if (command.context?.initialPaymentStatus !== "voided") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "checkout termination requires its initial Payment to be voided",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "initialCaptureWindowClosed",
    "checkout termination requires the initial capture window to be closed",
  );
  requireFlag(
    lifecycle,
    command,
    "initialCaptureCutoffSet",
    "checkout termination requires its immutable capture cutoff",
  );
  requireFlag(
    lifecycle,
    command,
    "initialPaymentVoidOutboxCreated",
    "checkout termination requires its provider void command to be persisted",
  );
  requireFlag(
    lifecycle,
    command,
    "preCapturePhaseCancelled",
    "checkout termination requires its pre-capture phase to be cancelled",
  );
  requireFlag(
    lifecycle,
    command,
    "preCaptureFulfilmentSlotsCancelled",
    "checkout termination requires its pre-capture slots to be cancelled",
  );
  requireFlag(
    lifecycle,
    command,
    "preCaptureReservationsReleased",
    "checkout termination requires its phase reservation set to be released",
  );
  requireFlag(
    lifecycle,
    command,
    "initialCaptureCloseAtomic",
    "checkout termination requires one atomic capture-window close result",
  );

  const expectedReason =
    command.target === "expired" ? "checkout_expired" : "checkout_cancelled";
  if (command.context?.initialCaptureCloseReason !== expectedReason) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      `capture-window close reason must be ${expectedReason}`,
    );
  }
}

function isCreatedJobCancellationReason(
  value: unknown,
): value is "routing_exhausted" | "order_cancelled" {
  return value === "routing_exhausted" || value === "order_cancelled";
}

function isPostAcceptanceJobCancellationReason(
  value: unknown,
): value is Exclude<JobCancellationReason, "routing_exhausted"> {
  return (
    value === "order_cancelled" ||
    value === "phase_cancelled" ||
    value === "claim_withdrawn"
  );
}

function requireJobResourceSettlement<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const jobId = command.context?.jobId;
  const productionReservationId = command.context?.productionReservationId;
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    command.context?.productionReservationJobId !== jobId ||
    command.context?.jobResourceSettlementJobId !== jobId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "resource settlement must belong to this exact Job",
    );
  }
  if (
    typeof productionReservationId !== "string" ||
    productionReservationId.length === 0 ||
    command.context?.jobResourceSettlementProductionReservationId !==
      productionReservationId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "resource settlement must use this Job's exact ProductionReservation",
    );
  }
  const expectedConsumptionMode =
    command.current === "accepted" || command.current === "gcode_ready"
      ? "zero_pre_print"
      : "actual_recorded";
  if (command.context?.materialConsumptionMode !== expectedConsumptionMode) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      `resource settlement requires ${expectedConsumptionMode} material consumption`,
    );
  }
  requireFlag(
    lifecycle,
    command,
    "materialConsumptionSettled",
    "resource settlement requires material consumption to be recorded and settled",
  );
  requireFlag(
    lifecycle,
    command,
    "inventoryReservationReleased",
    "resource settlement requires the remaining inventory reservation to be released",
  );
  requireFlag(
    lifecycle,
    command,
    "capacityReservationReleased",
    "resource settlement requires the remaining capacity reservation to be released",
  );
  requireFlag(
    lifecycle,
    command,
    "jobResourceSettlementAtomic",
    "resource settlement and the Job transition must be persisted atomically",
  );
}

function requirePrintingReservationCommit<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const jobId = command.context?.jobId;
  const productionReservationId = command.context?.productionReservationId;
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    command.context?.productionReservationJobId !== jobId ||
    command.context?.printingReservationJobId !== jobId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "printing reservation commit must belong to this exact Job",
    );
  }
  if (
    typeof productionReservationId !== "string" ||
    productionReservationId.length === 0 ||
    command.context?.printingReservationProductionReservationId !==
      productionReservationId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "printing must commit this Job's exact ProductionReservation",
    );
  }
  if (
    command.context?.printingReservationState !== "printing" ||
    command.context?.materialConsumptionMode !== "actual_recorded"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "printing must commit the reservation into material consumption",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "printingReservationCommitAtomic",
    "reservation ownership and the printing transition must commit atomically",
  );
}

function requireJobAcceptanceOwnership<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const jobId = command.context?.jobId;
  const productionReservationId = command.context?.productionReservationId;
  const orderItemId = command.context?.orderItemId;
  const phaseId = command.context?.phaseId;
  const artifactVersionId = command.context?.reproductionArtifactVersionId;
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    command.context?.productionReservationJobId !== jobId ||
    command.context?.acceptanceReservationJobId !== jobId ||
    command.context?.reproductionArtifactVersionJobId !== jobId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "acceptance ownership must belong to this exact Job",
    );
  }
  if (
    typeof productionReservationId !== "string" ||
    productionReservationId.length === 0 ||
    command.context?.acceptanceProductionReservationId !==
      productionReservationId ||
    command.context?.reproductionArtifactVersionProductionReservationId !==
      productionReservationId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "acceptance must commit this Job's exact ProductionReservation",
    );
  }
  if (
    command.context?.acceptanceMaterialPreviousState !== "held" ||
    command.context?.acceptanceMaterialTargetState !== "allocated" ||
    command.context?.acceptanceCapacityPreviousState !== "held" ||
    command.context?.acceptanceCapacityTargetState !== "scheduled"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "acceptance must allocate material and schedule reserved capacity",
    );
  }
  if (
    typeof artifactVersionId !== "string" ||
    artifactVersionId.length === 0 ||
    command.context?.acceptanceArtifactVersionId !== artifactVersionId ||
    command.context?.reproductionArtifactVersionStatus !== "draft" ||
    typeof orderItemId !== "string" ||
    orderItemId.length === 0 ||
    command.context?.reproductionArtifactVersionOrderItemId !== orderItemId ||
    typeof phaseId !== "string" ||
    phaseId.length === 0 ||
    command.context?.reproductionArtifactVersionPhaseId !== phaseId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "acceptance requires its exact draft ReproductionArtifactVersion",
    );
  }
  for (const [reservationField, artifactField] of [
    [
      "productionReservationCandidateResourceEstimateId",
      "reproductionArtifactVersionCandidateResourceEstimateId",
    ],
    [
      "productionReservationMachineProfileId",
      "reproductionArtifactVersionMachineProfileId",
    ],
    [
      "productionReservationMachineCalibrationId",
      "reproductionArtifactVersionMachineCalibrationId",
    ],
    [
      "productionReservationPrintConfigRevisionId",
      "reproductionArtifactVersionPrintConfigRevisionId",
    ],
  ] as const) {
    const reservationSnapshotId: unknown = command.context?.[reservationField];
    if (
      typeof reservationSnapshotId !== "string" ||
      reservationSnapshotId.length === 0 ||
      command.context?.[artifactField] !== reservationSnapshotId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "draft reproduction artifact must copy the exact reservation snapshot",
      );
    }
  }
  requireFlag(
    lifecycle,
    command,
    "acceptanceArtifactCreated",
    "acceptance requires creation of its draft reproduction artifact",
  );
  requireFlag(
    lifecycle,
    command,
    "jobAcceptanceAtomic",
    "reservation ownership, artifact creation, and Job acceptance must be atomic",
  );
}

function isJobFailureStageForCurrent(
  current: string,
  value: unknown,
): value is JobFailureStage {
  switch (current) {
    case "accepted":
    case "gcode_ready":
      return (
        value === "preparation" || value === "gcode" || value === "machine"
      );
    case "printing":
      return value === "printing";
    case "printed":
    case "photo_submitted":
      return value === "post_print";
    case "qc_approved":
      return value === "post_qc";
    case "packed":
      return value === "packing";
    default:
      return false;
  }
}

function hasSameNonEmptyStringSet(actual: unknown, expected: unknown): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    return false;
  }
  const normalizedActual = [...actual];
  const normalizedExpected = [...expected];
  if (
    normalizedActual.length === 0 ||
    normalizedExpected.length === 0 ||
    normalizedActual.some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    normalizedExpected.some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    return false;
  }
  const actualSet = new Set(normalizedActual);
  const expectedSet = new Set(normalizedExpected);
  return (
    actualSet.size === normalizedActual.length &&
    expectedSet.size === normalizedExpected.length &&
    actualSet.size === expectedSet.size &&
    [...actualSet].every((value) => expectedSet.has(value))
  );
}

function requirePostQcJobFailureResolution<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const jobId = command.context?.jobId;
  const phaseId = command.context?.phaseId;
  const phaseKind = command.context?.phaseKind;
  const orderId = command.context?.orderId;
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    command.context?.postQcFailureJobId !== jobId ||
    typeof phaseId !== "string" ||
    phaseId.length === 0 ||
    command.context?.postQcFailurePhaseId !== phaseId ||
    phaseKind !== "single" ||
    command.context?.postQcFailurePhaseKind !== phaseKind ||
    typeof orderId !== "string" ||
    orderId.length === 0 ||
    command.context?.postQcFailureOrderId !== orderId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "post-QC failure resolution must match the exact Job, phase, and Order",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "postQcFailureResolutionAtomic",
    "post-QC failure and aggregate recovery must be persisted atomically",
  );

  const kind = command.context?.postQcFailureResolutionKind;
  if (kind === "pre_handoff_recovery") {
    if (
      command.context?.phaseHasPriorHandoff !== false ||
      command.context?.postQcFailurePhasePreviousStatus !== "qc_passed" ||
      command.context?.postQcFailurePhaseTargetStatus !== "recovery_pending" ||
      command.context?.postQcFailureOrderTargetStatus !== "recovery_pending" ||
      command.context?.postQcFailureShipmentPlanId !== undefined ||
      command.context?.postQcFailureSlotIds !== undefined ||
      command.context?.postQcFailureSlotRecoveryBlocked !== undefined
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "pre-handoff failure must move the phase and Order into recovery",
      );
    }
    const previousOrderStatus =
      command.context?.postQcFailureOrderPreviousStatus;
    if (
      previousOrderStatus !== "qc_passed" &&
      previousOrderStatus !== "awaiting_balance" &&
      previousOrderStatus !== "ready_to_ship"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "pre-handoff failure requires a recoverable Order status",
      );
    }
    const expectedBalanceDeadlineResult =
      previousOrderStatus === "awaiting_balance" ? "invalidated" : "not_active";
    if (
      command.context?.postQcFailureBalanceDeadlineResult !==
      expectedBalanceDeadlineResult
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "pre-handoff failure must invalidate any active balance deadline",
      );
    }
    return;
  }

  if (kind === "post_handoff_slot_block") {
    const shipmentPlanId = command.context?.jobShipmentPlanId;
    if (
      command.context?.phaseHasPriorHandoff !== true ||
      command.context?.postQcFailurePhasePreviousStatus !== "shipped" ||
      command.context?.postQcFailurePhaseTargetStatus !== "shipped" ||
      command.context?.postQcFailureOrderTargetStatus !== "shipped" ||
      command.context?.postQcFailureOrderPreviousStatus !==
        command.context?.postQcFailureOrderTargetStatus ||
      command.context?.postQcFailureBalanceDeadlineResult !== "not_active" ||
      command.context?.postQcFailureSlotRecoveryBlocked !== true ||
      typeof shipmentPlanId !== "string" ||
      shipmentPlanId.length === 0 ||
      command.context?.postQcFailureShipmentPlanId !== shipmentPlanId ||
      !hasSameNonEmptyStringSet(
        command.context?.postQcFailureSlotIds,
        command.context?.jobFulfilmentSlotIds,
      )
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "post-handoff failure must preserve aggregate state and block the exact failed slot scope",
      );
    }
    return;
  }

  throw new TransitionGuardError(
    lifecycle,
    command.current,
    command.target,
    "post-QC failure requires one explicit aggregate recovery result",
  );
}

function requireJobReplacementObligation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  requireFlag(
    lifecycle,
    command,
    "replacementRequestCreated",
    "the failed or rejected job requires a replacement request",
  );
  requireFlag(
    lifecycle,
    command,
    "replacementDeadlineSet",
    "the failed or rejected job requires a replacement deadline",
  );
}

function requireRecoveryObligation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  requireFlag(
    lifecycle,
    command,
    "verifiedPostQcFailure",
    "recovery requires a verified post-QC failure",
  );
  requireFlag(
    lifecycle,
    command,
    "replacementObligationCreated",
    "recovery requires its replacement obligation",
  );
}

function requireShipmentCancellationReleased<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  requireFlag(
    lifecycle,
    command,
    "shipmentJobsAndReservationsReleased",
    "shipment cancellation requires its jobs and reservations to be released",
  );
  requireFlag(
    lifecycle,
    command,
    "parentCancellationBarrierReleased",
    "shipment cancellation requires its parent cancellation barrier to be released",
  );
}

function requireVerifiedMatchingProviderShipmentEvent<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const shipmentId = command.context?.shipmentId;
  const eventShipmentId = command.context?.providerEventShipmentId;
  if (
    typeof shipmentId !== "string" ||
    shipmentId.length === 0 ||
    eventShipmentId !== shipmentId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "provider event must match this exact shipment",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "providerEventAuthenticated",
    "shipment outcome requires an authenticated provider event",
  );
  requireFlag(
    lifecycle,
    command,
    "providerEventVerified",
    "shipment outcome requires a verified provider event",
  );
  if (command.context?.providerEventStatus !== command.target) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "provider event outcome must match the shipment transition target",
    );
  }
}

function requireVerifiedCurrentRemedyDelivery<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const currentLeafId = command.context?.currentRemedyShipmentLineageLeafId;
  const eventShipmentId = command.context?.providerEventShipmentId;
  if (
    typeof currentLeafId !== "string" ||
    currentLeafId.length === 0 ||
    eventShipmentId !== currentLeafId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "delivery must be proved by an event for the current remedy shipment lineage leaf",
    );
  }
  if (command.context?.currentRemedyShipmentLineageLeafStatus !== "delivered") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "the current remedy shipment lineage leaf must be delivered",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "providerEventAuthenticated",
    "remedy delivery requires an authenticated provider event",
  );
  requireFlag(
    lifecycle,
    command,
    "providerEventVerified",
    "remedy delivery requires a verified provider event",
  );
  if (command.context?.providerEventStatus !== "delivered") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "remedy delivery requires a matching delivered provider event",
    );
  }
}

function requireVerifiedCurrentRemedyIncident<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const currentLeafId = command.context?.currentRemedyShipmentLineageLeafId;
  const eventShipmentId = command.context?.providerEventShipmentId;
  if (
    typeof currentLeafId !== "string" ||
    currentLeafId.length === 0 ||
    eventShipmentId !== currentLeafId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "remedy incident must match the exact current shipment lineage leaf",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "providerEventAuthenticated",
    "remedy incident requires an authenticated provider event",
  );
  requireFlag(
    lifecycle,
    command,
    "providerEventVerified",
    "remedy incident requires a verified provider event",
  );
  const eventStatus = command.context?.providerEventStatus;
  if (
    (eventStatus !== "lost" && eventStatus !== "returned") ||
    command.context?.currentRemedyShipmentLineageLeafStatus !== eventStatus
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "remedy recovery requires a matching lost or returned provider outcome",
    );
  }
}

export type QuoteRequestStatus =
  "new" | "in_review" | "quoted" | "accepted" | "rejected" | "expired";

export const quoteRequestPolicy: TransitionPolicy<QuoteRequestStatus> = {
  name: "QuoteRequest",
  initial: ["new"],
  terminal: ["accepted", "rejected", "expired"],
  transitions: {
    new: ["in_review"],
    in_review: ["quoted"],
    quoted: ["accepted", "rejected", "expired"],
  },
  guard: (command) => {
    if (command.current === "quoted" && command.target === "accepted") {
      requireFlag(
        "QuoteRequest",
        command,
        "quoteAvailable",
        "the immutable quote must still be available",
      );
    }
  },
};

/** Quotes are immutable offers. Their availability is owned by QuoteRequest state. */
export interface IssuedQuote {
  readonly id: string;
  readonly quoteRequestId: string;
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
}

export function isQuoteAvailable(
  quote: IssuedQuote,
  quoteRequestStatus: QuoteRequestStatus,
  now: Instant,
): boolean {
  return (
    quoteRequestStatus === "quoted" &&
    now.compare(quote.issuedAt) >= 0 &&
    now.compare(quote.expiresAt) < 0
  );
}

/** Acceptance is a QuoteRequest transition, guarded by the immutable offer. */
export function canAcceptQuote(
  quote: IssuedQuote,
  quoteRequestStatus: QuoteRequestStatus,
  now: Instant,
): boolean {
  return isQuoteAvailable(quote, quoteRequestStatus, now);
}

export type PaymentStatus =
  | "created"
  | "pending"
  | "captured"
  | "failed"
  | "voided"
  | "refund_pending"
  | "partially_refunded"
  | "refunded";

export type PaymentRole = "full" | "deposit" | "balance";

export const paymentPolicy: TransitionPolicy<PaymentStatus> = {
  name: "Payment",
  initial: ["created"],
  terminal: ["failed", "refunded"],
  transitions: {
    created: ["pending"],
    pending: ["captured", "failed", "voided", "refund_pending"],
    captured: ["refund_pending"],
    partially_refunded: ["refund_pending"],
    voided: ["refund_pending"],
    refund_pending: ["partially_refunded", "refunded"],
  },
  guard: (command) => {
    if (command.current === "pending" && command.target === "captured") {
      if (command.context?.paymentCaptureKind !== "settlement") {
        throw new TransitionGuardError(
          "Payment",
          command.current,
          command.target,
          "ordinary capture requires a settlement Payment",
        );
      }
      requireFlag(
        "Payment",
        command,
        "captureAuthorized",
        "capture must be authorized and before its immutable cutoff",
      );
      requireVerifiedMatchingProviderPaymentEvent("Payment", command);
    }
    if (command.current === "pending" && command.target === "refund_pending") {
      if (command.context?.initialPaymentStatus !== "refund_pending") {
        throw new TransitionGuardError(
          "Payment",
          command.current,
          command.target,
          "capacity compensation must persist the Payment as refund pending",
        );
      }
      requireInitialCapacityCaptureCompensation("Payment", command);
    }
    if (command.current === "voided" && command.target === "refund_pending") {
      requireVerifiedLateCaptureCompensation("Payment", command);
    }
    if (command.current === "pending" && command.target === "failed") {
      requireVerifiedMatchingProviderPaymentEvent("Payment", command);
    }
    if (command.current === "pending" && command.target === "voided") {
      requireFlag(
        "Payment",
        command,
        "captureWindowClosed",
        "voiding requires the capture window to be closed",
      );
      requireFlag(
        "Payment",
        command,
        "captureCutoffSet",
        "voiding requires the capture cutoff to be recorded",
      );
      requireFlag(
        "Payment",
        command,
        "providerVoidOutboxCreated",
        "voiding requires the provider void command to be persisted",
      );
    }
    if (command.current === "captured" && command.target === "refund_pending") {
      if (command.context?.paymentCaptureKind !== "settlement") {
        throw new TransitionGuardError(
          "Payment",
          command.current,
          command.target,
          "ordinary refund requires a settlement Payment",
        );
      }
      requireFlag(
        "Payment",
        command,
        "scopedRefundTransactionCreated",
        "refund pending requires its scoped refund transaction",
      );
      requireFlag(
        "Payment",
        command,
        "refundPriceAdjustmentActivated",
        "refund pending requires its price adjustment to be activated",
      );
    }
    if (
      command.current === "partially_refunded" &&
      command.target === "refund_pending"
    ) {
      const captureKind = command.context?.paymentCaptureKind;
      if (
        captureKind === "initial_checkout_capacity" ||
        captureKind === "late_capture"
      ) {
        if (command.context?.compensationRefundRetryKind !== captureKind) {
          throw new TransitionGuardError(
            "Payment",
            command.current,
            command.target,
            "compensation retry kind must match the persisted capture kind",
          );
        }
        requireCompensationRefundRetry("Payment", command);
      } else if (captureKind === "settlement") {
        requireFlag(
          "Payment",
          command,
          "scopedRefundTransactionCreated",
          "refund pending requires its scoped refund transaction",
        );
        requireFlag(
          "Payment",
          command,
          "refundPriceAdjustmentActivated",
          "refund pending requires its price adjustment to be activated",
        );
      } else {
        throw new TransitionGuardError(
          "Payment",
          command.current,
          command.target,
          "refund retry requires the persisted Payment capture kind",
        );
      }
    }
    if (
      command.current === "refund_pending" &&
      (command.target === "partially_refunded" || command.target === "refunded")
    ) {
      requireVerifiedMatchingRefundWebhook("Payment", command);
    }
  },
};

export type OrderStatus =
  | "draft"
  | "quoted"
  | "confirmed"
  | "in_production"
  | "qc_passed"
  | "awaiting_balance"
  | "ready_to_ship"
  | "shipped"
  | "delivered"
  | "completed"
  | "recovery_pending"
  | "cancelled"
  | "refunded"
  | "cancelled_settled"
  | "partially_fulfilled"
  | "expired";

export const orderPolicy: TransitionPolicy<OrderStatus> = {
  name: "Order",
  initial: ["draft"],
  terminal: [
    "completed",
    "partially_fulfilled",
    "refunded",
    "cancelled_settled",
    "expired",
  ],
  contextualTerminal: (state, context) =>
    state === "cancelled" && context?.paymentStatus === "unpaid",
  transitions: {
    draft: ["quoted"],
    quoted: ["confirmed", "expired", "cancelled"],
    confirmed: ["in_production", "cancelled"],
    in_production: ["qc_passed", "partially_fulfilled", "cancelled"],
    qc_passed: [
      "awaiting_balance",
      "ready_to_ship",
      "recovery_pending",
      "cancelled",
    ],
    awaiting_balance: [
      "ready_to_ship",
      "shipped",
      "recovery_pending",
      "cancelled",
      "cancelled_settled",
    ],
    ready_to_ship: ["shipped", "recovery_pending", "cancelled"],
    shipped: ["delivered", "partially_fulfilled", "cancelled"],
    delivered: ["completed"],
    recovery_pending: ["qc_passed", "cancelled", "partially_fulfilled"],
    cancelled: ["refunded", "cancelled_settled"],
  },
  guard: (command) => {
    if (command.current === "draft" && command.target === "quoted") {
      requireFlag(
        "Order",
        command,
        "singleOrderPhaseCreated",
        "quoting requires the single OrderPhase to be created",
      );
      requireFlag(
        "Order",
        command,
        "immutableFulfilmentSlotsCreated",
        "quoting requires immutable fulfilment slots",
      );
      requireFlag(
        "Order",
        command,
        "setupAtomic",
        "order setup requires the phase and slots to be persisted atomically",
      );
    }
    if (command.current === "quoted" && command.target === "confirmed") {
      requireFlag(
        "Order",
        command,
        "completeReservationCaptured",
        "capture and the complete phase reservation set must be valid",
      );
    }
    if (
      command.current === "quoted" &&
      (command.target === "expired" || command.target === "cancelled")
    ) {
      if (
        command.context?.initialPaymentStatus === "refund_pending" ||
        command.context?.initialPaymentStatus === "refunded"
      ) {
        requireInitialCapacityCaptureCompensation("Order", command);
        if (
          command.target !== "cancelled" ||
          command.context?.capacityCaptureOrderTargetStatus !== command.target
        ) {
          throw new TransitionGuardError(
            "Order",
            command.current,
            command.target,
            "capacity-compensated checkout must close as cancelled",
          );
        }
      } else {
        requireInitialCaptureWindowClosed("Order", command);
      }
    }
    if (
      (command.current === "in_production" ||
        command.current === "recovery_pending") &&
      command.target === "qc_passed"
    ) {
      requireFlag(
        "Order",
        command,
        "verifiedQcReadiness",
        "quality control requires a complete projected slot readiness result",
      );
    }
    if (
      command.current === "qc_passed" &&
      command.target === "awaiting_balance"
    ) {
      requireBalancePaymentDeadlineSetup("Order", command);
    }
    if (
      (command.current === "qc_passed" ||
        command.current === "awaiting_balance" ||
        command.current === "ready_to_ship") &&
      command.target === "recovery_pending"
    ) {
      requireRecoveryObligation("Order", command);
    }
    if (command.current === "ready_to_ship" && command.target === "shipped") {
      requireFlag(
        "Order",
        command,
        "shipmentHandoffAuthorized",
        "the complete shipment handoff guard must pass",
      );
      requireZeroBalances("Order", command);
    }
    if (
      command.current === "awaiting_balance" &&
      command.target === "shipped"
    ) {
      requireFlag(
        "Order",
        command,
        "handoffReconciliation",
        "only an immutable unauthorized-handoff reconciliation may use this edge",
      );
      requireFlag(
        "Order",
        command,
        "handoffSettlementCompleted",
        "the handoff reconciliation's immutable settlement must be complete",
      );
      requireZeroAmountDue("Order", command);
      requireReconciliationRefundAllocation("Order", command);
    }
    if (
      command.current === "awaiting_balance" &&
      command.target === "ready_to_ship"
    ) {
      requireZeroBalances("Order", command);
    }
    if (command.current === "qc_passed" && command.target === "ready_to_ship") {
      requireZeroBalances("Order", command);
      requireFlag(
        "Order",
        command,
        "completeShipmentReadiness",
        "ready to ship requires every shipment to be ready for handoff",
      );
    }
    if (command.current === "shipped" && command.target === "delivered") {
      requireAllShipmentLineageLeavesDelivered("Order", command);
    }
    if (command.target === "cancelled") {
      requireFlag(
        "Order",
        command,
        "preHandoffShipmentCancellationsCompleted",
        "all pre-handoff shipment cancellations must complete before cancellation",
      );
      if (
        command.current === "shipped" ||
        command.current === "recovery_pending"
      ) {
        requireFlag(
          "Order",
          command,
          "recoveryFinancialSettlementCompleted",
          "post-handoff cancellation requires its recovery financial settlement",
        );
      }
    }
    if (
      command.target === "completed" ||
      command.target === "partially_fulfilled" ||
      command.target === "refunded" ||
      command.target === "cancelled_settled"
    ) {
      requireFlag(
        "Order",
        command,
        "completionProjected",
        "all phase, slot, shipment, and settlement barriers must be complete",
      );
      requireProjectedCompletionTarget("Order", command);
    }
    if (
      command.current === "cancelled" &&
      (command.target === "refunded" || command.target === "cancelled_settled")
    ) {
      requireProjectedFinancialTerminalTarget("Order", command);
    }
    if (
      command.current === "awaiting_balance" &&
      command.target === "cancelled_settled"
    ) {
      requireFlag(
        "Order",
        command,
        "balanceCaptureClosed",
        "balance settlement requires the capture window to be closed",
      );
      requireFlag(
        "Order",
        command,
        "immutableOrderSettlementCompleted",
        "balance settlement requires the immutable order settlement",
      );
    }
    if (
      command.target === "refunded" ||
      command.target === "cancelled_settled"
    ) {
      requireZeroBalances("Order", command);
    }
  },
};

export type SingleOrderPhaseStatus =
  | "quoted"
  | "active"
  | "in_production"
  | "qc_passed"
  | "shipped"
  | "delivered"
  | "completed"
  | "recovery_pending"
  | "cancelled"
  | "cancelled_refunded"
  | "cancelled_settled"
  | "partially_fulfilled";

export type V0OrderPhaseKind = "single";

/** Explicit v0 single-phase topology; it is deliberately not inferred from Order. */
export const singleOrderPhasePolicy: TransitionPolicy<SingleOrderPhaseStatus> =
  {
    name: "OrderPhase(single)",
    initial: ["quoted"],
    terminal: [
      "completed",
      "cancelled_refunded",
      "cancelled_settled",
      "partially_fulfilled",
    ],
    contextualTerminal: (state, context) =>
      state === "cancelled" && context?.paymentStatus === "unpaid",
    transitions: {
      quoted: ["active", "cancelled"],
      active: ["in_production", "cancelled"],
      in_production: ["qc_passed", "cancelled"],
      qc_passed: ["shipped", "recovery_pending", "cancelled"],
      shipped: ["delivered", "partially_fulfilled", "cancelled_refunded"],
      delivered: ["completed"],
      recovery_pending: [
        "qc_passed",
        "partially_fulfilled",
        "cancelled_refunded",
      ],
      cancelled: ["cancelled_refunded", "cancelled_settled"],
    },
    guard: (command) => {
      if (command.current === "quoted" && command.target === "active") {
        requireFlag(
          "OrderPhase(single)",
          command,
          "completeReservationCaptured",
          "capture and the complete phase reservation set must be valid",
        );
      }
      if (
        (command.current === "in_production" ||
          command.current === "recovery_pending") &&
        command.target === "qc_passed"
      ) {
        requireFlag(
          "OrderPhase(single)",
          command,
          "verifiedQcReadiness",
          "quality control requires a complete projected slot readiness result",
        );
      }
      if (
        command.current === "qc_passed" &&
        command.target === "recovery_pending"
      ) {
        requireRecoveryObligation("OrderPhase(single)", command);
      }
      if (command.current === "qc_passed" && command.target === "shipped") {
        requireFlag(
          "OrderPhase(single)",
          command,
          "shipmentHandoffAuthorized",
          "the complete shipment handoff guard must pass",
        );
        requireZeroBalances("OrderPhase(single)", command);
      }
      if (command.current === "shipped" && command.target === "delivered") {
        requireAllShipmentLineageLeavesDelivered("OrderPhase(single)", command);
      }
      if (
        command.target === "cancelled" ||
        ((command.current === "shipped" ||
          command.current === "recovery_pending") &&
          command.target === "cancelled_refunded")
      ) {
        requireFlag(
          "OrderPhase(single)",
          command,
          "preHandoffShipmentCancellationsCompleted",
          "all pre-handoff shipment cancellations must complete before cancellation",
        );
      }
      if (
        (command.current === "shipped" ||
          command.current === "recovery_pending") &&
        command.target === "cancelled_refunded"
      ) {
        requireFlag(
          "OrderPhase(single)",
          command,
          "recoveryFinancialSettlementCompleted",
          "post-handoff cancellation requires its recovery financial settlement",
        );
      }
      if (
        command.target === "completed" ||
        command.target === "partially_fulfilled" ||
        command.target === "cancelled_refunded" ||
        command.target === "cancelled_settled"
      ) {
        requireFlag(
          "OrderPhase(single)",
          command,
          "completionProjected",
          "all required fulfilment slots must have a terminal outcome",
        );
        requireProjectedCompletionTarget("OrderPhase(single)", command);
      }
      if (
        command.current === "cancelled" &&
        (command.target === "cancelled_refunded" ||
          command.target === "cancelled_settled")
      ) {
        requireProjectedFinancialTerminalTarget("OrderPhase(single)", command);
      }
      if (
        command.target === "cancelled_refunded" ||
        command.target === "cancelled_settled"
      ) {
        requireZeroBalances("OrderPhase(single)", command);
      }
    },
  };

export type JobStatus =
  | "created"
  | "accepted"
  | "gcode_ready"
  | "printing"
  | "printed"
  | "photo_submitted"
  | "qc_approved"
  | "qc_rejected"
  | "packed"
  | "handed_over"
  | "settled"
  | "failed"
  | "cancelled";

export type JobFailureStage =
  | "preparation"
  | "gcode"
  | "machine"
  | "printing"
  | "post_print"
  | "post_qc"
  | "packing";

export type JobCancellationReason =
  | "routing_exhausted"
  | "order_cancelled"
  | "phase_cancelled"
  | "claim_withdrawn";

export const jobPolicy: TransitionPolicy<JobStatus> = {
  name: "Job",
  initial: ["created"],
  terminal: ["settled", "qc_rejected", "failed", "cancelled"],
  transitions: {
    created: ["accepted", "cancelled"],
    accepted: ["gcode_ready", "failed", "cancelled"],
    gcode_ready: ["printing", "failed", "cancelled"],
    printing: ["printed", "failed", "cancelled"],
    printed: ["photo_submitted", "failed", "cancelled"],
    photo_submitted: ["qc_approved", "qc_rejected", "failed", "cancelled"],
    qc_approved: ["packed", "failed", "cancelled"],
    packed: ["handed_over", "failed", "cancelled"],
    handed_over: ["settled"],
  },
  guard: (command) => {
    if (command.target === "cancelled") {
      const cancellationReason = command.context?.cancellationReason;
      const validReason =
        command.current === "created"
          ? isCreatedJobCancellationReason(cancellationReason)
          : isPostAcceptanceJobCancellationReason(cancellationReason);
      if (!validReason) {
        throw new TransitionGuardError(
          "Job",
          command.current,
          command.target,
          "cancellation requires a valid cancellation reason",
        );
      }
      if (command.current === "created") {
        requireFlag(
          "Job",
          command,
          "offersClosed",
          "cancellation requires all routing offers to be closed",
        );
        requireFlag(
          "Job",
          command,
          "productionReservationReleased",
          "cancellation requires its production reservation to be released",
        );
      } else {
        requireJobResourceSettlement("Job", command);
        requireFlag(
          "Job",
          command,
          "labelCancellationBarrierCompleted",
          "cancellation requires every carrier label cancellation barrier to complete",
        );
      }
    }
    if (command.current === "created" && command.target === "accepted") {
      requireFlag(
        "Job",
        command,
        "nodeAssigned",
        "acceptance requires a verified node assignment",
      );
      requireJobAcceptanceOwnership("Job", command);
    }
    if (command.current === "accepted" && command.target === "gcode_ready") {
      requireFlag(
        "Job",
        command,
        "productionSliceFromReservationSnapshot",
        "G-code requires a production slice from the reservation snapshot",
      );
      requireFlag(
        "Job",
        command,
        "reproductionArtifactSealed",
        "G-code requires its reproduction artifact to be sealed",
      );
    }
    if (command.current === "gcode_ready" && command.target === "printing") {
      requirePrintingReservationCommit("Job", command);
    }
    if (command.current === "printed" && command.target === "photo_submitted") {
      requireFlag(
        "Job",
        command,
        "qcPhotoAssetStored",
        "photo submission requires the QC PhotoAsset to be stored",
      );
      requireFlag(
        "Job",
        command,
        "photoRetentionDeadlineSet",
        "photo submission requires the PhotoAsset retention deadline",
      );
    }
    if (
      command.current === "photo_submitted" &&
      command.target === "qc_approved"
    ) {
      requireFlag(
        "Job",
        command,
        "qcApprovalVerified",
        "QC approval requires a verified QC decision",
      );
    }
    if (
      command.current === "photo_submitted" &&
      command.target === "qc_rejected"
    ) {
      requireFlag(
        "Job",
        command,
        "qcRejectionVerified",
        "QC rejection requires a verified QC decision",
      );
      requireJobResourceSettlement("Job", command);
      requireFlag(
        "Job",
        command,
        "labelCancellationBarrierCompleted",
        "QC rejection requires every carrier label cancellation barrier to complete",
      );
      requireJobReplacementObligation("Job", command);
    }
    if (command.target === "failed") {
      if (
        !isJobFailureStageForCurrent(
          command.current,
          command.context?.failureStage,
        )
      ) {
        throw new TransitionGuardError(
          "Job",
          command.current,
          command.target,
          "failure stage must match the Job's current lifecycle state",
        );
      }
      const failureReason = command.context?.failureReason;
      if (
        typeof failureReason !== "string" ||
        failureReason.trim().length === 0
      ) {
        throw new TransitionGuardError(
          "Job",
          command.current,
          command.target,
          "failure requires a non-blank failure reason",
        );
      }
      requireJobResourceSettlement("Job", command);
      requireFlag(
        "Job",
        command,
        "labelCancellationBarrierCompleted",
        "failure requires every carrier label cancellation barrier to complete",
      );
      if (command.current === "qc_approved" || command.current === "packed") {
        requirePostQcJobFailureResolution("Job", command);
      }
      requireJobReplacementObligation("Job", command);
    }
    if (command.current === "packed" && command.target === "handed_over") {
      requireFlag(
        "Job",
        command,
        "contextHandoffCompleted",
        "handoff requires its complete context-specific transaction",
      );
    }
  },
};

export type ShipmentStatus =
  | "planned"
  | "label_created"
  | "cancellation_pending"
  | "handed_over"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "lost"
  | "returned"
  | "recovered";

export const shipmentPolicy: TransitionPolicy<ShipmentStatus> = {
  name: "Shipment",
  initial: ["planned"],
  terminal: ["delivered", "cancelled", "returned", "recovered"],
  transitions: {
    planned: ["label_created", "cancelled"],
    label_created: ["handed_over", "cancellation_pending"],
    cancellation_pending: ["cancelled", "handed_over"],
    handed_over: ["in_transit"],
    in_transit: ["delivered", "lost", "returned"],
    lost: ["recovered"],
  },
  guard: (command) => {
    if (command.current === "planned" && command.target === "cancelled") {
      requireShipmentCancellationReleased("Shipment", command);
    }
    if (
      command.current === "label_created" &&
      command.target === "cancellation_pending"
    ) {
      requireFlag(
        "Shipment",
        command,
        "labelInvalidated",
        "cancellation requires the carrier label to be invalidated",
      );
      requireFlag(
        "Shipment",
        command,
        "providerVoidOutboxCreated",
        "cancellation requires the provider void command to be persisted",
      );
    }
    if (command.target === "handed_over") {
      requireFlag(
        "Shipment",
        command,
        "contextHandoffCompleted",
        "the complete context-specific handoff or reconciliation must complete",
      );
    }
    if (
      command.current === "cancellation_pending" &&
      command.target === "handed_over"
    ) {
      requireFlag(
        "Shipment",
        command,
        "verifiedProviderScan",
        "a verified provider custody scan must win the cancellation race",
      );
    }
    if (
      command.current === "cancellation_pending" &&
      command.target === "cancelled"
    ) {
      requireFlag(
        "Shipment",
        command,
        "verifiedProviderVoid",
        "cancellation requires the provider to verify its void result",
      );
      requireShipmentCancellationReleased("Shipment", command);
    }
    if (command.current === "handed_over" && command.target === "in_transit") {
      requireVerifiedMatchingProviderShipmentEvent("Shipment", command);
    }
    if (
      command.current === "in_transit" &&
      (command.target === "delivered" ||
        command.target === "lost" ||
        command.target === "returned")
    ) {
      requireVerifiedMatchingProviderShipmentEvent("Shipment", command);
    }
    if (command.current === "lost" && command.target === "recovered") {
      requireVerifiedMatchingProviderShipmentEvent("Shipment", command);
      requireFlag(
        "Shipment",
        command,
        "custodyConfirmed",
        "recovery requires confirmed shipment custody",
      );
    }
  },
};

export type ClaimStatus =
  | "opened"
  | "investigating"
  | "active"
  | "resolved_rejected"
  | "resolved_reprint"
  | "resolved_reship"
  | "resolved_refund"
  | "resolved_mixed"
  | "withdrawn";

export type ClaimOrigin = "post_delivery_quality" | "shipment_incident";

export type ClaimSlotResolutionTerminalStatus =
  | "rejected"
  | "delivered_reship"
  | "delivered_reprint"
  | "refunded"
  | "withdrawn";

const claimTerminalProjection: Readonly<
  Record<ClaimSlotResolutionTerminalStatus, ClaimStatus>
> = {
  rejected: "resolved_rejected",
  delivered_reship: "resolved_reship",
  delivered_reprint: "resolved_reprint",
  refunded: "resolved_refund",
  withdrawn: "withdrawn",
};

function isClaimSlotResolutionTerminalStatus(
  status: unknown,
): status is ClaimSlotResolutionTerminalStatus {
  return (
    typeof status === "string" &&
    Object.prototype.hasOwnProperty.call(claimTerminalProjection, status)
  );
}

/** Projects a claim's terminal status from every child resolution disposition. */
export function projectClaimTerminalStatus(
  statuses: readonly ClaimSlotResolutionStatus[],
): ClaimStatus | undefined {
  const normalizedStatuses = [...statuses];
  if (
    normalizedStatuses.length === 0 ||
    normalizedStatuses.some(
      (status) => !isClaimSlotResolutionTerminalStatus(status),
    )
  ) {
    return undefined;
  }

  const firstStatus = normalizedStatuses[0];
  if (firstStatus === undefined) {
    return undefined;
  }
  if (!isClaimSlotResolutionTerminalStatus(firstStatus)) {
    return undefined;
  }
  if (normalizedStatuses.every((status) => status === firstStatus)) {
    return claimTerminalProjection[firstStatus];
  }

  if (
    normalizedStatuses.some(
      (status) => status === "rejected" || status === "withdrawn",
    )
  ) {
    return undefined;
  }

  return "resolved_mixed";
}

export const claimPolicy: TransitionPolicy<ClaimStatus> = {
  name: "Claim",
  initial: ["opened"],
  terminal: [
    "resolved_rejected",
    "resolved_reprint",
    "resolved_reship",
    "resolved_refund",
    "resolved_mixed",
    "withdrawn",
  ],
  transitions: {
    opened: ["investigating", "withdrawn"],
    investigating: ["active", "resolved_rejected", "withdrawn"],
    active: [
      "resolved_reprint",
      "resolved_reship",
      "resolved_refund",
      "resolved_mixed",
      "withdrawn",
    ],
  },
  guard: (command) => {
    if (
      command.target.startsWith("resolved_") ||
      command.target === "withdrawn"
    ) {
      const statuses = command.context?.claimSlotResolutionStatuses;
      if (
        !Array.isArray(statuses) ||
        statuses.some((status) => typeof status !== "string")
      ) {
        throw new TransitionGuardError(
          "Claim",
          command.current,
          command.target,
          "every claim slot resolution must have a terminal disposition",
        );
      }

      const projected = projectClaimTerminalStatus(
        statuses as ClaimSlotResolutionStatus[],
      );
      if (projected !== command.target) {
        throw new TransitionGuardError(
          "Claim",
          command.current,
          command.target,
          `terminal target must match child disposition projection (${projected ?? "non-terminal"})`,
        );
      }
    }
    if (
      command.target === "resolved_rejected" ||
      command.target === "withdrawn"
    ) {
      requireFlag(
        "Claim",
        command,
        "cleanPostDeliveryQualityClaim",
        "incident-backed or handed-off remedies cannot be rejected or withdrawn",
      );
    }
  },
};

export type ClaimSlotResolutionStatus =
  | "pending"
  | "rejected"
  | "reship_pending"
  | "reship_shipped"
  | "delivered_reship"
  | "reprint_pending"
  | "replacement_in_production"
  | "replacement_shipped"
  | "delivered_reprint"
  | "refund_pending"
  | "refunded"
  | "recovery_pending"
  | "withdrawn";

export const claimSlotResolutionPolicy: TransitionPolicy<ClaimSlotResolutionStatus> =
  {
    name: "ClaimSlotResolution",
    initial: ["pending"],
    terminal: [
      "rejected",
      "delivered_reship",
      "delivered_reprint",
      "refunded",
      "withdrawn",
    ],
    transitions: {
      pending: [
        "rejected",
        "reship_pending",
        "reprint_pending",
        "refund_pending",
        "withdrawn",
      ],
      reship_pending: ["reship_shipped", "refund_pending", "withdrawn"],
      reship_shipped: ["delivered_reship", "recovery_pending"],
      reprint_pending: [
        "replacement_in_production",
        "refund_pending",
        "withdrawn",
      ],
      replacement_in_production: [
        "replacement_shipped",
        "refund_pending",
        "recovery_pending",
        "withdrawn",
      ],
      replacement_shipped: ["delivered_reprint", "recovery_pending"],
      refund_pending: ["refunded"],
      recovery_pending: [
        "reship_pending",
        "reprint_pending",
        "refund_pending",
        "withdrawn",
      ],
    },
    guard: (command) => {
      if (command.current === "pending" && command.target === "rejected") {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "cleanPostDeliveryQualityClaim",
          "only a clean post-delivery quality claim can be rejected",
        );
      }
      if (
        command.current === "reship_pending" &&
        command.target === "reship_shipped"
      ) {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "reshipmentAuthorizationConsumed",
          "reship handoff requires consumption of its custody-backed authorization",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "reshipmentHandoffCompleted",
          "reship handoff requires the complete authorization-backed handoff result",
        );
      }
      if (
        command.current === "reprint_pending" &&
        command.target === "replacement_in_production"
      ) {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "replacementSetProjected",
          "replacement production requires the complete all-or-none replacement slot set",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "replacementResourcePlanProjected",
          "replacement production requires the complete replacement resource plan",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "replacementReservationsCreated",
          "replacement production requires every replacement reservation",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "replacementShipmentsCreated",
          "replacement production requires every replacement shipment",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "replacementJobLineageCreated",
          "replacement production requires every replacement job lineage leaf",
        );
      }
      if (
        command.current === "replacement_in_production" &&
        command.target === "replacement_shipped"
      ) {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "replacementFulfilmentAuthorizationConsumed",
          "replacement handoff requires one-shot consumption of its fulfilment authorization",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "replacementFulfilmentHandoffCompleted",
          "replacement handoff requires the complete authorization-backed handoff result",
        );
      }
      if (command.target === "refund_pending") {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "claimCreditScopeCreated",
          "refund requires an immutable scope containing only its refund-target claim slots",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "claimSlotCreditActivated",
          "refund requires the scoped claim credit price adjustment and refund setup",
        );
      }
      if (
        command.target === "refund_pending" &&
        command.current !== "pending" &&
        command.current !== "recovery_pending"
      ) {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "remedyCancellationCompleted",
          "all pre-handoff remedy shipments and jobs must be cancelled first",
        );
      }
      if (
        command.current === "refund_pending" &&
        command.target === "refunded"
      ) {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "scopedRefundTransactionSucceeded",
          "refund completion requires a successful scoped RefundTransaction",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "refundPaymentWebhookVerified",
          "refund completion requires the matching verified payment webhook result",
        );
      }
      if (
        command.current === "replacement_in_production" &&
        command.target === "recovery_pending"
      ) {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "remedyCancellationCompleted",
          "pre-handoff replacement recovery requires its cancellation barrier",
        );
      }
      if (
        (command.current === "replacement_shipped" ||
          command.current === "reship_shipped") &&
        command.target === "recovery_pending"
      ) {
        requireVerifiedCurrentRemedyIncident("ClaimSlotResolution", command);
      }
      if (
        (command.current === "reship_shipped" &&
          command.target === "delivered_reship") ||
        (command.current === "replacement_shipped" &&
          command.target === "delivered_reprint")
      ) {
        requireVerifiedCurrentRemedyDelivery("ClaimSlotResolution", command);
      }
      if (
        (command.current === "pending" ||
          command.current === "recovery_pending") &&
        command.target === "reship_pending"
      ) {
        const shipmentStatus = command.context?.shipmentStatus;
        if (shipmentStatus !== "returned" && shipmentStatus !== "recovered") {
          throw new TransitionGuardError(
            "ClaimSlotResolution",
            command.current,
            command.target,
            "reship selection requires the original shipment to be returned or recovered",
          );
        }
        requireFlag(
          "ClaimSlotResolution",
          command,
          "custodyConfirmed",
          "reship selection requires confirmed custody of the original shipment",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "freshQcPassed",
          "reship selection requires fresh quality control after recovery",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "reshipmentAuthorizationCreated",
          "reship selection requires its custody-backed authorization",
        );
        requireFlag(
          "ClaimSlotResolution",
          command,
          "reshipmentAuthorizationSetupAtomic",
          "reship authorization must be created atomically with the reship setup",
        );
      }
      if (command.target === "withdrawn") {
        requireFlag(
          "ClaimSlotResolution",
          command,
          "cleanPostDeliveryQualityClaim",
          "only a clean post-delivery quality claim can be withdrawn",
        );
        if (command.current !== "pending") {
          requireFlag(
            "ClaimSlotResolution",
            command,
            "remedyCancellationCompleted",
            "withdrawal requires the pre-handoff cancellation barrier",
          );
        }
      }
    },
  };
