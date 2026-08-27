import { Instant } from "../primitives/time.js";
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
      "transition requires zero amount due and refundable balance",
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

function requireCompleteConfirmationJobLinks<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  orderId: string,
  phaseId: string,
  phaseReservationSetId: string,
): void {
  const expectedKeysValue = command.context?.phaseReservationSetPlannedJobKeys;
  const linksValue = command.context?.confirmationReservationJobLinks;
  const expectedKeys = Array.isArray(expectedKeysValue)
    ? [...expectedKeysValue]
    : undefined;
  const links = Array.isArray(linksValue) ? [...linksValue] : undefined;
  if (
    expectedKeys === undefined ||
    expectedKeys.length === 0 ||
    expectedKeys.some(
      (key) => typeof key !== "string" || key.trim().length === 0,
    ) ||
    new Set(expectedKeys).size !== expectedKeys.length ||
    links === undefined ||
    links.length !== expectedKeys.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "confirmation requires one Job link for every planned job key",
    );
  }
  const plannedJobKeys = expectedKeys as string[];

  const linkedKeys = new Set<string>();
  const reservationIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const value of links) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "confirmation Job links must be complete identity records",
      );
    }
    const link = value as Readonly<Record<string, unknown>>;
    const plannedJobKey = link.plannedJobKey;
    const productionReservationId = link.productionReservationId;
    const jobId = link.jobId;
    if (
      typeof plannedJobKey !== "string" ||
      plannedJobKey.trim().length === 0 ||
      typeof productionReservationId !== "string" ||
      productionReservationId.trim().length === 0 ||
      typeof jobId !== "string" ||
      jobId.trim().length === 0 ||
      link.reservationOrderId !== orderId ||
      link.reservationPhaseId !== phaseId ||
      link.reservationSetId !== phaseReservationSetId ||
      link.reservationPlannedJobKey !== plannedJobKey ||
      link.reservationJobId !== jobId ||
      link.jobOrderId !== orderId ||
      link.jobPhaseId !== phaseId ||
      link.jobProductionReservationId !== productionReservationId ||
      link.jobPlannedJobKey !== plannedJobKey ||
      link.jobStatus !== "created" ||
      linkedKeys.has(plannedJobKey) ||
      reservationIds.has(productionReservationId) ||
      jobIds.has(jobId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "confirmation must create unique Jobs linked to their exact reservations",
      );
    }
    linkedKeys.add(plannedJobKey);
    reservationIds.add(productionReservationId);
    jobIds.add(jobId);
  }
  if (
    plannedJobKeys.some((key) => !linkedKeys.has(key)) ||
    [...linkedKeys].some((key) => !plannedJobKeys.includes(key))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "confirmation Job links must exactly match the planned job key set",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "confirmationJobsCreated",
    "confirmation requires the complete Job set to be created",
  );
  requireFlag(
    lifecycle,
    command,
    "confirmationJobCreationAtomic",
    "capture, activation, Job creation, and reservation linking must be atomic",
  );
}

function requireAtomicConfirmationActivation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const paymentId = command.context?.paymentId;
  const paymentRole = command.context?.paymentRole;
  const providerTransactionId = command.context?.providerPaymentTransactionId;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const phaseReservationSetId = command.context?.phaseReservationSetId;
  if (
    typeof paymentId !== "string" ||
    paymentId.trim().length === 0 ||
    command.context?.confirmationActivationPaymentId !== paymentId ||
    (paymentRole !== "full" && paymentRole !== "deposit") ||
    command.context?.initialPaymentRole !== paymentRole ||
    command.context?.initialPaymentId !== paymentId ||
    typeof providerTransactionId !== "string" ||
    providerTransactionId.trim().length === 0 ||
    command.context?.confirmationActivationProviderTransactionId !==
      providerTransactionId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.initialPaymentOrderId !== orderId ||
    command.context?.confirmationActivationOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.confirmationActivationPhaseId !== phaseId ||
    typeof phaseReservationSetId !== "string" ||
    phaseReservationSetId.trim().length === 0 ||
    command.context?.confirmationActivationPhaseReservationSetId !==
      phaseReservationSetId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "confirmation must bind the exact Payment, Order, phase, and reservation set",
    );
  }
  if (
    command.context?.phaseKind !== "single" ||
    command.context?.confirmationOrderPreviousStatus !== "quoted" ||
    command.context?.confirmationOrderTargetStatus !== "confirmed" ||
    command.context?.confirmationPhasePreviousStatus !== "quoted" ||
    command.context?.confirmationPhaseTargetStatus !== "active"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "confirmation must activate the v0 single phase with its Order",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "completeReservationCaptured",
    "capture and the complete phase reservation set must be valid",
  );
  requireFlag(
    lifecycle,
    command,
    "confirmationActivationAtomic",
    "Order confirmation and single-phase activation must be atomic",
  );
  requireCompleteConfirmationJobLinks(
    lifecycle,
    command,
    orderId,
    phaseId,
    phaseReservationSetId,
  );
}

function requireInitialSettlementCaptureActivation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const paymentRole = command.context?.paymentRole;
  if (paymentRole === "balance") {
    if (command.context?.balancePaymentRole !== "balance") {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "balance capture requires a persisted balance Payment role",
      );
    }
    return;
  }
  if (paymentRole !== "full" && paymentRole !== "deposit") {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "settlement capture requires a persisted full, deposit, or balance role",
    );
  }
  const paymentId = command.context?.paymentId;
  const orderId = command.context?.orderId;
  if (
    command.context?.initialPaymentRole !== paymentRole ||
    typeof paymentId !== "string" ||
    paymentId.trim().length === 0 ||
    command.context?.initialPaymentId !== paymentId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.initialPaymentOrderId !== orderId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "initial capture must match the exact initial Payment and Order",
    );
  }
  requireAtomicConfirmationActivation(lifecycle, command);
  requireFlag(
    lifecycle,
    command,
    "initialCaptureConfirmationAtomic",
    "initial capture, Order confirmation, and phase activation must be atomic",
  );
}

function expectedOrderCancellationPhaseDisposition(orderStatus: string):
  | {
      readonly previous:
        | "active"
        | "in_production"
        | "qc_passed"
        | "shipped"
        | "recovery_pending";
      readonly target: "cancelled" | "cancelled_refunded";
    }
  | undefined {
  if (orderStatus === "confirmed") {
    return { previous: "active", target: "cancelled" };
  }
  if (orderStatus === "in_production") {
    return { previous: "in_production", target: "cancelled" };
  }
  if (
    orderStatus === "qc_passed" ||
    orderStatus === "awaiting_balance" ||
    orderStatus === "ready_to_ship"
  ) {
    return { previous: "qc_passed", target: "cancelled" };
  }
  if (orderStatus === "shipped") {
    return { previous: "shipped", target: "cancelled_refunded" };
  }
  if (orderStatus === "recovery_pending") {
    return { previous: "recovery_pending", target: "cancelled_refunded" };
  }
  return undefined;
}

function requireAtomicOrderPhaseCancellation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const expectedPhaseDisposition = expectedOrderCancellationPhaseDisposition(
    command.current,
  );
  if (expectedPhaseDisposition === undefined) {
    return;
  }
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.phaseCancellationOrderId !== orderId ||
    command.context?.phaseCancellationPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.phaseCancellationPhaseId !== phaseId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "cancellation must bind the exact Order and its single phase",
    );
  }
  if (
    command.context?.phaseKind !== "single" ||
    command.context?.phaseCancellationOrderPreviousStatus !== command.current ||
    command.context?.phaseCancellationOrderTargetStatus !== "cancelled" ||
    command.context?.phaseCancellationPhasePreviousStatus !==
      expectedPhaseDisposition.previous ||
    command.context?.phaseCancellationPhaseTargetStatus !==
      expectedPhaseDisposition.target
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "parent cancellation must persist the matching phase cancellation result",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "phaseCancellationCompleted",
    "parent cancellation requires the phase cancellation result",
  );
  requireFlag(
    lifecycle,
    command,
    "phaseCancellationAtomic",
    "phase cancellation and parent Order cancellation must be atomic",
  );
  if (expectedPhaseDisposition.target === "cancelled_refunded") {
    requireZeroBalances(lifecycle, command);
  }
}

function requireAtomicOrderPhaseCompletion<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.orderCompletionOrderId !== orderId ||
    command.context?.orderCompletionPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.orderCompletionPhaseId !== phaseId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "completion must bind the exact Order and its single phase",
    );
  }
  if (
    command.context?.phaseKind !== "single" ||
    command.context?.orderCompletionOrderPreviousStatus !== "delivered" ||
    command.context?.orderCompletionOrderTargetStatus !== "completed" ||
    command.context?.orderCompletionPhasePreviousStatus !== "delivered" ||
    command.context?.orderCompletionPhaseTargetStatus !== "completed"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "terminal Order completion requires its matching phase completion result",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "phaseCompletionCompleted",
    "terminal Order completion requires the phase completion result",
  );
  requireFlag(
    lifecycle,
    command,
    "orderPhaseCompletionAtomic",
    "phase completion and parent Order completion must be atomic",
  );
}

function requireAtomicOrderPhaseProductionStart<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.productionStartOrderId !== orderId ||
    command.context?.productionStartPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.productionStartPhaseId !== phaseId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "production start must bind the exact Order and its single phase",
    );
  }
  if (
    command.context?.phaseKind !== "single" ||
    command.context?.productionStartOrderPreviousStatus !== "confirmed" ||
    command.context?.productionStartOrderTargetStatus !== "in_production" ||
    command.context?.productionStartPhasePreviousStatus !== "active" ||
    command.context?.productionStartPhaseTargetStatus !== "in_production"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "production start must persist the matching Order and phase status pair",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "productionStartCompleted",
    "production start requires both aggregate results",
  );
  requireFlag(
    lifecycle,
    command,
    "productionStartAtomic",
    "Order and phase production start must be atomic",
  );
}

const qcReadyJobStatuses = new Set([
  "qc_approved",
  "packed",
  "handed_over",
  "settled",
]);

function requireCompleteQcSlotSet<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  orderId: string,
  phaseId: string,
): void {
  const expectedIdsValue = command.context?.expectedQcFulfilmentSlotIds;
  const slotsValue = command.context?.qcFulfilmentSlots;
  const expectedIds = Array.isArray(expectedIdsValue)
    ? [...expectedIdsValue]
    : undefined;
  const slots = Array.isArray(slotsValue) ? [...slotsValue] : undefined;
  if (
    command.context?.qcSlotSetOrderId !== orderId ||
    command.context?.qcSlotSetPhaseId !== phaseId ||
    expectedIds === undefined ||
    expectedIds.length === 0 ||
    expectedIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedIds).size !== expectedIds.length ||
    slots === undefined ||
    slots.length !== expectedIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC completion requires the authoritative complete fulfilment slot set",
    );
  }
  const authoritativeIds = expectedIds as string[];
  const projectedIds = new Set<string>();
  for (const value of slots) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "QC readiness requires exact slot and current Job records",
      );
    }
    const slot = value as Readonly<Record<string, unknown>>;
    const id = slot.id;
    const currentJobId = slot.currentJobId;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      projectedIds.has(id) ||
      !authoritativeIds.includes(id) ||
      slot.orderId !== orderId ||
      slot.phaseId !== phaseId ||
      typeof currentJobId !== "string" ||
      currentJobId.trim().length === 0 ||
      slot.currentJobOrderId !== orderId ||
      slot.currentJobPhaseId !== phaseId ||
      slot.currentJobSlotId !== id ||
      slot.currentJobLineageLeaf !== true ||
      !qcReadyJobStatuses.has(slot.currentJobStatus as string) ||
      slot.openReplacementRequestId !== null ||
      slot.recoveryBlocked !== false
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "every exact fulfilment slot must have one QC-ready current Job leaf and no open replacement",
      );
    }
    projectedIds.add(id);
  }
  if (authoritativeIds.some((id) => !projectedIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC readiness cannot omit a required fulfilment slot",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "qcSlotSetComplete",
    "QC completion requires the complete locked fulfilment slot set",
  );
}

function requireAtomicOrderPhaseQcCompletion<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const previousStatus = command.current;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.qcCompletionOrderId !== orderId ||
    command.context?.qcCompletionPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.qcCompletionPhaseId !== phaseId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC completion must bind the exact Order and its single phase",
    );
  }
  if (
    (previousStatus !== "in_production" &&
      previousStatus !== "recovery_pending") ||
    command.context?.phaseKind !== "single" ||
    command.context?.qcCompletionOrderPreviousStatus !== previousStatus ||
    command.context?.qcCompletionOrderTargetStatus !== "qc_passed" ||
    command.context?.qcCompletionPhasePreviousStatus !== previousStatus ||
    command.context?.qcCompletionPhaseTargetStatus !== "qc_passed"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC completion must persist the matching Order and phase status pair",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "verifiedQcReadiness",
    "QC completion requires the complete projected slot readiness result",
  );
  requireCompleteQcSlotSet(lifecycle, command, orderId, phaseId);
  requireFlag(
    lifecycle,
    command,
    "qcCompletionCompleted",
    "QC completion requires both aggregate results",
  );
  requireFlag(
    lifecycle,
    command,
    "qcCompletionAtomic",
    "Order and phase QC completion must be atomic",
  );
}

type OrderTerminalPhaseDisposition = Readonly<{
  phasePrevious: "shipped" | "recovery_pending" | "qc_passed" | "cancelled";
  phaseIntermediate?: "cancelled";
  phaseTarget:
    "partially_fulfilled" | "cancelled_refunded" | "cancelled_settled";
}>;

function expectedOrderTerminalPhaseDisposition(
  orderPrevious: string,
  orderTarget: string,
): OrderTerminalPhaseDisposition | undefined {
  if (orderTarget === "partially_fulfilled") {
    if (orderPrevious === "shipped") {
      return { phasePrevious: "shipped", phaseTarget: "partially_fulfilled" };
    }
    if (orderPrevious === "recovery_pending") {
      return {
        phasePrevious: "recovery_pending",
        phaseTarget: "partially_fulfilled",
      };
    }
  }
  if (orderPrevious === "cancelled" && orderTarget === "refunded") {
    return {
      phasePrevious: "cancelled",
      phaseTarget: "cancelled_refunded",
    };
  }
  if (orderPrevious === "cancelled" && orderTarget === "cancelled_settled") {
    return {
      phasePrevious: "cancelled",
      phaseTarget: "cancelled_settled",
    };
  }
  if (
    orderPrevious === "awaiting_balance" &&
    orderTarget === "cancelled_settled"
  ) {
    return {
      phasePrevious: "qc_passed",
      phaseIntermediate: "cancelled",
      phaseTarget: "cancelled_settled",
    };
  }
  return undefined;
}

function requireAtomicOrderTerminalPhaseDisposition<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const expected = expectedOrderTerminalPhaseDisposition(
    command.current,
    command.target,
  );
  if (expected === undefined) {
    return;
  }
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const actualPhasePrevious = command.context?.orderTerminalPhasePreviousStatus;
  const phaseAlreadyTerminal = actualPhasePrevious === expected.phaseTarget;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.orderTerminalPhaseOrderId !== orderId ||
    command.context?.orderTerminalPhaseOwnerOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.orderTerminalPhaseId !== phaseId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "terminal disposition must bind the exact Order and its single phase",
    );
  }
  if (
    command.context?.phaseKind !== "single" ||
    command.context?.orderTerminalPhaseOrderPreviousStatus !==
      command.current ||
    command.context?.orderTerminalPhaseOrderTargetStatus !== command.target ||
    (actualPhasePrevious !== expected.phasePrevious && !phaseAlreadyTerminal) ||
    command.context?.orderTerminalPhaseTargetStatus !== expected.phaseTarget ||
    command.context?.orderTerminalPhaseIntermediateStatus !==
      (phaseAlreadyTerminal ? undefined : expected.phaseIntermediate)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "terminal Order outcome requires the exact matching phase disposition",
    );
  }
  if (expected.phaseIntermediate !== undefined) {
    if (!phaseAlreadyTerminal) {
      requireFlag(
        lifecycle,
        command,
        "orderTerminalPhaseCancellationCompleted",
        "direct balance settlement must complete phase cancellation first",
      );
    }
    requireFlag(
      lifecycle,
      command,
      "preHandoffShipmentCancellationsCompleted",
      "direct balance settlement must complete pre-handoff shipment cancellation",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "orderTerminalPhaseCompleted",
    "terminal Order outcome requires its terminal phase result",
  );
  requireFlag(
    lifecycle,
    command,
    phaseAlreadyTerminal
      ? "orderTerminalPhaseCommittedBeforeOrder"
      : "orderTerminalPhaseAtomic",
    phaseAlreadyTerminal
      ? "the terminal phase result must be committed before its parent Order outcome"
      : "terminal phase disposition and parent Order outcome must be atomic",
  );
}

function requireAllShipmentLineageLeavesDelivered<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const expectedIdsValue = command.context?.expectedShipmentLineageLeafIds;
  const leavesValue = command.context?.shipmentLineageLeaves;
  const expectedIds = Array.isArray(expectedIdsValue)
    ? [...expectedIdsValue]
    : undefined;
  const leaves = Array.isArray(leavesValue) ? [...leavesValue] : undefined;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.shipmentLineageSetOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.shipmentLineageSetPhaseId !== phaseId ||
    command.context?.phaseKind !== "single" ||
    expectedIds === undefined ||
    expectedIds.length === 0 ||
    expectedIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedIds).size !== expectedIds.length ||
    leaves === undefined ||
    leaves.length !== expectedIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "delivery requires the authoritative complete shipment lineage leaf set",
    );
  }
  const authoritativeIds = expectedIds as string[];
  const projectedIds = new Set<string>();
  for (const value of leaves) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "delivery projection requires exact shipment lineage leaf records",
      );
    }
    const leaf = value as Readonly<Record<string, unknown>>;
    const id = leaf.id;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      projectedIds.has(id) ||
      !authoritativeIds.includes(id) ||
      leaf.orderId !== orderId ||
      leaf.phaseId !== phaseId ||
      leaf.status !== "delivered"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "every exact current shipment lineage leaf must be delivered once",
      );
    }
    projectedIds.add(id);
  }
  if (authoritativeIds.some((id) => !projectedIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "delivery projection cannot omit a current shipment lineage leaf",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "shipmentLineageLeafSetComplete",
    "delivery requires the complete locked shipment lineage leaf set",
  );
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

function requireAcceptedQuoteOrderCreation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const quoteRequestId = command.context?.quoteRequestId;
  const issuedQuoteId = command.context?.issuedQuoteId;
  const orderId = command.context?.orderId;
  if (
    typeof quoteRequestId !== "string" ||
    quoteRequestId.trim().length === 0 ||
    command.context?.issuedQuoteRequestId !== quoteRequestId ||
    command.context?.createdOrderQuoteRequestId !== quoteRequestId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "accepted quote Order must belong to this exact QuoteRequest",
    );
  }
  if (
    typeof issuedQuoteId !== "string" ||
    issuedQuoteId.trim().length === 0 ||
    command.context?.createdOrderSourceQuoteId !== issuedQuoteId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "accepted quote Order must reference the exact issued Quote",
    );
  }
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.acceptedOrderId !== orderId ||
    command.context?.createdOrderStatus !== "draft"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "quote acceptance must create its exact draft Order",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "orderCreated",
    "quote acceptance requires its Order creation result",
  );
  requireFlag(
    lifecycle,
    command,
    "quoteAcceptanceOrderCreationAtomic",
    "Order creation and QuoteRequest acceptance must be atomic",
  );
}

function requireQuoteExpirationReached<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const quoteRequestId = command.context?.quoteRequestId;
  const issuedQuoteId = command.context?.issuedQuoteId;
  const expiresAt = command.context?.issuedQuoteExpiresAt;
  const evaluatedAt = command.context?.quoteExpirationEvaluatedAt;
  if (
    typeof quoteRequestId !== "string" ||
    quoteRequestId.trim().length === 0 ||
    command.context?.issuedQuoteRequestId !== quoteRequestId ||
    command.context?.quoteExpirationQuoteRequestId !== quoteRequestId ||
    typeof issuedQuoteId !== "string" ||
    issuedQuoteId.trim().length === 0 ||
    command.context?.quoteExpirationIssuedQuoteId !== issuedQuoteId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "quote expiration must bind the exact QuoteRequest and issued Quote",
    );
  }
  if (
    !(expiresAt instanceof Instant) ||
    !(evaluatedAt instanceof Instant) ||
    evaluatedAt.compare(expiresAt) < 0
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "quote expiration requires injected time at or after the immutable deadline",
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
      requireAcceptedQuoteOrderCreation("QuoteRequest", command);
    }
    if (command.current === "quoted" && command.target === "expired") {
      requireQuoteExpirationReached("QuoteRequest", command);
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

function requireRoleSpecificPaymentVoidClosure<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const paymentId = command.context?.paymentId;
  const paymentRole = command.context?.paymentRole;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const providerTransactionId = command.context?.providerPaymentTransactionId;
  if (
    typeof paymentId !== "string" ||
    paymentId.trim().length === 0 ||
    command.context?.paymentVoidPaymentId !== paymentId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    typeof providerTransactionId !== "string" ||
    providerTransactionId.trim().length === 0 ||
    command.context?.paymentVoidProviderTransactionId !==
      providerTransactionId ||
    command.context?.providerVoidOutboxPaymentId !== paymentId ||
    command.context?.providerVoidOutboxProviderTransactionId !==
      providerTransactionId ||
    command.context?.paymentVoidPreviousStatus !== "pending" ||
    command.context?.paymentVoidTargetStatus !== "voided"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "voiding must bind the exact Payment, provider intent, Order, and phase",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "captureAuthorizationDisabled",
    "voiding requires capture authorization to be disabled",
  );
  requireFlag(
    lifecycle,
    command,
    "captureWindowClosed",
    "voiding requires the capture window to be closed",
  );
  requireFlag(
    lifecycle,
    command,
    "captureCutoffSet",
    "voiding requires the capture cutoff to be recorded",
  );
  requireFlag(
    lifecycle,
    command,
    "providerVoidOutboxCreated",
    "voiding requires the exact provider void command to be persisted",
  );

  if (paymentRole === "full" || paymentRole === "deposit") {
    const phaseReservationSetId = command.context?.phaseReservationSetId;
    const orderTarget = command.context?.initialCaptureCloseOrderTargetStatus;
    const expectedReason =
      orderTarget === "expired" ? "checkout_expired" : "checkout_cancelled";
    if (
      command.context?.initialPaymentRole !== paymentRole ||
      command.context?.initialPaymentId !== paymentId ||
      command.context?.initialPaymentOrderId !== orderId ||
      command.context?.initialCaptureClosePaymentId !== paymentId ||
      command.context?.initialCaptureCloseOrderId !== orderId ||
      command.context?.initialCaptureClosePhaseId !== phaseId ||
      command.context?.initialCaptureClosePhaseOrderId !== orderId ||
      command.context?.phaseKind !== "single" ||
      typeof phaseReservationSetId !== "string" ||
      phaseReservationSetId.trim().length === 0 ||
      command.context?.initialCaptureCloseReservationSetId !==
        phaseReservationSetId ||
      command.context?.initialCaptureCloseReservationSetOrderId !== orderId ||
      command.context?.initialCaptureCloseReservationSetPhaseId !== phaseId ||
      command.context?.initialPaymentStatus !== "voided" ||
      command.context?.initialCaptureCloseOrderPreviousStatus !== "quoted" ||
      (orderTarget !== "expired" && orderTarget !== "cancelled") ||
      command.context?.initialCaptureClosePhasePreviousStatus !== "quoted" ||
      command.context?.initialCaptureClosePhaseTargetStatus !== "cancelled" ||
      command.context?.initialCaptureCloseReason !== expectedReason
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "initial Payment voiding requires its exact checkout closure result",
      );
    }
    for (const [flag, reason] of [
      [
        "initialCaptureWindowClosed",
        "initial Payment voiding requires its capture window closure",
      ],
      [
        "initialCaptureCutoffSet",
        "initial Payment voiding requires its immutable cutoff",
      ],
      [
        "initialPaymentVoidOutboxCreated",
        "initial Payment voiding requires its provider void outbox",
      ],
      [
        "preCapturePhaseCancelled",
        "initial Payment voiding requires its phase cancellation",
      ],
      [
        "preCaptureFulfilmentSlotsCancelled",
        "initial Payment voiding requires its slot cancellation",
      ],
      [
        "preCaptureReservationsReleased",
        "initial Payment voiding requires its reservation release",
      ],
      [
        "initialCaptureCloseAtomic",
        "initial Payment voiding and checkout closure must be atomic",
      ],
    ] as const) {
      requireFlag(lifecycle, command, flag, reason);
    }
    return;
  }

  if (paymentRole === "balance") {
    const orderSettlementId = command.context?.orderSettlementId;
    if (
      command.context?.balancePaymentRole !== "balance" ||
      command.context?.balancePaymentId !== paymentId ||
      command.context?.balancePaymentOrderId !== orderId ||
      command.context?.balancePaymentPhaseId !== phaseId ||
      command.context?.balancePaymentPhaseOrderId !== orderId ||
      command.context?.phaseKind !== "single" ||
      command.context?.balancePaymentVoidOrderPreviousStatus !==
        "awaiting_balance" ||
      command.context?.balancePaymentVoidOrderTargetStatus !==
        "cancelled_settled" ||
      command.context?.balancePaymentVoidPhasePreviousStatus !== "qc_passed" ||
      command.context?.balancePaymentVoidPhaseIntermediateStatus !==
        "cancelled" ||
      command.context?.balancePaymentVoidPhaseTargetStatus !==
        "cancelled_settled" ||
      command.context?.balancePaymentSettlementPaymentId !== paymentId ||
      command.context?.balancePaymentSettlementOrderId !== orderId ||
      typeof orderSettlementId !== "string" ||
      orderSettlementId.trim().length === 0 ||
      command.context?.balancePaymentSettlementId !== orderSettlementId ||
      command.context?.balancePaymentSettlementKind !== "balance_timeout"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "balance Payment voiding requires its exact Order settlement result",
      );
    }
    requireFlag(
      lifecycle,
      command,
      "balancePaymentSettlementCreated",
      "balance Payment voiding requires an immutable Order settlement",
    );
    requireFlag(
      lifecycle,
      command,
      "balancePaymentSettlementImmutable",
      "balance Payment voiding requires an immutable settlement result",
    );
    requireFlag(
      lifecycle,
      command,
      "preHandoffShipmentCancellationsCompleted",
      "balance Payment voiding requires pre-handoff shipment cancellation",
    );
    requireFlag(
      lifecycle,
      command,
      "balancePaymentVoidPhaseCancellationCompleted",
      "balance Payment voiding requires phase cancellation before settlement",
    );
    requireFlag(
      lifecycle,
      command,
      "balancePaymentVoidTerminalPhaseCompleted",
      "balance Payment voiding requires the terminal phase settlement result",
    );
    requireFlag(
      lifecycle,
      command,
      "balancePaymentVoidTerminalPhaseAtomic",
      "Payment voiding and terminal phase settlement must be atomic",
    );
    requireFlag(
      lifecycle,
      command,
      "balancePaymentVoidAtomic",
      "balance Payment voiding and Order settlement must be atomic",
    );
    return;
  }

  throw new TransitionGuardError(
    lifecycle,
    command.current,
    command.target,
    "voiding requires a persisted full, deposit, or balance Payment role",
  );
}

function requireExactOrdinaryRefundSetup<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const paymentId = command.context?.paymentId;
  const orderId = command.context?.orderId;
  const providerTransactionId = command.context?.providerPaymentTransactionId;
  const priceAdjustmentId = command.context?.priceAdjustmentId;
  const refundTransactionId = command.context?.refundTransactionId;
  const amountMinor = command.context?.ordinaryRefundAmountMinor;
  if (
    typeof paymentId !== "string" ||
    paymentId.trim().length === 0 ||
    command.context?.ordinaryRefundPaymentId !== paymentId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.ordinaryRefundOrderId !== orderId ||
    typeof providerTransactionId !== "string" ||
    providerTransactionId.trim().length === 0 ||
    command.context?.ordinaryRefundCaptureTransactionId !==
      providerTransactionId ||
    typeof priceAdjustmentId !== "string" ||
    priceAdjustmentId.trim().length === 0 ||
    command.context?.ordinaryRefundPriceAdjustmentId !== priceAdjustmentId ||
    command.context?.priceAdjustmentOrderId !== orderId ||
    command.context?.priceAdjustmentPaymentId !== paymentId ||
    command.context?.priceAdjustmentStatus !== "active" ||
    typeof refundTransactionId !== "string" ||
    refundTransactionId.trim().length === 0 ||
    command.context?.ordinaryRefundTransactionId !== refundTransactionId ||
    command.context?.refundTransactionPaymentId !== paymentId ||
    command.context?.refundTransactionOrderId !== orderId ||
    command.context?.refundTransactionPriceAdjustmentId !== priceAdjustmentId ||
    typeof amountMinor !== "bigint" ||
    amountMinor <= 0n ||
    command.context?.priceAdjustmentRefundAmountMinor !== amountMinor ||
    command.context?.refundTransactionAmountMinor !== amountMinor
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "ordinary refund must bind one exact Payment, capture, adjustment, transaction, and amount",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "scopedRefundTransactionCreated",
    "ordinary refund requires its exact scoped RefundTransaction",
  );
  requireFlag(
    lifecycle,
    command,
    "refundPriceAdjustmentActivated",
    "ordinary refund requires its exact active price adjustment",
  );
  requireFlag(
    lifecycle,
    command,
    "ordinaryRefundAtomic",
    "price adjustment, RefundTransaction, and Payment transition must be atomic",
  );
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
      requireInitialSettlementCaptureActivation("Payment", command);
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
      requireRoleSpecificPaymentVoidClosure("Payment", command);
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
      requireExactOrdinaryRefundSetup("Payment", command);
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
        requireExactOrdinaryRefundSetup("Payment", command);
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
    in_production: ["qc_passed", "cancelled"],
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
      requireAtomicConfirmationActivation("Order", command);
    }
    if (command.current === "confirmed" && command.target === "in_production") {
      requireAtomicOrderPhaseProductionStart("Order", command);
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
      requireAtomicOrderPhaseQcCompletion("Order", command);
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
    if (command.current === "delivered" && command.target === "completed") {
      requireAtomicOrderPhaseCompletion("Order", command);
    }
    requireAtomicOrderTerminalPhaseDisposition("Order", command);
    if (command.target === "cancelled") {
      requireFlag(
        "Order",
        command,
        "preHandoffShipmentCancellationsCompleted",
        "all pre-handoff shipment cancellations must complete before cancellation",
      );
      requireAtomicOrderPhaseCancellation("Order", command);
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
      requireZeroBalances("Order", command);
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
        requireAtomicConfirmationActivation("OrderPhase(single)", command);
      }
      if (command.current === "active" && command.target === "in_production") {
        requireAtomicOrderPhaseProductionStart("OrderPhase(single)", command);
      }
      if (
        (command.current === "in_production" ||
          command.current === "recovery_pending") &&
        command.target === "qc_passed"
      ) {
        requireAtomicOrderPhaseQcCompletion("OrderPhase(single)", command);
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
      if (command.current === "delivered" && command.target === "completed") {
        requireAtomicOrderPhaseCompletion("OrderPhase(single)", command);
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
        requireZeroBalances("OrderPhase(single)", command);
      }
      if (
        command.current === "cancelled" &&
        (command.target === "cancelled_refunded" ||
          command.target === "cancelled_settled")
      ) {
        requireProjectedFinancialTerminalTarget("OrderPhase(single)", command);
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

const terminalClaimStatuses = new Set([
  "resolved_rejected",
  "resolved_reprint",
  "resolved_reship",
  "resolved_refund",
  "resolved_mixed",
  "withdrawn",
]);

function requireDeliveredJobSettlement<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const jobId = command.context?.jobId;
  const shipmentId = command.context?.shipmentId;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const lineageLeafId = command.context?.currentJobShipmentLineageLeafId;
  const evaluatedAt = command.context?.jobSettlementEvaluatedAt;
  const expectedSlotIdsValue = command.context?.expectedJobSettlementSlotIds;
  const slotsValue = command.context?.jobSettlementSlots;
  const expectedSlotIds = Array.isArray(expectedSlotIdsValue)
    ? [...expectedSlotIdsValue]
    : undefined;
  const slots = Array.isArray(slotsValue) ? [...slotsValue] : undefined;
  if (
    typeof jobId !== "string" ||
    jobId.trim().length === 0 ||
    command.context?.jobSettlementJobId !== jobId ||
    typeof shipmentId !== "string" ||
    shipmentId.trim().length === 0 ||
    command.context?.jobSettlementShipmentId !== shipmentId ||
    command.context?.jobSettlementShipmentJobId !== jobId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.jobSettlementOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.jobSettlementPhaseId !== phaseId ||
    typeof lineageLeafId !== "string" ||
    lineageLeafId.trim().length === 0 ||
    command.context?.jobSettlementLineageLeafId !== lineageLeafId ||
    command.context?.jobSettlementLineageShipmentId !== shipmentId ||
    command.context?.jobSettlementLineageOrderId !== orderId ||
    command.context?.jobSettlementLineagePhaseId !== phaseId ||
    command.context?.jobSettlementLineageStatus !== "delivered" ||
    !(evaluatedAt instanceof Instant) ||
    expectedSlotIds === undefined ||
    expectedSlotIds.length === 0 ||
    expectedSlotIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedSlotIds).size !== expectedSlotIds.length ||
    slots === undefined ||
    slots.length !== expectedSlotIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job settlement requires its exact delivered Shipment lineage and complete slot set",
    );
  }
  const authoritativeSlotIds = expectedSlotIds as string[];
  const projectedSlotIds = new Set<string>();
  for (const value of slots) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Job settlement slots require exact claim-window records",
      );
    }
    const slot = value as Readonly<Record<string, unknown>>;
    const id = slot.id;
    const claimUntil = slot.claimUntil;
    const resolvedClaimId = slot.resolvedClaimId;
    const resolvedClaimStatus = slot.resolvedClaimStatus;
    const claimWindowElapsed =
      claimUntil instanceof Instant && evaluatedAt.compare(claimUntil) >= 0;
    const claimResolved =
      typeof resolvedClaimId === "string" &&
      resolvedClaimId.trim().length > 0 &&
      terminalClaimStatuses.has(resolvedClaimStatus as string) &&
      slot.resolvedClaimSlotId === id &&
      slot.resolvedClaimShipmentId === shipmentId &&
      slot.resolvedClaimOrderId === orderId &&
      slot.resolvedClaimPhaseId === phaseId &&
      slot.resolvedClaimPreviousActiveClaimId === resolvedClaimId &&
      slot.resolvedClaimTargetActiveClaimId === null;
    const noClaim =
      resolvedClaimId === null &&
      resolvedClaimStatus === null &&
      slot.resolvedClaimSlotId === null &&
      slot.resolvedClaimShipmentId === null &&
      slot.resolvedClaimOrderId === null &&
      slot.resolvedClaimPhaseId === null &&
      slot.resolvedClaimPreviousActiveClaimId === null &&
      slot.resolvedClaimTargetActiveClaimId === null;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      projectedSlotIds.has(id) ||
      !authoritativeSlotIds.includes(id) ||
      slot.jobId !== jobId ||
      slot.shipmentId !== shipmentId ||
      slot.orderId !== orderId ||
      slot.phaseId !== phaseId ||
      !(claimUntil instanceof Instant) ||
      (!claimWindowElapsed && !claimResolved) ||
      (!noClaim && !claimResolved) ||
      slot.activeClaimId !== null ||
      slot.claimRetentionHoldReleased !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "every Job slot must have an elapsed claim window or an exact resolved Claim with its hold released",
      );
    }
    projectedSlotIds.add(id);
  }
  if (authoritativeSlotIds.some((id) => !projectedSlotIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job settlement cannot omit an affected fulfilment slot",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "jobSettlementSlotSetComplete",
    "Job settlement requires the authoritative complete slot set",
  );
  requireFlag(
    lifecycle,
    command,
    "jobSettlementCompleted",
    "Job settlement requires its durable settlement result",
  );
  requireFlag(
    lifecycle,
    command,
    "jobSettlementAtomic",
    "Job settlement and hold release must be atomic",
  );
}

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
      requireAtomicOrdinaryHandoff("Job", command);
    }
    if (command.current === "handed_over" && command.target === "settled") {
      requireDeliveredJobSettlement("Job", command);
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

function requireAtomicShipmentIncidentRouting<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const shipmentId = command.context?.shipmentId;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  if (
    typeof shipmentId !== "string" ||
    shipmentId.trim().length === 0 ||
    command.context?.incidentShipmentId !== shipmentId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.incidentOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.incidentPhaseId !== phaseId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "shipment incident routing must bind the exact Shipment, Order, and phase",
    );
  }
  const shipmentSlotIdsValue = command.context?.shipmentFulfilmentSlotIds;
  const affectedSlotIdsValue = command.context?.incidentAffectedSlotIds;
  const ownershipsValue = command.context?.shipmentIncidentSlotOwnerships;
  const routesValue = command.context?.shipmentIncidentSlotRoutes;
  const shipmentSlotIds = Array.isArray(shipmentSlotIdsValue)
    ? [...shipmentSlotIdsValue]
    : undefined;
  const affectedSlotIds = Array.isArray(affectedSlotIdsValue)
    ? [...affectedSlotIdsValue]
    : undefined;
  const ownerships = Array.isArray(ownershipsValue)
    ? [...ownershipsValue]
    : undefined;
  const routes = Array.isArray(routesValue) ? [...routesValue] : undefined;
  if (
    shipmentSlotIds === undefined ||
    shipmentSlotIds.length === 0 ||
    shipmentSlotIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(shipmentSlotIds).size !== shipmentSlotIds.length ||
    affectedSlotIds === undefined ||
    affectedSlotIds.length !== shipmentSlotIds.length ||
    affectedSlotIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(affectedSlotIds).size !== affectedSlotIds.length ||
    ownerships === undefined ||
    ownerships.length !== shipmentSlotIds.length ||
    routes === undefined ||
    routes.length !== shipmentSlotIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "shipment incident routing requires the complete affected slot set",
    );
  }
  const authoritativeSlotIds = shipmentSlotIds as string[];
  const affectedIds = affectedSlotIds as string[];
  if (
    authoritativeSlotIds.some((id) => !affectedIds.includes(id)) ||
    affectedIds.some((id) => !authoritativeSlotIds.includes(id))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "shipment incident affected slots must exactly match Shipment ownership",
    );
  }
  const activeClaimBySlotId = new Map<string, string | null>();
  for (const value of ownerships) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "shipment incident ownership must identify every affected slot",
      );
    }
    const ownership = value as Readonly<Record<string, unknown>>;
    const slotId = ownership.slotId;
    const activeClaimId = ownership.activeClaimId;
    if (
      typeof slotId !== "string" ||
      !affectedIds.includes(slotId) ||
      activeClaimBySlotId.has(slotId) ||
      (activeClaimId !== null &&
        (typeof activeClaimId !== "string" ||
          activeClaimId.trim().length === 0))
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "shipment incident ownership must be a complete unique slot partition",
      );
    }
    activeClaimBySlotId.set(slotId, activeClaimId as string | null);
  }
  if (affectedIds.some((id) => !activeClaimBySlotId.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "shipment incident ownership cannot omit an affected slot",
    );
  }

  const originClaimIdValue = command.context?.shipmentOriginClaimId;
  const originClaimId =
    typeof originClaimIdValue === "string" &&
    originClaimIdValue.trim().length > 0
      ? originClaimIdValue
      : undefined;
  if (originClaimIdValue !== null && originClaimId === undefined) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Shipment origin Claim identity must be nonblank or null",
    );
  }
  const newClaimValue = command.context?.shipmentIncidentNewClaim;
  const newClaim =
    typeof newClaimValue === "object" &&
    newClaimValue !== null &&
    !Array.isArray(newClaimValue)
      ? (newClaimValue as Readonly<Record<string, unknown>>)
      : undefined;
  const newClaimId = newClaim?.id;
  const routedSlotIds = new Set<string>();
  const incidentRecordIds = new Set<string>();
  const childResolutionIds = new Set<string>();
  let unownedSlotCount = 0;
  for (const value of routes) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "shipment incident slot routes must be complete identity records",
      );
    }
    const route = value as Readonly<Record<string, unknown>>;
    const slotId = route.slotId;
    const ownerClaimId = route.ownerClaimId;
    const routedClaimId = route.routedClaimId;
    const incidentRecordId = route.incidentRecordId;
    const childResolutionId = route.childResolutionId;
    if (
      typeof slotId !== "string" ||
      !affectedIds.includes(slotId) ||
      routedSlotIds.has(slotId) ||
      ownerClaimId !== activeClaimBySlotId.get(slotId) ||
      (ownerClaimId !== null &&
        (typeof ownerClaimId !== "string" ||
          ownerClaimId.trim().length === 0)) ||
      typeof routedClaimId !== "string" ||
      routedClaimId.trim().length === 0 ||
      typeof incidentRecordId !== "string" ||
      incidentRecordId.trim().length === 0 ||
      incidentRecordIds.has(incidentRecordId) ||
      route.incidentRecordShipmentId !== shipmentId ||
      route.incidentRecordClaimId !== routedClaimId ||
      route.incidentRecordSlotId !== slotId ||
      typeof childResolutionId !== "string" ||
      childResolutionId.trim().length === 0 ||
      childResolutionIds.has(childResolutionId) ||
      route.childResolutionClaimId !== routedClaimId ||
      route.childResolutionSlotId !== slotId ||
      route.childResolutionShipmentId !== shipmentId ||
      route.childResolutionStatus !== "recovery_pending" ||
      route.claimStatus !== "active" ||
      route.claimRetentionHoldActive !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "shipment incident must route every slot to an active retained Claim",
      );
    }
    if (originClaimId !== undefined) {
      if (
        (ownerClaimId !== null && ownerClaimId !== originClaimId) ||
        routedClaimId !== originClaimId ||
        route.createdNewClaim !== false
      ) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          "origin-Claim Shipment incidents must remain on the exact parent Claim",
        );
      }
    } else if (ownerClaimId === null) {
      unownedSlotCount += 1;
      if (routedClaimId !== newClaimId || route.createdNewClaim !== true) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          "unowned incident slots must share the one new incident Claim",
        );
      }
    } else if (
      routedClaimId !== ownerClaimId ||
      route.createdNewClaim !== false
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "owned incident slots must remain with their existing Claim",
      );
    }
    routedSlotIds.add(slotId);
    incidentRecordIds.add(incidentRecordId);
    childResolutionIds.add(childResolutionId);
  }
  if (affectedIds.some((id) => !routedSlotIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "shipment incident routing cannot omit an affected slot",
    );
  }
  if (originClaimId !== undefined || unownedSlotCount === 0) {
    if (newClaimValue !== null) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "incident routing must not create an unnecessary Claim",
      );
    }
  } else if (
    typeof newClaimId !== "string" ||
    newClaimId.trim().length === 0 ||
    newClaim?.origin !== "shipment_incident" ||
    newClaim.shipmentId !== shipmentId ||
    newClaim.orderId !== orderId ||
    newClaim.phaseId !== phaseId ||
    newClaim.status !== "active" ||
    newClaim.retentionHoldActive !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "unowned slots require one exact active incident-backed Claim",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "shipmentIncidentRouted",
    "lost or returned Shipment requires its complete incident route",
  );
  requireFlag(
    lifecycle,
    command,
    "shipmentIncidentRoutingAtomic",
    "Shipment outcome and incident recovery routing must be atomic",
  );
}

function requireVerifiedMatchingCancellationRaceScan<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const shipmentId = command.context?.shipmentId;
  const providerTransactionId = command.context?.shipmentProviderTransactionId;
  const providerEventId = command.context?.providerEventId;
  if (
    typeof shipmentId !== "string" ||
    shipmentId.trim().length === 0 ||
    command.context?.providerEventShipmentId !== shipmentId ||
    typeof providerTransactionId !== "string" ||
    providerTransactionId.trim().length === 0 ||
    command.context?.providerEventTransactionId !== providerTransactionId ||
    typeof providerEventId !== "string" ||
    providerEventId.trim().length === 0 ||
    command.context?.shipmentProviderScanEventId !== providerEventId ||
    command.context?.providerEventKind !== "acceptance_scan" ||
    command.context?.providerEventStatus !== "handed_over"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "cancellation-race scan must identify the exact Shipment, transaction, and physical acceptance event",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "providerEventAuthenticated",
    "cancellation-race scan must be authenticated",
  );
  requireFlag(
    lifecycle,
    command,
    "providerEventVerified",
    "cancellation-race scan must be verified",
  );
  requireFlag(
    lifecycle,
    command,
    "verifiedProviderScan",
    "the exact custody scan must be persisted and consumed",
  );
}

function requireAtomicOrdinaryHandoff<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const shipmentId = command.context?.shipmentId;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const expectedSlotIdsValue = command.context?.handoffSlotIds;
  const slotsValue = command.context?.handoffSlots;
  const expectedJobIdsValue = command.context?.handoffJobIds;
  const jobsValue = command.context?.handoffJobs;
  const expectedSlotIds = Array.isArray(expectedSlotIdsValue)
    ? [...expectedSlotIdsValue]
    : undefined;
  const slots = Array.isArray(slotsValue) ? [...slotsValue] : undefined;
  const expectedJobIds = Array.isArray(expectedJobIdsValue)
    ? [...expectedJobIdsValue]
    : undefined;
  const jobs = Array.isArray(jobsValue) ? [...jobsValue] : undefined;
  if (
    typeof shipmentId !== "string" ||
    shipmentId.trim().length === 0 ||
    command.context?.handoffShipmentId !== shipmentId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.handoffOrderId !== orderId ||
    command.context?.handoffPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.handoffPhaseId !== phaseId ||
    command.context?.handoffShipmentPreviousStatus !== "label_created" ||
    command.context?.handoffShipmentTargetStatus !== "handed_over" ||
    command.context?.handoffJobPreviousStatus !== "packed" ||
    command.context?.handoffJobTargetStatus !== "handed_over" ||
    expectedSlotIds === undefined ||
    expectedSlotIds.length === 0 ||
    expectedSlotIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedSlotIds).size !== expectedSlotIds.length ||
    slots === undefined ||
    slots.length !== expectedSlotIds.length ||
    expectedJobIds === undefined ||
    expectedJobIds.length === 0 ||
    expectedJobIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedJobIds).size !== expectedJobIds.length ||
    jobs === undefined ||
    jobs.length !== expectedJobIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "ordinary handoff requires the exact Shipment, Order, phase, slot, and Job sets",
    );
  }
  if (
    !hasSameNonEmptyStringSet(
      command.context?.shipmentFulfilmentSlotIds,
      expectedSlotIds,
    )
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "ordinary handoff slots must exactly match the Shipment slot set",
    );
  }

  const authoritativeSlotIds = expectedSlotIds as string[];
  const authoritativeJobIds = expectedJobIds as string[];
  const projectedSlotIds = new Set<string>();
  const contributingJobIds = new Set<string>();
  for (const value of slots) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "ordinary handoff slots must be complete identity records",
      );
    }
    const slot = value as Readonly<Record<string, unknown>>;
    const id = slot.id;
    const slotJobId = slot.jobId;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      projectedSlotIds.has(id) ||
      !authoritativeSlotIds.includes(id) ||
      slot.shipmentId !== shipmentId ||
      slot.orderId !== orderId ||
      slot.phaseId !== phaseId ||
      typeof slotJobId !== "string" ||
      slotJobId.trim().length === 0 ||
      !authoritativeJobIds.includes(slotJobId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "ordinary handoff must cover each exact slot once",
      );
    }
    projectedSlotIds.add(id);
    contributingJobIds.add(slotJobId);
  }
  if (authoritativeSlotIds.some((id) => !projectedSlotIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "ordinary handoff cannot omit a Shipment slot",
    );
  }
  if (
    contributingJobIds.size !== authoritativeJobIds.length ||
    authoritativeJobIds.some((id) => !contributingJobIds.has(id))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "ordinary handoff Jobs must exactly match the slot contributors",
    );
  }

  const projectedJobIds = new Set<string>();
  for (const value of jobs) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "ordinary handoff Jobs must be complete identity records",
      );
    }
    const job = value as Readonly<Record<string, unknown>>;
    const id = job.id;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      projectedJobIds.has(id) ||
      !authoritativeJobIds.includes(id) ||
      job.shipmentId !== shipmentId ||
      job.orderId !== orderId ||
      job.phaseId !== phaseId ||
      job.previousStatus !== "packed" ||
      job.targetStatus !== "handed_over"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "ordinary handoff must transition every exact contributing Job",
      );
    }
    projectedJobIds.add(id);
  }
  if (authoritativeJobIds.some((id) => !projectedJobIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "ordinary handoff cannot omit a contributing Job",
    );
  }
  if (
    lifecycle === "Job" &&
    (typeof command.context?.jobId !== "string" ||
      command.context.jobId.trim().length === 0 ||
      !authoritativeJobIds.includes(command.context.jobId))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "ordinary handoff Job evidence must include the exact current Job",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "handoffCompleted",
    "ordinary Shipment handoff requires the complete result",
  );
  requireFlag(
    lifecycle,
    command,
    "handoffAtomic",
    "ordinary Shipment and Job handoff must be atomic",
  );
}

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
    if (
      command.current === "label_created" &&
      command.target === "handed_over"
    ) {
      requireAtomicOrdinaryHandoff("Shipment", command);
    }
    if (
      command.target === "handed_over" &&
      command.current !== "label_created"
    ) {
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
      requireVerifiedMatchingCancellationRaceScan("Shipment", command);
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
      if (command.target === "lost" || command.target === "returned") {
        requireAtomicShipmentIncidentRouting("Shipment", command);
      }
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

function requireCompleteClaimResolutionSet<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): ClaimSlotResolutionStatus[] {
  const claimId = command.context?.claimId;
  const expectedIdsValue = command.context?.expectedClaimSlotResolutionIds;
  const expectedSlotIdsValue = command.context?.expectedClaimSlotIds;
  const expectedBindingsValue = command.context?.expectedClaimResolutionSlots;
  const resolutionsValue = command.context?.claimSlotResolutions;
  const expectedIds = Array.isArray(expectedIdsValue)
    ? [...expectedIdsValue]
    : undefined;
  const expectedSlotIds = Array.isArray(expectedSlotIdsValue)
    ? [...expectedSlotIdsValue]
    : undefined;
  const expectedBindings = Array.isArray(expectedBindingsValue)
    ? [...expectedBindingsValue]
    : undefined;
  const resolutions = Array.isArray(resolutionsValue)
    ? [...resolutionsValue]
    : undefined;
  if (
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    command.context?.claimResolutionSetClaimId !== claimId ||
    expectedIds === undefined ||
    expectedIds.length === 0 ||
    expectedIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedIds).size !== expectedIds.length ||
    expectedSlotIds === undefined ||
    expectedSlotIds.length !== expectedIds.length ||
    expectedSlotIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedSlotIds).size !== expectedSlotIds.length ||
    expectedBindings === undefined ||
    expectedBindings.length !== expectedIds.length ||
    resolutions === undefined ||
    resolutions.length !== expectedIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim resolution requires its complete owned child identity set",
    );
  }
  const ownedIds = expectedIds as string[];
  const ownedSlotIds = expectedSlotIds as string[];
  const expectedSlotByResolution = new Map<string, string>();
  const boundSlotIds = new Set<string>();
  for (const value of expectedBindings) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim resolution ownership requires exact resolution-to-slot bindings",
      );
    }
    const binding = value as Readonly<Record<string, unknown>>;
    const resolutionId = binding.resolutionId;
    const slotId = binding.slotId;
    if (
      typeof resolutionId !== "string" ||
      !ownedIds.includes(resolutionId) ||
      expectedSlotByResolution.has(resolutionId) ||
      typeof slotId !== "string" ||
      !ownedSlotIds.includes(slotId) ||
      boundSlotIds.has(slotId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim resolution ownership bindings must cover each exact child and slot once",
      );
    }
    expectedSlotByResolution.set(resolutionId, slotId);
    boundSlotIds.add(slotId);
  }
  if (
    ownedIds.some((id) => !expectedSlotByResolution.has(id)) ||
    ownedSlotIds.some((id) => !boundSlotIds.has(id))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim resolution ownership bindings cannot omit an owned child or slot",
    );
  }
  const projectedIds = new Set<string>();
  const projectedSlotIds = new Set<string>();
  const statuses: ClaimSlotResolutionStatus[] = [];
  for (const value of resolutions) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim child projection requires identity and status records",
      );
    }
    const resolution = value as Readonly<Record<string, unknown>>;
    const id = resolution.id;
    const slotId = resolution.slotId;
    const status = resolution.status;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      projectedIds.has(id) ||
      !ownedIds.includes(id) ||
      resolution.claimId !== claimId ||
      typeof slotId !== "string" ||
      slotId.trim().length === 0 ||
      projectedSlotIds.has(slotId) ||
      !ownedSlotIds.includes(slotId) ||
      expectedSlotByResolution.get(id) !== slotId ||
      resolution.activeClaimIdBefore !== claimId ||
      resolution.activeClaimIdAfter !== null ||
      typeof status !== "string"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim child projection must match each exact owned resolution once",
      );
    }
    projectedIds.add(id);
    projectedSlotIds.add(slotId);
    statuses.push(status as ClaimSlotResolutionStatus);
  }
  if (
    ownedIds.some((id) => !projectedIds.has(id)) ||
    ownedSlotIds.some((id) => !projectedSlotIds.has(id))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim child projection cannot omit an owned resolution or slot",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "claimResolutionSetComplete",
    "Claim terminal projection requires the authoritative complete child set",
  );
  requireFlag(
    lifecycle,
    command,
    "claimSlotOwnershipReleased",
    "terminal Claim must release every owned slot",
  );
  const previousDeleteAfter =
    command.context?.claimRetentionPreviousDeleteAfter;
  const targetDeleteAfter = command.context?.claimRetentionTargetDeleteAfter;
  if (
    command.context?.claimRetentionClaimId !== claimId ||
    command.context?.claimRetentionHoldPreviousStatus !== "active_claim" ||
    command.context?.claimRetentionHoldTargetStatus !== "released" ||
    !(previousDeleteAfter instanceof Instant) ||
    !(targetDeleteAfter instanceof Instant) ||
    targetDeleteAfter.compare(previousDeleteAfter) < 0
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "terminal Claim must release its exact retention hold and recompute a valid deadline",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "claimRetentionDeadlineRecomputed",
    "terminal Claim must recompute its retention deadline",
  );
  requireFlag(
    lifecycle,
    command,
    "claimRetentionReleased",
    "terminal Claim must release its retention hold",
  );
  requireFlag(
    lifecycle,
    command,
    "claimTerminalCleanupAtomic",
    "Claim finalization, slot release, and retention cleanup must be atomic",
  );
  return statuses;
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
      const statuses = requireCompleteClaimResolutionSet("Claim", command);
      const projected = projectClaimTerminalStatus(statuses);
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

function requireCompleteReplacementRequiredSlotSet<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const resolutionId = command.context?.claimSlotResolutionId;
  const claimId = command.context?.claimId;
  const resolutionSlotId = command.context?.claimSlotId;
  const replacementSetId = command.context?.replacementSetId;
  const expectedSlotIdsValue =
    command.context?.expectedReplacementRequiredSlotIds;
  const bindingsValue = command.context?.replacementRequiredSlotBindings;
  const expectedSlotIds = Array.isArray(expectedSlotIdsValue)
    ? [...expectedSlotIdsValue]
    : undefined;
  const bindings = Array.isArray(bindingsValue)
    ? [...bindingsValue]
    : undefined;
  if (
    typeof resolutionId !== "string" ||
    resolutionId.trim().length === 0 ||
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    typeof resolutionSlotId !== "string" ||
    resolutionSlotId.trim().length === 0 ||
    typeof replacementSetId !== "string" ||
    replacementSetId.trim().length === 0 ||
    command.context?.replacementRequiredSetClaimId !== claimId ||
    command.context?.replacementRequiredSetResolutionId !== resolutionId ||
    command.context?.replacementRequiredSetId !== replacementSetId ||
    expectedSlotIds === undefined ||
    expectedSlotIds.length === 0 ||
    !expectedSlotIds.includes(resolutionSlotId) ||
    expectedSlotIds.some(
      (slotId) => typeof slotId !== "string" || slotId.trim().length === 0,
    ) ||
    new Set(expectedSlotIds).size !== expectedSlotIds.length ||
    bindings === undefined ||
    bindings.length !== expectedSlotIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement production requires its complete exact required-slot set",
    );
  }

  const expectedSlots = expectedSlotIds as string[];
  const boundSlotIds = new Set<string>();
  const requestIds = new Set<string>();
  const reservationIds = new Set<string>();
  const shipmentIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const value of bindings) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement production requires slot-to-resource identity records",
      );
    }
    const binding = value as Readonly<Record<string, unknown>>;
    const slotId = binding.slotId;
    const requestId = binding.replacementRequestId;
    const reservationId = binding.replacementReservationId;
    const shipmentId = binding.replacementShipmentId;
    const jobId = binding.currentReplacementJobId;
    if (
      typeof slotId !== "string" ||
      slotId.trim().length === 0 ||
      boundSlotIds.has(slotId) ||
      !expectedSlots.includes(slotId) ||
      binding.claimId !== claimId ||
      binding.resolutionId !== resolutionId ||
      binding.replacementSetId !== replacementSetId ||
      typeof requestId !== "string" ||
      requestId.trim().length === 0 ||
      requestIds.has(requestId) ||
      binding.replacementRequestClaimId !== claimId ||
      binding.replacementRequestResolutionId !== resolutionId ||
      binding.replacementRequestSlotId !== slotId ||
      typeof reservationId !== "string" ||
      reservationId.trim().length === 0 ||
      reservationIds.has(reservationId) ||
      binding.replacementReservationRequestId !== requestId ||
      binding.replacementReservationSlotId !== slotId ||
      typeof shipmentId !== "string" ||
      shipmentId.trim().length === 0 ||
      shipmentIds.has(shipmentId) ||
      binding.replacementShipmentRequestId !== requestId ||
      binding.replacementShipmentReservationId !== reservationId ||
      binding.replacementShipmentSlotId !== slotId ||
      typeof jobId !== "string" ||
      jobId.trim().length === 0 ||
      jobIds.has(jobId) ||
      binding.currentReplacementJobRequestId !== requestId ||
      binding.currentReplacementJobReservationId !== reservationId ||
      binding.currentReplacementJobShipmentId !== shipmentId ||
      binding.currentReplacementJobSlotId !== slotId ||
      binding.currentReplacementJobLineageLeaf !== true ||
      binding.currentReplacementJobStatus !== "created"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "each replacement-required slot must bind this Claim child to its exact request, reservation, Shipment, and current Job leaf",
      );
    }
    boundSlotIds.add(slotId);
    requestIds.add(requestId);
    reservationIds.add(reservationId);
    shipmentIds.add(shipmentId);
    jobIds.add(jobId);
  }
  if (expectedSlots.some((slotId) => !boundSlotIds.has(slotId))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement production cannot omit a required slot binding",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "replacementRequiredSlotSetComplete",
    "replacement production requires the authoritative complete required-slot set",
  );
  requireFlag(
    lifecycle,
    command,
    "replacementSetupAtomic",
    "replacement production must persist the complete replacement setup atomically",
  );
}

function requireExactClaimRefundScope<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const paymentId = context?.paymentId;
  const priceAdjustmentId = context?.priceAdjustmentId;
  const refundTransactionId = context?.refundTransactionId;
  const allocationId = context?.claimRefundAllocationId;
  const amountMinor = context?.claimRefundAmountMinor;
  const scopeId = context?.claimRefundScopeId;
  const expectedResolutionIdsValue = context?.claimRefundScopeResolutionIds;
  const expectedSlotIdsValue = context?.claimRefundScopeSlotIds;
  const expectedBindingsValue = context?.claimRefundScopeResolutionSlots;
  const allResolutionIdsValue = context?.claimRefundScopeAllResolutionIds;
  const allSlotIdsValue = context?.claimRefundScopeAllSlotIds;
  const allBindingsValue = context?.claimRefundScopeAllResolutionSlots;
  const operationsValue = context?.claimRefundScopeChildOperations;
  const childrenValue = context?.claimRefundScopeChildren;
  const expectedResolutionIds = Array.isArray(expectedResolutionIdsValue)
    ? [...expectedResolutionIdsValue]
    : undefined;
  const expectedSlotIds = Array.isArray(expectedSlotIdsValue)
    ? [...expectedSlotIdsValue]
    : undefined;
  const expectedBindings = Array.isArray(expectedBindingsValue)
    ? [...expectedBindingsValue]
    : undefined;
  const allResolutionIds = Array.isArray(allResolutionIdsValue)
    ? [...allResolutionIdsValue]
    : undefined;
  const allSlotIds = Array.isArray(allSlotIdsValue)
    ? [...allSlotIdsValue]
    : undefined;
  const allBindings = Array.isArray(allBindingsValue)
    ? [...allBindingsValue]
    : undefined;
  const operations = Array.isArray(operationsValue)
    ? [...operationsValue]
    : undefined;
  const children = Array.isArray(childrenValue)
    ? [...childrenValue]
    : undefined;
  const validIdSet = (value: unknown[] | undefined): value is string[] =>
    value !== undefined &&
    value.length > 0 &&
    value.every((id) => typeof id === "string" && id.trim().length > 0) &&
    new Set(value).size === value.length;

  if (
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    typeof resolutionId !== "string" ||
    resolutionId.trim().length === 0 ||
    typeof slotId !== "string" ||
    slotId.trim().length === 0 ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    typeof paymentId !== "string" ||
    paymentId.trim().length === 0 ||
    typeof priceAdjustmentId !== "string" ||
    priceAdjustmentId.trim().length === 0 ||
    typeof refundTransactionId !== "string" ||
    refundTransactionId.trim().length === 0 ||
    typeof allocationId !== "string" ||
    allocationId.trim().length === 0 ||
    typeof amountMinor !== "bigint" ||
    amountMinor <= 0n ||
    typeof scopeId !== "string" ||
    scopeId.trim().length === 0 ||
    context?.claimRefundScopeClaimId !== claimId ||
    context?.claimRefundScopeOrderId !== orderId ||
    context?.claimRefundScopePhaseId !== phaseId ||
    context?.claimRefundScopePriceAdjustmentId !== priceAdjustmentId ||
    context?.claimRefundResolutionId !== resolutionId ||
    context?.claimRefundSlotId !== slotId ||
    context?.claimRefundPaymentId !== paymentId ||
    context?.claimRefundPriceAdjustmentId !== priceAdjustmentId ||
    context?.claimRefundTransactionId !== refundTransactionId ||
    context?.claimRefundExpectedAmountMinor !== amountMinor ||
    context?.claimRefundPriceAdjustmentScopeId !== scopeId ||
    context?.claimRefundPriceAdjustmentOrderId !== orderId ||
    context?.claimRefundPriceAdjustmentStatus !== "active" ||
    context?.claimRefundTransactionPaymentId !== paymentId ||
    context?.claimRefundTransactionOrderId !== orderId ||
    context?.claimRefundTransactionPriceAdjustmentId !== priceAdjustmentId ||
    context?.claimRefundTransactionAmountMinor !== amountMinor ||
    !validIdSet(expectedResolutionIds) ||
    !validIdSet(expectedSlotIds) ||
    expectedBindings === undefined ||
    expectedBindings.length !== expectedResolutionIds.length ||
    !validIdSet(allResolutionIds) ||
    !validIdSet(allSlotIds) ||
    allBindings === undefined ||
    allBindings.length !== allResolutionIds.length ||
    operations === undefined ||
    operations.length !== expectedResolutionIds.length ||
    expectedResolutionIds.length !== expectedSlotIds.length ||
    allResolutionIds.length !== allSlotIds.length ||
    allResolutionIds.length !== children?.length ||
    !allResolutionIds.includes(resolutionId) ||
    !expectedResolutionIds.includes(resolutionId) ||
    context?.claimRefundScopeComplete !== true ||
    context?.claimRefundScopeAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "claim refund requires its exact complete authoritative child scope",
    );
  }

  const targetResolutionIds = new Set(expectedResolutionIds);
  const targetSlotIds = new Set(expectedSlotIds);
  const expectedSlotByResolution = new Map<string, string>();
  const expectedBoundSlotIds = new Set<string>();
  for (const value of expectedBindings) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund scope requires exact resolution-to-slot allocation bindings",
      );
    }
    const binding = value as Readonly<Record<string, unknown>>;
    const bindingResolutionId = binding.resolutionId;
    const bindingSlotId = binding.slotId;
    if (
      typeof bindingResolutionId !== "string" ||
      !targetResolutionIds.has(bindingResolutionId) ||
      expectedSlotByResolution.has(bindingResolutionId) ||
      typeof bindingSlotId !== "string" ||
      !targetSlotIds.has(bindingSlotId) ||
      expectedBoundSlotIds.has(bindingSlotId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund scope allocations must bind each target child and slot once",
      );
    }
    expectedSlotByResolution.set(bindingResolutionId, bindingSlotId);
    expectedBoundSlotIds.add(bindingSlotId);
  }
  if (
    expectedResolutionIds.some((id) => !expectedSlotByResolution.has(id)) ||
    expectedSlotIds.some((id) => !expectedBoundSlotIds.has(id))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "claim refund scope allocations cannot omit a target child or slot",
    );
  }

  const authoritativeSlotByResolution = new Map<string, string>();
  const authoritativeBoundSlotIds = new Set<string>();
  for (const value of allBindings) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund scope requires exact authoritative child-to-slot bindings",
      );
    }
    const binding = value as Readonly<Record<string, unknown>>;
    const bindingResolutionId = binding.resolutionId;
    const bindingSlotId = binding.slotId;
    if (
      typeof bindingResolutionId !== "string" ||
      !allResolutionIds.includes(bindingResolutionId) ||
      authoritativeSlotByResolution.has(bindingResolutionId) ||
      typeof bindingSlotId !== "string" ||
      !allSlotIds.includes(bindingSlotId) ||
      authoritativeBoundSlotIds.has(bindingSlotId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund authoritative child slots must form a complete bijection",
      );
    }
    authoritativeSlotByResolution.set(bindingResolutionId, bindingSlotId);
    authoritativeBoundSlotIds.add(bindingSlotId);
  }
  if (
    allResolutionIds.some((id) => !authoritativeSlotByResolution.has(id)) ||
    allSlotIds.some((id) => !authoritativeBoundSlotIds.has(id)) ||
    expectedResolutionIds.some(
      (id) =>
        authoritativeSlotByResolution.get(id) !==
        expectedSlotByResolution.get(id),
    )
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "claim refund authoritative child slots cannot omit or remap a child",
    );
  }

  const operationByResolution = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const operationSlotIds = new Set<string>();
  const operationAllocationIds = new Set<string>();
  const operationRefundTransactionIds = new Set<string>();
  for (const value of operations) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund scope requires exact per-child financial operations",
      );
    }
    const operation = value as Readonly<Record<string, unknown>>;
    const operationResolutionId = operation.resolutionId;
    const operationSlotId = operation.slotId;
    const operationPaymentId = operation.paymentId;
    const operationAllocationId = operation.allocationId;
    const operationRefundTransactionId = operation.refundTransactionId;
    const operationAmountMinor = operation.amountMinor;
    if (
      typeof operationResolutionId !== "string" ||
      !targetResolutionIds.has(operationResolutionId) ||
      operationByResolution.has(operationResolutionId) ||
      typeof operationSlotId !== "string" ||
      expectedSlotByResolution.get(operationResolutionId) !== operationSlotId ||
      operationSlotIds.has(operationSlotId) ||
      typeof operationPaymentId !== "string" ||
      operationPaymentId.trim().length === 0 ||
      operation.priceAdjustmentId !== priceAdjustmentId ||
      typeof operationAllocationId !== "string" ||
      operationAllocationId.trim().length === 0 ||
      operationAllocationIds.has(operationAllocationId) ||
      typeof operationRefundTransactionId !== "string" ||
      operationRefundTransactionId.trim().length === 0 ||
      operationRefundTransactionIds.has(operationRefundTransactionId) ||
      typeof operationAmountMinor !== "bigint" ||
      operationAmountMinor <= 0n
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund child operations must form an exact financial-operation bijection",
      );
    }
    operationByResolution.set(operationResolutionId, operation);
    operationSlotIds.add(operationSlotId);
    operationAllocationIds.add(operationAllocationId);
    operationRefundTransactionIds.add(operationRefundTransactionId);
  }
  if (
    expectedResolutionIds.some((id) => !operationByResolution.has(id)) ||
    expectedSlotIds.some((id) => !operationSlotIds.has(id))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "claim refund child operations cannot omit a target child or slot",
    );
  }

  const projectedResolutionIds = new Set<string>();
  const projectedSlotIds = new Set<string>();
  const projectedRefundTransactionIds = new Set<string>();
  let scopeAmountMinor = 0n;
  let includedCount = 0;
  for (const value of children) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund scope requires exact child records",
      );
    }
    const child = value as Readonly<Record<string, unknown>>;
    const childResolutionId = child.resolutionId;
    const childSlotId = child.slotId;
    const includedInRefund = child.includedInRefund;
    const statusBefore = child.statusBefore;
    const statusAfter = child.statusAfter;
    if (
      typeof childResolutionId !== "string" ||
      childResolutionId.trim().length === 0 ||
      projectedResolutionIds.has(childResolutionId) ||
      !allResolutionIds.includes(childResolutionId) ||
      typeof childSlotId !== "string" ||
      childSlotId.trim().length === 0 ||
      projectedSlotIds.has(childSlotId) ||
      !allSlotIds.includes(childSlotId) ||
      child.claimId !== claimId ||
      child.orderId !== orderId ||
      child.phaseId !== phaseId ||
      authoritativeSlotByResolution.get(childResolutionId as string) !==
        childSlotId ||
      (includedInRefund &&
        expectedSlotByResolution.get(childResolutionId) !== childSlotId) ||
      typeof includedInRefund !== "boolean" ||
      typeof statusBefore !== "string" ||
      typeof statusAfter !== "string" ||
      (includedInRefund
        ? !targetResolutionIds.has(childResolutionId) ||
          !targetSlotIds.has(childSlotId) ||
          statusAfter !== "refund_pending" ||
          ![
            "pending",
            "reship_pending",
            "reprint_pending",
            "replacement_in_production",
            "recovery_pending",
          ].includes(statusBefore)
        : statusAfter !== statusBefore ||
          targetResolutionIds.has(childResolutionId))
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund scope must exclude non-refund siblings and match each child",
      );
    }
    projectedResolutionIds.add(childResolutionId);
    projectedSlotIds.add(childSlotId);
    if (!includedInRefund) continue;

    const childPaymentId = child.paymentId;
    const childPriceAdjustmentId = child.priceAdjustmentId;
    const childAllocationId = child.allocationId;
    const childRefundTransactionId = child.refundTransactionId;
    const childAmountMinor = child.amountMinor;
    const operation = operationByResolution.get(childResolutionId as string);
    if (
      operation === undefined ||
      typeof childPaymentId !== "string" ||
      childPaymentId.trim().length === 0 ||
      childPriceAdjustmentId !== priceAdjustmentId ||
      typeof childAllocationId !== "string" ||
      childAllocationId.trim().length === 0 ||
      typeof childRefundTransactionId !== "string" ||
      childRefundTransactionId.trim().length === 0 ||
      projectedRefundTransactionIds.has(childRefundTransactionId) ||
      typeof childAmountMinor !== "bigint" ||
      childAmountMinor <= 0n ||
      operation.slotId !== childSlotId ||
      operation.paymentId !== childPaymentId ||
      operation.priceAdjustmentId !== childPriceAdjustmentId ||
      operation.allocationId !== childAllocationId ||
      operation.refundTransactionId !== childRefundTransactionId ||
      operation.amountMinor !== childAmountMinor
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund scope must bind each exact Payment, adjustment, transaction, and amount",
      );
    }
    projectedRefundTransactionIds.add(childRefundTransactionId);
    scopeAmountMinor += childAmountMinor;
    includedCount += 1;
    if (
      childResolutionId === resolutionId &&
      (childSlotId !== slotId ||
        childPaymentId !== paymentId ||
        childAllocationId !== allocationId ||
        childRefundTransactionId !== refundTransactionId ||
        childAmountMinor !== amountMinor ||
        statusBefore !== command.current)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "claim refund scope must bind this exact resolution's operation",
      );
    }
  }
  if (
    projectedResolutionIds.size !== allResolutionIds.length ||
    projectedSlotIds.size !== allSlotIds.length ||
    includedCount !== expectedResolutionIds.length ||
    expectedResolutionIds.some((id) => !projectedResolutionIds.has(id)) ||
    expectedSlotIds.some((id) => !projectedSlotIds.has(id)) ||
    scopeAmountMinor !== context.claimRefundScopeAmountMinor ||
    context.claimRefundPriceAdjustmentAmountMinor !== scopeAmountMinor
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "claim refund scope must be complete, exact, and amount-balanced",
    );
  }
}

function requireExactClaimRefundCompletion<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const resolutionId = command.context?.claimSlotResolutionId;
  const claimId = command.context?.claimId;
  const slotId = command.context?.claimSlotId;
  const paymentId = command.context?.paymentId;
  const refundTransactionId = command.context?.refundTransactionId;
  const providerEventId = command.context?.refundProviderEventId;
  const refundAmountMinor = command.context?.refundWebhookAmountMinor;
  if (
    typeof resolutionId !== "string" ||
    resolutionId.trim().length === 0 ||
    command.context?.claimRefundResolutionId !== resolutionId ||
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    command.context?.claimRefundClaimId !== claimId ||
    typeof slotId !== "string" ||
    slotId.trim().length === 0 ||
    command.context?.claimRefundSlotId !== slotId ||
    typeof paymentId !== "string" ||
    paymentId.trim().length === 0 ||
    command.context?.claimRefundPaymentId !== paymentId ||
    command.context?.refundWebhookPaymentId !== paymentId ||
    typeof refundTransactionId !== "string" ||
    refundTransactionId.trim().length === 0 ||
    command.context?.claimRefundTransactionId !== refundTransactionId ||
    command.context?.refundWebhookRefundTransactionId !== refundTransactionId ||
    typeof providerEventId !== "string" ||
    providerEventId.trim().length === 0 ||
    command.context?.claimRefundProviderEventId !== providerEventId ||
    typeof refundAmountMinor !== "bigint" ||
    refundAmountMinor <= 0n ||
    command.context?.claimRefundExpectedAmountMinor !== refundAmountMinor
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "claim refund completion must bind the exact child, slot, Payment, transaction, event, and amount",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "refundWebhookAuthenticated",
    "claim refund completion requires an authenticated provider event",
  );
  requireFlag(
    lifecycle,
    command,
    "refundWebhookVerified",
    "claim refund completion requires a verified provider event",
  );
  if (
    command.context?.refundWebhookStatus !== "succeeded" ||
    command.context?.refundWebhookProjectedTarget !== command.target
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "claim refund provider result must succeed and project this exact target",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "scopedRefundTransactionSucceeded",
    "claim refund completion requires its scoped RefundTransaction success",
  );
  requireFlag(
    lifecycle,
    command,
    "refundPaymentWebhookVerified",
    "claim refund completion requires its matching Payment webhook result",
  );
  requireFlag(
    lifecycle,
    command,
    "claimRefundCompletionAtomic",
    "claim child refund completion and provider-event consumption must be atomic",
  );
}

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
        requireCompleteReplacementRequiredSlotSet(
          "ClaimSlotResolution",
          command,
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
        requireExactClaimRefundScope("ClaimSlotResolution", command);
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
        requireExactClaimRefundCompletion("ClaimSlotResolution", command);
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
