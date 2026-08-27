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

function requireCompleteShipmentReadiness<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const resultId = context?.shipmentReadinessResultId;
  const authoritativeSetId =
    context?.shipmentReadinessAuthoritativeShipmentSetId;
  const authoritativeSetValue =
    context?.shipmentReadinessAuthoritativeShipmentSet;
  const authoritativeSet =
    typeof authoritativeSetValue === "object" &&
    authoritativeSetValue !== null &&
    !Array.isArray(authoritativeSetValue)
      ? (authoritativeSetValue as Readonly<Record<string, unknown>>)
      : undefined;
  const shipmentIdsValue = authoritativeSet?.shipmentIds;
  const shipmentIds = Array.isArray(shipmentIdsValue)
    ? [...shipmentIdsValue]
    : undefined;
  const shipmentsValue = context?.shipmentReadinessShipments;
  const shipments = Array.isArray(shipmentsValue)
    ? [...shipmentsValue]
    : undefined;
  if (
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(resultId) ||
    context?.shipmentReadinessOrderId !== orderId ||
    context?.shipmentReadinessPhaseId !== phaseId ||
    context?.shipmentReadinessOrderResultId !== resultId ||
    context?.shipmentReadinessOrderPreviousStatus !== command.current ||
    context?.shipmentReadinessOrderTargetStatus !== "ready_to_ship" ||
    !nonBlank(authoritativeSetId) ||
    context?.shipmentReadinessExpectedShipmentSetId !== authoritativeSetId ||
    authoritativeSet?.id !== authoritativeSetId ||
    authoritativeSet.orderId !== orderId ||
    authoritativeSet.phaseId !== phaseId ||
    authoritativeSet.immutable !== true ||
    authoritativeSet.resultId !== resultId ||
    shipmentIds === undefined ||
    shipmentIds.length === 0 ||
    !shipmentIds.every(nonBlank) ||
    new Set(shipmentIds).size !== shipmentIds.length ||
    shipments === undefined ||
    shipments.length !== shipmentIds.length ||
    context?.shipmentReadinessCompleted !== true ||
    context?.shipmentReadinessAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "ready to ship requires the exact authoritative current Shipment set",
    );
  }

  const projectedIds = new Set<string>();
  for (const value of shipments) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Shipment readiness requires complete identity records",
      );
    }
    const shipment = value as Readonly<Record<string, unknown>>;
    const id = shipment.id;
    if (
      !nonBlank(id) ||
      projectedIds.has(id) ||
      !shipmentIds.includes(id) ||
      shipment.orderId !== orderId ||
      shipment.phaseId !== phaseId ||
      shipment.currentLineageLeaf !== true ||
      shipment.status !== "label_created" ||
      shipment.readyForHandoff !== true ||
      shipment.allJobsPacked !== true ||
      shipment.labelUsable !== true ||
      shipment.resultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "every exact current Shipment must be ready for handoff",
      );
    }
    projectedIds.add(id);
  }
  if (shipmentIds.some((id) => !projectedIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Shipment readiness cannot omit a required parcel",
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

function requireAtomicQuotedOrderTopology<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const resultId = context?.quotedTopologyResultId;
  const phaseIdsValue = context?.quotedTopologyPhaseIds;
  const phasesValue = context?.quotedTopologyPhases;
  const slotIdsValue = context?.quotedTopologyExpectedSlotIds;
  const slotsValue = context?.quotedTopologySlots;
  const authoritativeSlotSetId = context?.quotedTopologyAuthoritativeSlotSetId;
  const authoritativeSlotSetValue = context?.quotedTopologyAuthoritativeSlotSet;
  const phaseIds = Array.isArray(phaseIdsValue)
    ? [...phaseIdsValue]
    : undefined;
  const phases = Array.isArray(phasesValue) ? [...phasesValue] : undefined;
  const slotIds = Array.isArray(slotIdsValue) ? [...slotIdsValue] : undefined;
  const slots = Array.isArray(slotsValue) ? [...slotsValue] : undefined;
  const authoritativeSlotSet =
    typeof authoritativeSlotSetValue === "object" &&
    authoritativeSlotSetValue !== null &&
    !Array.isArray(authoritativeSlotSetValue)
      ? (authoritativeSlotSetValue as Readonly<Record<string, unknown>>)
      : undefined;
  const authoritativeSlotIdsValue = authoritativeSlotSet?.slotIds;
  const authoritativeSlotIds = Array.isArray(authoritativeSlotIdsValue)
    ? [...authoritativeSlotIdsValue]
    : undefined;

  if (
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(resultId) ||
    context?.quotedTopologyOrderId !== orderId ||
    context?.quotedTopologyOrderPreviousStatus !== "draft" ||
    context?.quotedTopologyOrderTargetStatus !== "quoted" ||
    context?.quotedTopologyOrderResultId !== resultId ||
    context?.quotedTopologyPhaseSetResultId !== resultId ||
    context?.quotedTopologySlotSetResultId !== resultId ||
    phaseIds === undefined ||
    phaseIds.length !== 1 ||
    phaseIds[0] !== phaseId ||
    phases === undefined ||
    phases.length !== 1 ||
    !nonBlank(authoritativeSlotSetId) ||
    context?.quotedTopologyExpectedSlotSetId !== authoritativeSlotSetId ||
    authoritativeSlotSet?.id !== authoritativeSlotSetId ||
    authoritativeSlotSet.orderId !== orderId ||
    authoritativeSlotSet.phaseId !== phaseId ||
    authoritativeSlotSet.immutable !== true ||
    authoritativeSlotSet.resultId !== resultId ||
    authoritativeSlotIds === undefined ||
    authoritativeSlotIds.length === 0 ||
    !authoritativeSlotIds.every(nonBlank) ||
    new Set(authoritativeSlotIds).size !== authoritativeSlotIds.length ||
    slotIds === undefined ||
    slotIds.length === 0 ||
    !slotIds.every(nonBlank) ||
    new Set(slotIds).size !== slotIds.length ||
    !hasSameNonEmptyStringSet(slotIds, authoritativeSlotIds) ||
    slots === undefined ||
    slots.length !== slotIds.length ||
    context?.quotedTopologyCompleted !== true ||
    context?.quotedTopologyAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "quoting requires one exact atomic Order, single phase, and immutable slot topology result",
    );
  }

  const phase = phases[0];
  if (
    typeof phase !== "object" ||
    phase === null ||
    Array.isArray(phase) ||
    (phase as Readonly<Record<string, unknown>>).id !== phaseId ||
    (phase as Readonly<Record<string, unknown>>).orderId !== orderId ||
    (phase as Readonly<Record<string, unknown>>).kind !== "single" ||
    (phase as Readonly<Record<string, unknown>>).status !== "quoted" ||
    (phase as Readonly<Record<string, unknown>>).resultId !== resultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "quoted topology must contain exactly the selected Order's single quoted phase",
    );
  }

  const projectedSlotIds = new Set<string>();
  for (const value of slots) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "quoted topology slots must be complete identity records",
      );
    }
    const slot = value as Readonly<Record<string, unknown>>;
    const id = slot.id;
    if (
      !nonBlank(id) ||
      projectedSlotIds.has(id) ||
      !slotIds.includes(id) ||
      slot.orderId !== orderId ||
      slot.phaseId !== phaseId ||
      slot.immutable !== true ||
      slot.resultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "quoted topology must bind every immutable slot to the exact Order and phase",
      );
    }
    projectedSlotIds.add(id);
  }
  if (slotIds.some((id) => !projectedSlotIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "quoted topology cannot omit an authoritative fulfilment slot",
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
  const context = command.context;
  const expected = context?.expectedCompletionFulfilmentSlotIds;
  const outcomes = context?.completionFulfilmentSlotOutcomes;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const expectedStatus =
    command.target === "completed"
      ? "delivered"
      : command.target === "partially_fulfilled"
        ? "mixed"
        : command.target === "refunded" ||
            command.target === "cancelled_refunded"
          ? "cancelled_refunded"
          : "cancelled_settled";
  const ids = new Set<string>();
  let hasDeliveredOutcome = false;
  let hasCancelledRefundedOutcome = false;
  const valid =
    Array.isArray(expected) &&
    expected.length > 0 &&
    new Set(expected).size === expected.length &&
    expected.every(nonBlank) &&
    Array.isArray(outcomes) &&
    outcomes.length === expected.length &&
    outcomes.every((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
      const outcome = value as Readonly<Record<string, unknown>>;
      const status = outcome.status;
      if (status === "delivered") hasDeliveredOutcome = true;
      if (status === "cancelled_refunded") hasCancelledRefundedOutcome = true;
      return (
        nonBlank(outcome.slotId) &&
        !ids.has(outcome.slotId) &&
        expected.includes(outcome.slotId) &&
        outcome.orderId === context?.orderId &&
        outcome.phaseId === context?.phaseId &&
        (expectedStatus === "mixed"
          ? status === "delivered" || status === "cancelled_refunded"
          : status === expectedStatus) &&
        (ids.add(outcome.slotId), true)
      );
    }) &&
    expected.every((id) => ids.has(id)) &&
    (expectedStatus !== "mixed" ||
      (hasDeliveredOutcome && hasCancelledRefundedOutcome));
  if (context?.completionProjectedTarget !== command.target || !valid) {
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
      readonly orderPreviousStatuses: readonly string[];
      readonly previous:
        | "quoted"
        | "active"
        | "in_production"
        | "qc_passed"
        | "shipped"
        | "recovery_pending";
      readonly target: "cancelled" | "cancelled_refunded";
    }
  | undefined {
  if (orderStatus === "quoted") {
    return {
      orderPreviousStatuses: ["quoted"],
      previous: "quoted",
      target: "cancelled",
    };
  }
  if (orderStatus === "confirmed") {
    return {
      orderPreviousStatuses: ["confirmed"],
      previous: "active",
      target: "cancelled",
    };
  }
  if (orderStatus === "in_production") {
    return {
      orderPreviousStatuses: ["in_production"],
      previous: "in_production",
      target: "cancelled",
    };
  }
  if (
    orderStatus === "qc_passed" ||
    orderStatus === "awaiting_balance" ||
    orderStatus === "ready_to_ship"
  ) {
    return {
      orderPreviousStatuses: [orderStatus],
      previous: "qc_passed",
      target: "cancelled",
    };
  }
  if (orderStatus === "shipped") {
    return {
      orderPreviousStatuses: ["shipped"],
      previous: "shipped",
      target: "cancelled_refunded",
    };
  }
  if (orderStatus === "recovery_pending") {
    return {
      orderPreviousStatuses: ["recovery_pending"],
      previous: "recovery_pending",
      target: "cancelled_refunded",
    };
  }
  return undefined;
}

function requireAtomicOrderPhaseCancellation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const isPhaseEntry = lifecycle === "OrderPhase(single)";
  const expectedPhaseDisposition = isPhaseEntry
    ? expectedSinglePhaseCancellationDisposition(command.current)
    : expectedOrderCancellationPhaseDisposition(command.current);
  if (expectedPhaseDisposition === undefined) return;
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
    !expectedPhaseDisposition.orderPreviousStatuses.includes(
      command.context?.phaseCancellationOrderPreviousStatus as string,
    ) ||
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

function expectedSinglePhaseCancellationDisposition(phaseStatus: string):
  | {
      readonly orderPreviousStatuses: readonly string[];
      readonly previous: string;
      readonly target: "cancelled";
    }
  | undefined {
  if (phaseStatus === "quoted") {
    return {
      orderPreviousStatuses: ["quoted"],
      previous: "quoted",
      target: "cancelled",
    };
  }
  if (phaseStatus === "active") {
    return {
      orderPreviousStatuses: ["confirmed"],
      previous: "active",
      target: "cancelled",
    };
  }
  if (phaseStatus === "in_production") {
    return {
      orderPreviousStatuses: ["in_production"],
      previous: "in_production",
      target: "cancelled",
    };
  }
  if (phaseStatus === "qc_passed") {
    return {
      orderPreviousStatuses: ["qc_passed", "awaiting_balance", "ready_to_ship"],
      previous: "qc_passed",
      target: "cancelled",
    };
  }
  return undefined;
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
  const resultId = command.context?.postQcFailureResultId;
  const jobPreviousStatus = command.context?.postQcFailureJobPreviousStatus;
  const expectedFailureStage =
    jobPreviousStatus === "qc_approved"
      ? "post_qc"
      : jobPreviousStatus === "packed"
        ? "packing"
        : undefined;
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
    command.context?.postQcFailureOrderId !== orderId ||
    typeof resultId !== "string" ||
    resultId.trim().length === 0 ||
    expectedFailureStage === undefined ||
    command.context?.postQcFailureJobTargetStatus !== "failed" ||
    command.context?.postQcFailureFailureStage !== expectedFailureStage ||
    typeof command.context?.postQcFailureFailureReason !== "string" ||
    command.context.postQcFailureFailureReason.trim().length === 0 ||
    command.context?.postQcFailureJobResultId !== resultId ||
    command.context?.postQcFailurePhaseResultId !== resultId ||
    command.context?.postQcFailureOrderResultId !== resultId ||
    command.context?.postQcFailureVerificationResultId !== resultId ||
    command.context?.postQcFailureReplacementResultId !== resultId ||
    command.context?.verifiedPostQcFailure !== true ||
    command.context?.replacementRequestCreated !== true ||
    command.context?.replacementDeadlineSet !== true ||
    command.context?.postQcFailureResolutionCompleted !== true ||
    (lifecycle === "Job" &&
      (command.current !== jobPreviousStatus ||
        command.target !== "failed" ||
        command.context?.failureReason !==
          command.context?.postQcFailureFailureReason)) ||
    (lifecycle === "Order" &&
      (command.context?.postQcFailureOrderPreviousStatus !== command.current ||
        command.target !== "recovery_pending")) ||
    (lifecycle === "OrderPhase(single)" &&
      (command.context?.postQcFailurePhasePreviousStatus !== command.current ||
        command.target !== "recovery_pending"))
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

function requireAtomicPlannedShipmentCancellation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const shipmentId = context?.shipmentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const resultId = context?.plannedShipmentCancellationResultId;
  const shipmentValue = context?.plannedShipmentCancellationShipment;
  const shipment =
    typeof shipmentValue === "object" &&
    shipmentValue !== null &&
    !Array.isArray(shipmentValue)
      ? (shipmentValue as Readonly<Record<string, unknown>>)
      : undefined;
  const resourceSetId =
    context?.plannedShipmentCancellationAuthoritativeResourceSetId;
  const resourceSetValue =
    context?.plannedShipmentCancellationAuthoritativeResourceSet;
  const resourceSet =
    typeof resourceSetValue === "object" &&
    resourceSetValue !== null &&
    !Array.isArray(resourceSetValue)
      ? (resourceSetValue as Readonly<Record<string, unknown>>)
      : undefined;
  const jobIdsValue = resourceSet?.jobIds;
  const reservationIdsValue = resourceSet?.reservationIds;
  const jobIds = Array.isArray(jobIdsValue) ? [...jobIdsValue] : undefined;
  const reservationIds = Array.isArray(reservationIdsValue)
    ? [...reservationIdsValue]
    : undefined;
  const jobsValue = context?.plannedShipmentCancellationJobs;
  const reservationsValue = context?.plannedShipmentCancellationReservations;
  const jobs = Array.isArray(jobsValue) ? [...jobsValue] : undefined;
  const reservations = Array.isArray(reservationsValue)
    ? [...reservationsValue]
    : undefined;
  const barrierValue = context?.plannedShipmentCancellationParentBarrier;
  const barrier =
    typeof barrierValue === "object" &&
    barrierValue !== null &&
    !Array.isArray(barrierValue)
      ? (barrierValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    !nonBlank(shipmentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(resultId) ||
    context?.plannedShipmentCancellationExpectedShipmentId !== shipmentId ||
    context?.plannedShipmentCancellationExpectedOrderId !== orderId ||
    context?.plannedShipmentCancellationExpectedPhaseId !== phaseId ||
    shipment?.id !== shipmentId ||
    shipment.orderId !== orderId ||
    shipment.phaseId !== phaseId ||
    shipment.previousStatus !== "planned" ||
    shipment.targetStatus !== "cancelled" ||
    shipment.resultId !== resultId ||
    !nonBlank(resourceSetId) ||
    context?.plannedShipmentCancellationExpectedResourceSetId !==
      resourceSetId ||
    resourceSet?.id !== resourceSetId ||
    resourceSet.shipmentId !== shipmentId ||
    resourceSet.orderId !== orderId ||
    resourceSet.phaseId !== phaseId ||
    resourceSet.immutable !== true ||
    resourceSet.resultId !== resultId ||
    jobIds === undefined ||
    jobIds.length === 0 ||
    !jobIds.every(nonBlank) ||
    new Set(jobIds).size !== jobIds.length ||
    reservationIds === undefined ||
    reservationIds.length !== jobIds.length ||
    !reservationIds.every(nonBlank) ||
    new Set(reservationIds).size !== reservationIds.length ||
    jobs === undefined ||
    jobs.length !== jobIds.length ||
    reservations === undefined ||
    reservations.length !== reservationIds.length ||
    barrier?.shipmentId !== shipmentId ||
    barrier.orderId !== orderId ||
    barrier.phaseId !== phaseId ||
    barrier.previousStatus !== "open" ||
    barrier.targetStatus !== "released" ||
    barrier.resultId !== resultId ||
    context?.plannedShipmentCancellationCompleted !== true ||
    context?.plannedShipmentCancellationAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "planned Shipment cancellation requires its exact parent and complete resource set",
    );
  }

  const cancellableJobStatuses = new Set([
    "created",
    "accepted",
    "gcode_ready",
    "printing",
    "printed",
    "photo_submitted",
    "qc_approved",
    "packed",
  ]);
  const releasableReservationStatuses = new Set([
    "held",
    "allocated",
    "scheduled",
    "printing",
  ]);
  const jobByReservationId = new Map<string, string>();
  const projectedJobIds = new Set<string>();
  for (const value of jobs) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "planned cancellation Jobs must be complete identity records",
      );
    }
    const job = value as Readonly<Record<string, unknown>>;
    const id = job.id;
    const reservationId = job.reservationId;
    if (
      !nonBlank(id) ||
      projectedJobIds.has(id) ||
      !jobIds.includes(id) ||
      !nonBlank(reservationId) ||
      !reservationIds.includes(reservationId) ||
      jobByReservationId.has(reservationId) ||
      job.shipmentId !== shipmentId ||
      job.orderId !== orderId ||
      job.phaseId !== phaseId ||
      !cancellableJobStatuses.has(job.previousStatus as string) ||
      job.targetStatus !== "cancelled" ||
      job.resultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "planned cancellation must cancel every exact Shipment Job",
      );
    }
    projectedJobIds.add(id);
    jobByReservationId.set(reservationId, id);
  }
  if (jobIds.some((id) => !projectedJobIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "planned cancellation cannot omit a Shipment Job",
    );
  }

  const projectedReservationIds = new Set<string>();
  for (const value of reservations) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "planned cancellation reservations must be complete identity records",
      );
    }
    const reservation = value as Readonly<Record<string, unknown>>;
    const id = reservation.id;
    if (
      !nonBlank(id) ||
      projectedReservationIds.has(id) ||
      !reservationIds.includes(id) ||
      reservation.jobId !== jobByReservationId.get(id) ||
      reservation.shipmentId !== shipmentId ||
      reservation.orderId !== orderId ||
      reservation.phaseId !== phaseId ||
      !releasableReservationStatuses.has(
        reservation.previousStatus as string,
      ) ||
      (reservation.targetStatus !== "released" &&
        reservation.targetStatus !== "settled") ||
      reservation.resultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "planned cancellation must release every exact Job reservation",
      );
    }
    projectedReservationIds.add(id);
  }
  if (reservationIds.some((id) => !projectedReservationIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "planned cancellation cannot omit a Job reservation",
    );
  }
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

function requireExactVerifiedProviderVoid<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const shipmentId = context?.shipmentId;
  const labelId = context?.carrierLabelId;
  const expectedShipmentId = context?.shipmentCancellationExpectedShipmentId;
  const expectedLabelId = context?.shipmentCancellationExpectedCarrierLabelId;
  const outboxId = context?.providerVoidOutboxId;
  const eventId = context?.providerVoidEventId;
  const transactionId = context?.providerVoidTransactionId;
  const cancellationResultId = context?.shipmentCancellationResultId;
  const payload = context?.providerVoidOutboxPayload;
  const payloadRecord =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedIdempotencyKey =
    nonBlank(expectedShipmentId) && nonBlank(expectedLabelId)
      ? `void_carrier_label:${expectedShipmentId}:${expectedLabelId}`
      : undefined;
  if (
    !nonBlank(shipmentId) ||
    !nonBlank(labelId) ||
    !nonBlank(expectedShipmentId) ||
    !nonBlank(expectedLabelId) ||
    shipmentId !== expectedShipmentId ||
    labelId !== expectedLabelId ||
    !nonBlank(outboxId) ||
    !nonBlank(eventId) ||
    !nonBlank(transactionId) ||
    !nonBlank(cancellationResultId) ||
    context?.providerVoidOutboxResultId !== cancellationResultId ||
    context?.providerVoidOutboxIdempotencyKey !== expectedIdempotencyKey ||
    context?.providerVoidOutboxLabelId !== expectedLabelId ||
    context?.providerVoidOutboxPayloadShipmentId !== expectedShipmentId ||
    context?.providerVoidOutboxPayloadCarrierLabelId !== expectedLabelId ||
    context?.providerVoidOutboxPayloadAction !== "void_carrier_label" ||
    payloadRecord?.shipmentId !== expectedShipmentId ||
    payloadRecord?.carrierLabelId !== expectedLabelId ||
    payloadRecord?.action !== "void_carrier_label" ||
    context?.providerVoidOutboxShipmentId !== shipmentId ||
    context?.providerVoidOutboxCarrierLabelId !== labelId ||
    context?.providerVoidOutboxLabelId !== labelId ||
    context?.providerVoidEventShipmentId !== shipmentId ||
    context?.providerVoidEventLabelId !== labelId ||
    context?.providerVoidEventOutboxId !== outboxId ||
    context?.providerVoidTransactionShipmentId !== shipmentId ||
    context?.providerVoidTransactionLabelId !== labelId ||
    context?.providerVoidTransactionOutboxId !== outboxId ||
    context?.providerVoidEventTransactionId !== transactionId ||
    context?.providerVoidOutboxPreviousStatus !== "pending" ||
    context?.providerVoidOutboxTargetStatus !== "succeeded" ||
    context?.providerVoidEventStatus !== "succeeded" ||
    context?.providerVoidTransactionStatus !== "succeeded" ||
    context?.providerVoidEventAuthenticated !== true ||
    context?.providerVoidResultVerified !== true ||
    context?.shipmentCancellationReleaseAtomic !== true
  )
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "cancellation requires the exact authenticated successful provider void and outbox chain",
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

function requireAtomicIssuedQuoteCreation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const quoteRequestId = context?.quoteRequestId;
  const issuedQuoteId = context?.issuedQuoteId;
  const issuedAt = context?.issuedQuoteIssuedAt;
  const expiresAt = context?.issuedQuoteExpiresAt;
  const resultId = context?.quoteIssuanceResultId;
  const issuedQuoteValue = context?.quoteIssuanceIssuedQuote;
  const issuedQuote =
    typeof issuedQuoteValue === "object" &&
    issuedQuoteValue !== null &&
    !Array.isArray(issuedQuoteValue)
      ? (issuedQuoteValue as Readonly<Record<string, unknown>>)
      : undefined;
  const recordIssuedAt = issuedQuote?.issuedAt;
  const recordExpiresAt = issuedQuote?.expiresAt;
  if (
    typeof quoteRequestId !== "string" ||
    quoteRequestId.trim().length === 0 ||
    typeof issuedQuoteId !== "string" ||
    issuedQuoteId.trim().length === 0 ||
    context?.issuedQuoteRequestId !== quoteRequestId ||
    !(issuedAt instanceof Instant) ||
    !(expiresAt instanceof Instant) ||
    issuedAt.compare(expiresAt) >= 0 ||
    typeof resultId !== "string" ||
    resultId.trim().length === 0 ||
    context?.quoteIssuanceQuoteRequestId !== quoteRequestId ||
    context?.quoteIssuanceQuoteRequestPreviousStatus !== "in_review" ||
    context?.quoteIssuanceQuoteRequestTargetStatus !== "quoted" ||
    context?.quoteIssuanceIssuedQuoteId !== issuedQuoteId ||
    context?.quoteIssuanceIssuedQuoteRequestId !== quoteRequestId ||
    context?.quoteIssuanceRequestResultId !== resultId ||
    context?.quoteIssuanceQuoteResultId !== resultId ||
    issuedQuote?.id !== issuedQuoteId ||
    issuedQuote.quoteRequestId !== quoteRequestId ||
    issuedQuote.immutable !== true ||
    issuedQuote.resultId !== resultId ||
    !(recordIssuedAt instanceof Instant) ||
    !recordIssuedAt.equals(issuedAt) ||
    !(recordExpiresAt instanceof Instant) ||
    !recordExpiresAt.equals(expiresAt) ||
    context?.quoteIssuanceCompleted !== true ||
    context?.quoteIssuanceAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "quote issuance requires the exact immutable IssuedQuote and QuoteRequest transition to commit atomically",
    );
  }
}

function requireQuoteAcceptanceAvailability<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  requireAtomicIssuedQuoteCreation(lifecycle, command);
  const context = command.context;
  const quoteRequestId = context?.quoteRequestId;
  const issuedQuoteId = context?.issuedQuoteId;
  const issuedAt = context?.issuedQuoteIssuedAt;
  const expiresAt = context?.issuedQuoteExpiresAt;
  const evaluatedAt = context?.quoteAcceptanceEvaluatedAt;
  const resultId = context?.quoteAcceptanceResultId;
  const issuedQuoteValue = context?.quoteAcceptanceIssuedQuote;
  const issuedQuote =
    typeof issuedQuoteValue === "object" &&
    issuedQuoteValue !== null &&
    !Array.isArray(issuedQuoteValue)
      ? (issuedQuoteValue as Readonly<Record<string, unknown>>)
      : undefined;
  const recordIssuedAt = issuedQuote?.issuedAt;
  const recordExpiresAt = issuedQuote?.expiresAt;
  if (
    typeof quoteRequestId !== "string" ||
    quoteRequestId.trim().length === 0 ||
    typeof issuedQuoteId !== "string" ||
    issuedQuoteId.trim().length === 0 ||
    context?.issuedQuoteRequestId !== quoteRequestId ||
    context?.quoteAcceptanceQuoteRequestId !== quoteRequestId ||
    context?.quoteAcceptanceIssuedQuoteId !== issuedQuoteId ||
    context?.quoteAcceptanceIssuedQuoteRequestId !== quoteRequestId ||
    issuedQuote?.id !== issuedQuoteId ||
    issuedQuote.quoteRequestId !== quoteRequestId ||
    issuedQuote.immutable !== true ||
    typeof context?.quoteAcceptanceIssuedQuoteCreationResultId !== "string" ||
    context.quoteAcceptanceIssuedQuoteCreationResultId.trim().length === 0 ||
    context.quoteAcceptanceIssuedQuoteCreationResultId !==
      context?.quoteIssuanceResultId ||
    issuedQuote.resultId !==
      context.quoteAcceptanceIssuedQuoteCreationResultId ||
    !(issuedAt instanceof Instant) ||
    !(expiresAt instanceof Instant) ||
    issuedAt.compare(expiresAt) >= 0 ||
    !(recordIssuedAt instanceof Instant) ||
    !recordIssuedAt.equals(issuedAt) ||
    !(recordExpiresAt instanceof Instant) ||
    !recordExpiresAt.equals(expiresAt) ||
    !(context?.quoteAcceptanceIssuedAt instanceof Instant) ||
    !context.quoteAcceptanceIssuedAt.equals(issuedAt) ||
    !(context?.quoteAcceptanceExpiresAt instanceof Instant) ||
    !context.quoteAcceptanceExpiresAt.equals(expiresAt) ||
    !(evaluatedAt instanceof Instant) ||
    typeof resultId !== "string" ||
    resultId.trim().length === 0 ||
    context?.quoteAcceptanceAvailabilityResultId !== resultId ||
    context?.quoteAcceptanceOrderResultId !== resultId ||
    context?.quoteAcceptanceRequestResultId !== resultId ||
    context?.quoteAcceptanceQuoteRequestPreviousStatus !== "quoted" ||
    context?.quoteAcceptanceQuoteRequestTargetStatus !== "accepted" ||
    !canAcceptQuote(
      {
        id: issuedQuoteId,
        quoteRequestId,
        issuedAt,
        expiresAt,
      },
      "quoted",
      evaluatedAt,
    )
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "quote acceptance requires an injected time within the exact immutable IssuedQuote window",
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
  const acceptanceResultId = command.context?.quoteAcceptanceResultId;
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
  if (
    typeof acceptanceResultId !== "string" ||
    acceptanceResultId.trim().length === 0 ||
    command.context?.quoteAcceptanceOrderResultId !== acceptanceResultId ||
    command.context?.createdOrderResultId !== acceptanceResultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "accepted quote Order must belong to the exact atomic acceptance result",
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
    if (command.current === "in_review" && command.target === "quoted") {
      requireAtomicIssuedQuoteCreation("QuoteRequest", command);
    }
    if (command.current === "quoted" && command.target === "accepted") {
      requireQuoteAcceptanceAvailability("QuoteRequest", command);
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
      requireAtomicQuotedOrderTopology("Order", command);
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
      requirePostQcJobFailureResolution("Order", command);
    }
    if (command.current === "ready_to_ship" && command.target === "shipped") {
      requireAtomicOrdinaryHandoff("Order", command);
      requireZeroBalances("Order", command);
    }
    if (
      command.current === "awaiting_balance" &&
      command.target === "shipped"
    ) {
      if (
        command.context?.cancellationRaceHandoffKind !==
        "unauthorized_reconciliation"
      ) {
        throw new TransitionGuardError(
          "Order",
          command.current,
          command.target,
          "only the exact unauthorized-handoff reconciliation result may use this edge",
        );
      }
      requireVerifiedMatchingCancellationRaceScan("Order", command);
      requireExactCancellationRaceHandoffResult("Order", command);
    }
    if (
      command.current === "awaiting_balance" &&
      command.target === "ready_to_ship"
    ) {
      requireZeroBalances("Order", command);
      requireCompleteShipmentReadiness("Order", command);
    }
    if (command.current === "qc_passed" && command.target === "ready_to_ship") {
      requireZeroBalances("Order", command);
      requireCompleteShipmentReadiness("Order", command);
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
        requirePostQcJobFailureResolution("OrderPhase(single)", command);
      }
      if (command.current === "qc_passed" && command.target === "shipped") {
        requireAtomicOrdinaryHandoff("OrderPhase(single)", command);
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
      if (command.target === "cancelled") {
        requireAtomicOrderPhaseCancellation("OrderPhase(single)", command);
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
      requireAtomicOrdinaryHandoff("Job", command, {
        shipmentPrevious: "label_created",
        orderPrevious: "ready_to_ship",
        phasePrevious: "qc_passed",
        allowLaterParcel: true,
      });
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

function requireExactShipmentCancellationRequest<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const shipmentId = context?.shipmentId;
  const carrierLabelId = context?.carrierLabelId;
  const expectedShipmentId = context?.shipmentCancellationExpectedShipmentId;
  const expectedCarrierLabelId =
    context?.shipmentCancellationExpectedCarrierLabelId;
  const expectedIdempotencyKey =
    typeof shipmentId === "string" && typeof carrierLabelId === "string"
      ? `void_carrier_label:${shipmentId}:${carrierLabelId}`
      : undefined;
  const payload = context?.providerVoidOutboxPayload;
  const payloadRecord =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Readonly<Record<string, unknown>>)
      : undefined;
  const cancellationResultId = context?.shipmentCancellationResultId;
  if (
    typeof shipmentId !== "string" ||
    shipmentId.trim().length === 0 ||
    typeof expectedShipmentId !== "string" ||
    expectedShipmentId.trim().length === 0 ||
    shipmentId !== expectedShipmentId ||
    context?.shipmentCancellationShipmentId !== shipmentId ||
    typeof carrierLabelId !== "string" ||
    carrierLabelId.trim().length === 0 ||
    typeof expectedCarrierLabelId !== "string" ||
    expectedCarrierLabelId.trim().length === 0 ||
    carrierLabelId !== expectedCarrierLabelId ||
    !nonBlank(cancellationResultId) ||
    context?.shipmentCarrierLabelId !== carrierLabelId ||
    context?.carrierLabelInvalidationShipmentId !== shipmentId ||
    context?.carrierLabelInvalidationLabelId !== carrierLabelId ||
    context?.carrierLabelInvalidationStatusBefore !== "usable" ||
    context?.carrierLabelInvalidationStatusAfter !== "invalidated" ||
    context?.carrierLabelInvalidationResultId !== cancellationResultId ||
    context?.providerVoidOutboxId === undefined ||
    typeof context?.providerVoidOutboxId !== "string" ||
    context?.providerVoidOutboxId.trim().length === 0 ||
    context?.providerVoidOutboxShipmentId !== shipmentId ||
    context?.providerVoidOutboxCarrierLabelId !== carrierLabelId ||
    context?.providerVoidOutboxLabelId !== carrierLabelId ||
    context?.providerVoidOutboxIdempotencyKey !== expectedIdempotencyKey ||
    context?.providerVoidOutboxStatus !== "pending" ||
    context?.providerVoidOutboxPayloadShipmentId !== shipmentId ||
    context?.providerVoidOutboxPayloadCarrierLabelId !== carrierLabelId ||
    context?.providerVoidOutboxPayloadAction !== "void_carrier_label" ||
    payloadRecord?.shipmentId !== shipmentId ||
    payloadRecord?.carrierLabelId !== carrierLabelId ||
    payloadRecord?.action !== "void_carrier_label" ||
    context?.providerVoidOutboxResultId !== cancellationResultId ||
    context?.shipmentCancellationAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Shipment cancellation requires exact carrier-label invalidation and durable provider-void outbox evidence",
    );
  }
}

function requireAtomicOrdinaryHandoff<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  expectedStatuses: Readonly<{
    shipmentPrevious: "label_created" | "cancellation_pending";
    orderPrevious: "ready_to_ship" | "awaiting_balance" | "shipped";
    phasePrevious: "qc_passed" | "shipped";
    allowLaterParcel?: boolean;
    resultProof?: "ordinary" | "cancellation_race";
  }> = {
    shipmentPrevious: "label_created",
    orderPrevious: "ready_to_ship",
    phasePrevious: "qc_passed",
  },
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
  const firstParcelStatusesMatch =
    command.context?.handoffOrderPreviousStatus ===
      expectedStatuses.orderPrevious &&
    command.context?.handoffOrderTargetStatus === "shipped" &&
    command.context?.handoffPhasePreviousStatus ===
      expectedStatuses.phasePrevious &&
    command.context?.handoffPhaseTargetStatus === "shipped";
  const laterParcelStatusesMatch =
    expectedStatuses.allowLaterParcel === true &&
    command.context?.handoffOrderPreviousStatus === "shipped" &&
    command.context?.handoffOrderTargetStatus === "shipped" &&
    command.context?.handoffPhasePreviousStatus === "shipped" &&
    command.context?.handoffPhaseTargetStatus === "shipped";
  const orderPrevious = laterParcelStatusesMatch
    ? "shipped"
    : expectedStatuses.orderPrevious;
  const phasePrevious = laterParcelStatusesMatch
    ? "shipped"
    : expectedStatuses.phasePrevious;
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
    command.context?.phaseKind !== "single" ||
    (!firstParcelStatusesMatch && !laterParcelStatusesMatch) ||
    command.context?.handoffShipmentPreviousStatus !==
      expectedStatuses.shipmentPrevious ||
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
  if (expectedStatuses.resultProof === "cancellation_race") {
    const resultId = command.context?.cancellationRaceHandoffResultId;
    if (
      typeof resultId !== "string" ||
      resultId.trim().length === 0 ||
      command.context?.cancellationRaceShipmentResultId !== resultId ||
      command.context?.cancellationRaceSlotSetResultId !== resultId ||
      command.context?.cancellationRaceJobResultId !== resultId ||
      !hasSameNonEmptyStringSet(
        command.context?.cancellationRaceResultSlotIds,
        expectedSlotIds,
      ) ||
      !hasSameNonEmptyStringSet(
        command.context?.cancellationRaceResultJobIds,
        expectedJobIds,
      )
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "cancellation-race result must bind the exact Shipment, slot set, and Job set",
      );
    }
  }
  if (expectedStatuses.resultProof !== "cancellation_race") {
    const resultId = command.context?.handoffResultId;
    const resultSlotIds = command.context?.handoffResultSlotIds;
    const resultJobIds = command.context?.handoffResultJobIds;
    const scanId = command.context?.handoffResultProviderScanId;
    const scanTransactionId =
      command.context?.handoffResultProviderTransactionId;
    const aggregateSourceMatches =
      lifecycle === "Order"
        ? command.context?.handoffOrderPreviousStatus === command.current
        : lifecycle === "OrderPhase(single)"
          ? command.context?.handoffPhasePreviousStatus === command.current
          : true;
    if (
      typeof resultId !== "string" ||
      resultId.trim().length === 0 ||
      command.context?.handoffResultShipmentResultId !== resultId ||
      command.context?.handoffResultOrderResultId !== resultId ||
      command.context?.handoffResultPhaseResultId !== resultId ||
      command.context?.handoffResultSlotSetResultId !== resultId ||
      command.context?.handoffResultJobSetResultId !== resultId ||
      command.context?.handoffResultProviderScanResultId !== resultId ||
      command.context?.handoffResultCustodyResultId !== resultId ||
      typeof scanId !== "string" ||
      scanId.trim().length === 0 ||
      typeof scanTransactionId !== "string" ||
      scanTransactionId.trim().length === 0 ||
      !aggregateSourceMatches ||
      command.context?.handoffResultShipmentId !== shipmentId ||
      command.context?.handoffResultOrderId !== orderId ||
      command.context?.handoffResultPhaseId !== phaseId ||
      !hasSameNonEmptyStringSet(resultSlotIds, expectedSlotIds) ||
      !hasSameNonEmptyStringSet(resultJobIds, expectedJobIds) ||
      command.context?.handoffResultOrderPreviousStatus !== orderPrevious ||
      command.context?.handoffResultOrderTargetStatus !== "shipped" ||
      command.context?.handoffResultPhasePreviousStatus !== phasePrevious ||
      command.context?.handoffResultPhaseTargetStatus !== "shipped" ||
      command.context?.handoffResultShipmentPreviousStatus !==
        expectedStatuses.shipmentPrevious ||
      command.context?.handoffResultShipmentTargetStatus !== "handed_over" ||
      command.context?.handoffResultJobPreviousStatus !== "packed" ||
      command.context?.handoffResultJobTargetStatus !== "handed_over" ||
      command.context?.handoffResultProviderScanId !== scanId ||
      command.context?.handoffResultProviderScanShipmentId !== shipmentId ||
      command.context?.handoffResultProviderScanOrderId !== orderId ||
      command.context?.handoffResultProviderScanPhaseId !== phaseId ||
      command.context?.handoffResultProviderTransactionId !==
        scanTransactionId ||
      command.context?.handoffResultProviderScanStatus !== "accepted" ||
      command.context?.handoffResultProviderScanAuthenticated !== true ||
      command.context?.handoffResultProviderScanVerified !== true ||
      command.context?.handoffResultCustodyConfirmed !== true ||
      command.context?.handoffResultCompleted !== true ||
      command.context?.handoffResultAtomic !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "aggregate handoff requires the exact atomic Shipment, Order, phase, slot, Job, and provider-scan result",
      );
    }
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
}

const cancellationRaceHandoffKinds = new Set([
  "ordinary",
  "replacement",
  "reship",
  "unauthorized_reconciliation",
]);

function requireExactCancellationRaceHandoffResult<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const kind = context?.cancellationRaceHandoffKind;
  const resultId = context?.cancellationRaceHandoffResultId;
  const shipmentId = context?.shipmentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const providerEventId = context?.providerEventId;
  const providerTransactionId = context?.shipmentProviderTransactionId;
  if (
    typeof kind !== "string" ||
    !cancellationRaceHandoffKinds.has(kind) ||
    typeof resultId !== "string" ||
    resultId.trim().length === 0 ||
    typeof shipmentId !== "string" ||
    shipmentId.trim().length === 0 ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    typeof providerEventId !== "string" ||
    providerEventId.trim().length === 0 ||
    typeof providerTransactionId !== "string" ||
    providerTransactionId.trim().length === 0 ||
    context?.cancellationRaceResultKind !== kind ||
    context?.cancellationRaceResultShipmentId !== shipmentId ||
    context?.cancellationRaceResultOrderId !== orderId ||
    context?.cancellationRaceResultPhaseId !== phaseId ||
    context?.cancellationRaceResultProviderEventId !== providerEventId ||
    context?.cancellationRaceResultProviderTransactionId !==
      providerTransactionId ||
    context?.cancellationRaceResultShipmentPreviousStatus !==
      "cancellation_pending" ||
    context?.cancellationRaceResultShipmentTargetStatus !== "handed_over" ||
    context?.cancellationRaceAggregateResultId !== resultId ||
    context?.cancellationRaceFinancialResultId !== resultId ||
    context?.cancellationRaceAuthorizationResultId !== resultId ||
    context?.cancellationRaceJobResultId !== resultId ||
    context?.cancellationRaceBarrierResultId !== resultId ||
    context?.cancellationRaceBarrierResultStatus !== "scan_won_reconciled"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "cancellation-race handoff must bind the selected handler result to the exact scan and Shipment",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "cancellationRaceAggregateCompleted",
    "cancellation-race handoff requires its scoped aggregate result",
  );
  requireFlag(
    lifecycle,
    command,
    "cancellationRaceFinancialCompleted",
    "cancellation-race handoff requires its scoped financial result",
  );
  requireFlag(
    lifecycle,
    command,
    "cancellationRaceAuthorizationCompleted",
    "cancellation-race handoff requires its scoped authorization result",
  );
  requireFlag(
    lifecycle,
    command,
    "cancellationRaceJobCompleted",
    "cancellation-race handoff requires its scoped Job result",
  );
  requireFlag(
    lifecycle,
    command,
    "cancellationRaceResultCompleted",
    "cancellation-race handoff requires the selected handler to complete",
  );
  requireFlag(
    lifecycle,
    command,
    "cancellationRaceResultAtomic",
    "cancellation-race scan, barrier, and selected handler result must be atomic",
  );

  if (kind === "ordinary") {
    if (
      context?.cancellationRaceAggregateResultStatus !==
        "order_phase_shipped" ||
      context?.cancellationRaceFinancialResultStatus !== "balances_zero" ||
      context?.cancellationRaceAuthorizationResultStatus !==
        "ordinary_handoff_authorized" ||
      context?.cancellationRaceJobResultStatus !==
        "complete_job_set_handed_over"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "ordinary cancellation-race handoff requires its exact aggregate, balance, authorization, and Job results",
      );
    }
    requireFlag(
      lifecycle,
      command,
      "shipmentHandoffAuthorized",
      "ordinary cancellation-race handoff must remain authorized",
    );
    requireZeroBalances(lifecycle, command);
    requireAtomicOrdinaryHandoff(lifecycle, command, {
      shipmentPrevious: "cancellation_pending",
      orderPrevious: "ready_to_ship",
      phasePrevious: "qc_passed",
      resultProof: "cancellation_race",
    });
    return;
  }

  if (kind === "unauthorized_reconciliation") {
    const reconciliationId = context?.handoffReconciliationId;
    const settlementId = context?.handoffSettlementId;
    if (
      context?.cancellationRaceAggregateResultStatus !==
        "order_phase_shipped" ||
      context?.cancellationRaceFinancialResultStatus !==
        "unauthorized_handoff_settled" ||
      context?.cancellationRaceAuthorizationResultStatus !==
        "unauthorized_reconciliation" ||
      context?.cancellationRaceJobResultStatus !==
        "complete_job_set_handed_over" ||
      typeof reconciliationId !== "string" ||
      reconciliationId.trim().length === 0 ||
      context?.handoffReconciliationResultId !== resultId ||
      context?.handoffReconciliationShipmentId !== shipmentId ||
      context?.handoffReconciliationOrderId !== orderId ||
      context?.handoffReconciliationPhaseId !== phaseId ||
      context?.handoffReconciliationProviderEventId !== providerEventId ||
      context?.handoffReconciliationProviderTransactionId !==
        providerTransactionId ||
      context?.handoffReconciliationStatus !== "completed" ||
      context?.handoffReconciliationAtomic !== true ||
      typeof settlementId !== "string" ||
      settlementId.trim().length === 0 ||
      context?.handoffSettlementShipmentId !== shipmentId ||
      context?.handoffSettlementOrderId !== orderId ||
      context?.handoffSettlementPhaseId !== phaseId ||
      context?.handoffSettlementKind !== "handoff_reconciliation" ||
      context?.handoffSettlementImmutable !== true ||
      context?.handoffSettlementResultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "unauthorized cancellation-race handoff requires the exact reconciliation, immutable settlement, and aggregate results",
      );
    }
    requireFlag(
      lifecycle,
      command,
      "handoffReconciliation",
      "unauthorized cancellation-race handoff requires reconciliation",
    );
    requireFlag(
      lifecycle,
      command,
      "handoffSettlementCompleted",
      "unauthorized cancellation-race handoff requires its settlement",
    );
    requireZeroAmountDue(lifecycle, command);
    requireReconciliationRefundAllocation(lifecycle, command);
    requireAtomicOrdinaryHandoff(lifecycle, command, {
      shipmentPrevious: "cancellation_pending",
      orderPrevious: "awaiting_balance",
      phasePrevious: "qc_passed",
      resultProof: "cancellation_race",
    });
    return;
  }

  if (kind === "replacement") {
    if (
      context?.cancellationRaceAggregateResultStatus !==
        "replacement_child_shipped" ||
      context?.cancellationRaceFinancialResultStatus !==
        "claim_remedy_no_charge" ||
      context?.cancellationRaceAuthorizationResultStatus !==
        "replacement_authorization_consumed" ||
      context?.cancellationRaceJobResultStatus !==
        "complete_replacement_job_set_handed_over"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement cancellation-race handoff requires its exact Claim, authorization, and complete Job-set result",
      );
    }
    requireFlag(
      lifecycle,
      command,
      "replacementFulfilmentAuthorizationConsumed",
      "replacement cancellation-race handoff must consume its authorization",
    );
    requireFlag(
      lifecycle,
      command,
      "replacementFulfilmentHandoffCompleted",
      "replacement cancellation-race handoff must complete its exact result",
    );
    requireAtomicCompleteReplacementHandoff(lifecycle, command, shipmentId);
    return;
  }

  if (
    context?.cancellationRaceAggregateResultStatus !== "reship_child_shipped" ||
    context?.cancellationRaceFinancialResultStatus !==
      "claim_remedy_no_charge" ||
    context?.cancellationRaceAuthorizationResultStatus !==
      "reship_authorization_consumed" ||
    context?.cancellationRaceJobResultStatus !== "original_job_unchanged"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "reship cancellation-race handoff requires its exact Claim, authorization, Shipment-only, and unchanged-Job result",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "reshipmentAuthorizationConsumed",
    "reship cancellation-race handoff must consume its authorization",
  );
  requireFlag(
    lifecycle,
    command,
    "reshipmentHandoffCompleted",
    "reship cancellation-race handoff must complete its exact result",
  );
  requireExactReshipmentHandoff(lifecycle, command, true);
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
      requireAtomicPlannedShipmentCancellation("Shipment", command);
    }
    if (
      command.current === "label_created" &&
      command.target === "cancellation_pending"
    ) {
      requireExactShipmentCancellationRequest("Shipment", command);
    }
    if (
      command.current === "label_created" &&
      command.target === "handed_over"
    ) {
      requireAtomicOrdinaryHandoff("Shipment", command, {
        shipmentPrevious: "label_created",
        orderPrevious: "ready_to_ship",
        phasePrevious: "qc_passed",
        allowLaterParcel: true,
      });
    }
    if (
      command.current === "cancellation_pending" &&
      command.target === "handed_over"
    ) {
      requireVerifiedMatchingCancellationRaceScan("Shipment", command);
      requireExactCancellationRaceHandoffResult("Shipment", command);
    }
    if (
      command.current === "cancellation_pending" &&
      command.target === "cancelled"
    ) {
      requireExactVerifiedProviderVoid("Shipment", command);
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

function requireAtomicWholeClaimRejection<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const resultId = context?.claimRejectionResultId;
  const resolutions = Array.isArray(context?.claimSlotResolutions)
    ? context.claimSlotResolutions
    : undefined;
  const selected = resolutions?.filter((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const resolution = value as Readonly<Record<string, unknown>>;
    return resolution.id === resolutionId && resolution.slotId === slotId;
  });
  const completeRejectionChildren = resolutions?.every((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const resolution = value as Readonly<Record<string, unknown>>;
    return (
      resolution.status === "rejected" &&
      resolution.statusBefore === "pending" &&
      resolution.statusAfter === "rejected" &&
      resolution.claimRejectionResultId === resultId
    );
  });
  const statuses = requireCompleteClaimResolutionSet(lifecycle, command);

  if (
    statuses.length === 0 ||
    statuses.some((status) => status !== "rejected") ||
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    typeof resolutionId !== "string" ||
    resolutionId.trim().length === 0 ||
    typeof slotId !== "string" ||
    slotId.trim().length === 0 ||
    typeof resultId !== "string" ||
    resultId.trim().length === 0 ||
    context?.claimRejectionResultClaimId !== claimId ||
    context?.claimRejectionParentResultId !== resultId ||
    context?.claimRejectionChildSetResultId !== resultId ||
    context?.claimRejectionSlotOwnershipResultId !== resultId ||
    context?.claimRejectionRetentionResultId !== resultId ||
    context?.claimRejectionParentClaimId !== claimId ||
    context?.claimRejectionParentPreviousStatus !== "investigating" ||
    context?.claimRejectionParentTargetStatus !== "resolved_rejected" ||
    context?.claimRejectionChildResolutionId !== resolutionId ||
    context?.claimRejectionChildSlotId !== slotId ||
    context?.claimRejectionChildResultId !== resultId ||
    context?.claimRejectionChildStatusBefore !== "pending" ||
    context?.claimRejectionChildStatusAfter !== "rejected" ||
    completeRejectionChildren !== true ||
    selected === undefined ||
    selected.length !== 1 ||
    (selected[0] as Readonly<Record<string, unknown>> | undefined)?.status !==
      "rejected" ||
    (selected[0] as Readonly<Record<string, unknown>> | undefined)
      ?.statusBefore !== "pending" ||
    (selected[0] as Readonly<Record<string, unknown>> | undefined)
      ?.statusAfter !== "rejected"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim rejection requires one exact complete rejected child set and its selected child",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "claimRejectionSlotOwnershipReleased",
    "Claim rejection must release the exact complete slot set",
  );
  requireFlag(
    lifecycle,
    command,
    "claimRejectionRetentionCleanupCompleted",
    "Claim rejection must complete retention cleanup and deadline recomputation",
  );
  requireFlag(
    lifecycle,
    command,
    "claimRejectionDeadlineRecomputed",
    "Claim rejection must persist the recomputed retention deadline",
  );
  requireFlag(
    lifecycle,
    command,
    "claimRejectionResultAtomic",
    "Claim rejection, slot release, and retention cleanup must be atomic",
  );
}

function requireAtomicWholeClaimWithdrawal<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const withdrawableChildSources = new Set([
    "pending",
    "reship_pending",
    "reprint_pending",
    "replacement_in_production",
    "recovery_pending",
  ]);
  const context = command.context;
  const isParentTransition = lifecycle === "Claim";
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const resultId = context?.claimWithdrawalResultId;
  const resolutions = Array.isArray(context?.claimSlotResolutions)
    ? context.claimSlotResolutions
    : undefined;
  const selected = resolutions?.filter((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const resolution = value as Readonly<Record<string, unknown>>;
    return resolution.id === resolutionId && resolution.slotId === slotId;
  });
  const selectedRecord =
    selected?.length === 1 &&
    typeof selected[0] === "object" &&
    selected[0] !== null &&
    !Array.isArray(selected[0])
      ? (selected[0] as Readonly<Record<string, unknown>>)
      : undefined;
  const selectedChildSource = selectedRecord?.statusBefore;
  const completeWithdrawalChildren = resolutions?.every((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const resolution = value as Readonly<Record<string, unknown>>;
    return (
      resolution.status === "withdrawn" &&
      typeof resolution.statusBefore === "string" &&
      withdrawableChildSources.has(resolution.statusBefore) &&
      resolution.statusAfter === "withdrawn" &&
      resolution.claimWithdrawalResultId === resultId
    );
  });
  const needsCancellation = resolutions?.some((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const resolution = value as Readonly<Record<string, unknown>>;
    return resolution.statusBefore !== "pending";
  });
  const statuses = requireCompleteClaimResolutionSet(lifecycle, command);

  if (
    statuses.length === 0 ||
    statuses.some((status) => status !== "withdrawn") ||
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    typeof resolutionId !== "string" ||
    resolutionId.trim().length === 0 ||
    typeof slotId !== "string" ||
    slotId.trim().length === 0 ||
    typeof resultId !== "string" ||
    resultId.trim().length === 0 ||
    context?.claimWithdrawalResultClaimId !== claimId ||
    context?.claimWithdrawalParentResultId !== resultId ||
    context?.claimWithdrawalChildSetResultId !== resultId ||
    context?.claimWithdrawalSlotOwnershipResultId !== resultId ||
    context?.claimWithdrawalRetentionResultId !== resultId ||
    context?.claimWithdrawalParentClaimId !== claimId ||
    (isParentTransition
      ? context?.claimWithdrawalParentPreviousStatus !== command.current
      : context?.claimWithdrawalParentPreviousStatus !== "opened" &&
        context?.claimWithdrawalParentPreviousStatus !== "investigating" &&
        context?.claimWithdrawalParentPreviousStatus !== "active") ||
    context?.claimWithdrawalParentTargetStatus !== "withdrawn" ||
    context?.claimWithdrawalChildResolutionId !== resolutionId ||
    context?.claimWithdrawalChildSlotId !== slotId ||
    context?.claimWithdrawalChildResultId !== resultId ||
    context?.claimWithdrawalChildStatusBefore !== selectedChildSource ||
    context?.claimWithdrawalChildStatusAfter !== "withdrawn" ||
    completeWithdrawalChildren !== true ||
    selected === undefined ||
    selected.length !== 1 ||
    selectedRecord?.status !== "withdrawn" ||
    (isParentTransition !== true && selectedChildSource !== command.current) ||
    selectedRecord?.statusAfter !== "withdrawn"
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim withdrawal requires one exact complete withdrawn child set and its selected child",
    );
  }

  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalSlotOwnershipReleased",
    "Claim withdrawal must release the exact complete slot set",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalRetentionCleanupCompleted",
    "Claim withdrawal must complete retention cleanup and deadline recomputation",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalDeadlineRecomputed",
    "Claim withdrawal must persist the recomputed retention deadline",
  );

  if (needsCancellation !== true) {
    requireFlag(
      lifecycle,
      command,
      "claimWithdrawalResultAtomic",
      "Claim withdrawal, slot release, and retention cleanup must be atomic",
    );
    return;
  }

  const cancellationResultId = context?.claimWithdrawalCancellationResultId;
  const expectedResolutionIds = Array.isArray(
    context?.expectedClaimSlotResolutionIds,
  )
    ? [...context.expectedClaimSlotResolutionIds]
    : undefined;
  const expectedSlotIds = Array.isArray(context?.expectedClaimSlotIds)
    ? [...context.expectedClaimSlotIds]
    : undefined;
  const cancellationResolutionIds = Array.isArray(
    context?.claimWithdrawalCancellationResolutionIds,
  )
    ? [...context.claimWithdrawalCancellationResolutionIds]
    : undefined;
  const cancellationSlotIds = Array.isArray(
    context?.claimWithdrawalCancellationSlotIds,
  )
    ? [...context.claimWithdrawalCancellationSlotIds]
    : undefined;
  const cancellationShipmentIds = Array.isArray(
    context?.claimWithdrawalCancellationShipmentIds,
  )
    ? [...context.claimWithdrawalCancellationShipmentIds]
    : undefined;
  const cancellationShipments = Array.isArray(
    context?.claimWithdrawalCancellationShipments,
  )
    ? [...context.claimWithdrawalCancellationShipments]
    : undefined;
  const exactSet = (
    expected: readonly unknown[] | undefined,
    actual: readonly unknown[] | undefined,
    allowEmpty = false,
  ): actual is string[] =>
    expected !== undefined &&
    (allowEmpty || expected.length > 0) &&
    actual !== undefined &&
    actual.length === expected.length &&
    expected.every((id) => typeof id === "string" && id.trim().length > 0) &&
    new Set(expected).size === expected.length &&
    actual.every(
      (id) =>
        typeof id === "string" && id.trim().length > 0 && expected.includes(id),
    ) &&
    new Set(actual).size === actual.length;

  const expectedResolutionToSlot = new Map<string, string>();
  const expectedBindings = Array.isArray(context?.expectedClaimResolutionSlots)
    ? context.expectedClaimResolutionSlots
    : undefined;
  if (expectedBindings !== undefined) {
    for (const value of expectedBindings) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        continue;
      }
      const binding = value as Readonly<Record<string, unknown>>;
      if (
        typeof binding.resolutionId === "string" &&
        typeof binding.slotId === "string"
      ) {
        expectedResolutionToSlot.set(binding.resolutionId, binding.slotId);
      }
    }
  }
  const authoritativeShipmentIds = Array.isArray(
    context?.claimWithdrawalExpectedRemedyShipmentIds,
  )
    ? [...context.claimWithdrawalExpectedRemedyShipmentIds]
    : undefined;
  const authoritativeShipments = Array.isArray(
    context?.claimWithdrawalExpectedRemedyShipments,
  )
    ? [...context.claimWithdrawalExpectedRemedyShipments]
    : undefined;
  const authoritativeShipmentsById = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const authoritativeResolutionIds = new Set<string>();
  const authoritativeSlotIds = new Set<string>();
  let authoritativeSetValid =
    authoritativeShipmentIds !== undefined &&
    authoritativeShipments !== undefined &&
    authoritativeShipmentIds.length === authoritativeShipments.length;
  if (authoritativeSetValid) {
    for (const value of authoritativeShipments ?? []) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        authoritativeSetValid = false;
        break;
      }
      const shipment = value as Readonly<Record<string, unknown>>;
      const shipmentId = shipment.shipmentId;
      const lineageLeafId = shipment.lineageLeafId;
      const currentStatus = shipment.currentStatus;
      const resolutionIds = Array.isArray(shipment.resolutionIds)
        ? [...shipment.resolutionIds]
        : undefined;
      const slotIds = Array.isArray(shipment.slotIds)
        ? [...shipment.slotIds]
        : undefined;
      const validResolutionIds =
        resolutionIds !== undefined &&
        resolutionIds.length > 0 &&
        resolutionIds.every(
          (id) =>
            typeof id === "string" &&
            id.trim().length > 0 &&
            expectedResolutionIds?.includes(id) === true &&
            !authoritativeResolutionIds.has(id),
        ) &&
        new Set(resolutionIds).size === resolutionIds.length;
      const validSlotIds =
        slotIds !== undefined &&
        slotIds.length > 0 &&
        slotIds.every(
          (id) =>
            typeof id === "string" &&
            id.trim().length > 0 &&
            expectedSlotIds?.includes(id) === true &&
            !authoritativeSlotIds.has(id),
        ) &&
        new Set(slotIds).size === slotIds.length;
      const exactMembership =
        validResolutionIds &&
        validSlotIds &&
        (resolutionIds as string[]).every(
          (resolutionId) =>
            expectedResolutionToSlot.get(resolutionId) !== undefined &&
            (slotIds as string[]).includes(
              expectedResolutionToSlot.get(resolutionId) as string,
            ),
        ) &&
        (slotIds as string[]).every((slotId) =>
          (resolutionIds as string[]).some(
            (resolutionId) =>
              expectedResolutionToSlot.get(resolutionId) === slotId,
          ),
        );
      if (
        typeof shipmentId !== "string" ||
        shipmentId.trim().length === 0 ||
        authoritativeShipmentsById.has(shipmentId) ||
        !authoritativeShipmentIds?.includes(shipmentId) ||
        lineageLeafId !== shipmentId ||
        shipment.claimId !== claimId ||
        shipment.currentLineageLeaf !== true ||
        (currentStatus !== "planned" &&
          currentStatus !== "label_created" &&
          currentStatus !== "cancellation_pending") ||
        !exactMembership
      ) {
        authoritativeSetValid = false;
        break;
      }
      authoritativeShipmentsById.set(shipmentId, shipment);
      for (const resolutionId of resolutionIds as string[]) {
        authoritativeResolutionIds.add(resolutionId);
      }
      for (const slotId of slotIds as string[]) {
        authoritativeSlotIds.add(slotId);
      }
    }
  }
  const coveredResolutionIds = new Set<string>();
  const coveredSlotIds = new Set<string>();
  const projectedShipmentIds = new Set<string>();
  let shipmentEvidenceValid =
    cancellationShipments !== undefined &&
    cancellationShipmentIds !== undefined &&
    cancellationShipments.length === cancellationShipmentIds.length;
  if (shipmentEvidenceValid) {
    for (const value of cancellationShipments ?? []) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        shipmentEvidenceValid = false;
        break;
      }
      const shipment = value as Readonly<Record<string, unknown>>;
      const shipmentId = shipment.shipmentId;
      const lineageLeafId = shipment.lineageLeafId;
      const resolutionIds = Array.isArray(shipment.resolutionIds)
        ? [...shipment.resolutionIds]
        : undefined;
      const slotIds = Array.isArray(shipment.slotIds)
        ? [...shipment.slotIds]
        : undefined;
      const authoritative =
        typeof shipmentId === "string"
          ? authoritativeShipmentsById.get(shipmentId)
          : undefined;
      const authoritativeResolutionMembership = Array.isArray(
        authoritative?.resolutionIds,
      )
        ? [...authoritative.resolutionIds]
        : undefined;
      const authoritativeSlotMembership = Array.isArray(authoritative?.slotIds)
        ? [...authoritative.slotIds]
        : undefined;
      const previousStatus = shipment.previousStatus;
      const providerVoidRequired =
        previousStatus === "label_created" ||
        previousStatus === "cancellation_pending";
      const validPreviousStatus =
        previousStatus === "planned" ||
        previousStatus === "label_created" ||
        previousStatus === "cancellation_pending";
      const validResolutionIds =
        resolutionIds !== undefined &&
        resolutionIds.length > 0 &&
        resolutionIds.every(
          (id) =>
            typeof id === "string" &&
            id.trim().length > 0 &&
            expectedResolutionIds?.includes(id) === true &&
            !coveredResolutionIds.has(id),
        ) &&
        new Set(resolutionIds).size === resolutionIds.length;
      const validSlotIds =
        slotIds !== undefined &&
        slotIds.length > 0 &&
        slotIds.every(
          (id) =>
            typeof id === "string" &&
            id.trim().length > 0 &&
            expectedSlotIds?.includes(id) === true &&
            !coveredSlotIds.has(id),
        ) &&
        new Set(slotIds).size === slotIds.length;
      const exactMembership =
        validResolutionIds &&
        validSlotIds &&
        (resolutionIds as string[]).every(
          (resolutionId) =>
            expectedResolutionToSlot.get(resolutionId) !== undefined &&
            (slotIds as string[]).includes(
              expectedResolutionToSlot.get(resolutionId) as string,
            ),
        ) &&
        (slotIds as string[]).every((slotId) => {
          const resolutionId = (resolutionIds as string[]).find(
            (candidate) => expectedResolutionToSlot.get(candidate) === slotId,
          );
          return resolutionId !== undefined;
        });
      if (
        typeof shipmentId !== "string" ||
        shipmentId.trim().length === 0 ||
        projectedShipmentIds.has(shipmentId) ||
        lineageLeafId !== shipmentId ||
        shipment.claimId !== claimId ||
        authoritative === undefined ||
        authoritative.lineageLeafId !== lineageLeafId ||
        authoritative.claimId !== shipment.claimId ||
        authoritative.currentLineageLeaf !== shipment.currentLineageLeaf ||
        authoritative.currentStatus !== previousStatus ||
        !exactSet(authoritativeResolutionMembership, resolutionIds) ||
        !exactSet(authoritativeSlotMembership, slotIds) ||
        shipment.resultId !== resultId ||
        shipment.currentLineageLeaf !== true ||
        !validPreviousStatus ||
        shipment.targetStatus !== "cancelled" ||
        (providerVoidRequired
          ? shipment.providerVoidStatus !== "succeeded" ||
            shipment.providerVoidConfirmed !== true
          : shipment.providerVoidStatus !== "not_required" ||
            shipment.providerVoidConfirmed !== false) ||
        !exactMembership
      ) {
        shipmentEvidenceValid = false;
        break;
      }
      projectedShipmentIds.add(shipmentId);
      for (const resolutionId of resolutionIds as string[]) {
        coveredResolutionIds.add(resolutionId);
      }
      for (const slotId of slotIds as string[]) {
        coveredSlotIds.add(slotId);
      }
    }
  }
  if (
    typeof cancellationResultId !== "string" ||
    cancellationResultId.trim().length === 0 ||
    cancellationResultId !== resultId ||
    context?.claimWithdrawalCancellationClaimId !== claimId ||
    authoritativeSetValid !== true ||
    !exactSet(authoritativeShipmentIds, cancellationShipmentIds, true) ||
    !exactSet(authoritativeShipmentIds, [...projectedShipmentIds], true) ||
    !exactSet(cancellationResolutionIds, [...coveredResolutionIds], true) ||
    !exactSet(cancellationSlotIds, [...coveredSlotIds], true) ||
    !exactSet(cancellationShipmentIds, [...projectedShipmentIds], true) ||
    !shipmentEvidenceValid ||
    context?.claimWithdrawalCancellationShipmentResultId !== resultId ||
    context?.claimWithdrawalCancellationRequestResultId !== resultId ||
    context?.claimWithdrawalCancellationJobResultId !== resultId ||
    context?.claimWithdrawalCancellationAuthorizationResultId !== resultId ||
    context?.claimWithdrawalCancellationReservationResultId !== resultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "remedy Claim withdrawal requires the complete pre-handoff cancellation result",
    );
  }

  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalAllRemedyShipmentsCancelled",
    "Claim withdrawal requires all applicable remedy Shipments to be cancelled",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalOpenRequestSetCancelled",
    "Claim withdrawal requires the applicable open request set to be cancelled",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalJobsCancelled",
    "Claim withdrawal requires all applicable Jobs to be cancelled",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalAuthorizationsInvalidated",
    "Claim withdrawal requires all applicable authorizations to be invalidated",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalReservationsSettled",
    "Claim withdrawal requires all applicable reservations to be settled",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalCancellationCompleted",
    "Claim withdrawal requires every pre-handoff remedy cancellation to complete",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalCancellationAtomic",
    "Claim withdrawal cancellation and Claim cleanup must be atomic",
  );
  requireFlag(
    lifecycle,
    command,
    "claimWithdrawalResultAtomic",
    "Claim withdrawal, remedy cancellation, slot release, and retention cleanup must be atomic",
  );
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
      command.current === "investigating" &&
      command.target === "resolved_rejected"
    ) {
      requireAtomicWholeClaimRejection("Claim", command);
    }
    if (command.target === "withdrawn") {
      requireAtomicWholeClaimWithdrawal("Claim", command);
    }
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
  if (Array.isArray(command.context?.replacementRequiredRequests)) {
    requireIndependentReplacementResourceSet(lifecycle, command);
    return;
  }
  const resolutionId = command.context?.claimSlotResolutionId;
  const claimId = command.context?.claimId;
  const resolutionSlotId = command.context?.claimSlotId;
  const replacementSetId = command.context?.replacementSetId;
  const expectedSlotIdsValue =
    command.context?.expectedReplacementRequiredSlotIds;
  const bindingsValue = command.context?.replacementRequiredSlotBindings;
  const resourceGroupsValue =
    command.context?.replacementRequiredResourceGroups;
  const expectedSlotIds = Array.isArray(expectedSlotIdsValue)
    ? [...expectedSlotIdsValue]
    : undefined;
  const bindings = Array.isArray(bindingsValue)
    ? [...bindingsValue]
    : undefined;
  const resourceGroups = Array.isArray(resourceGroupsValue)
    ? [...resourceGroupsValue]
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
    bindings.length !== expectedSlotIds.length ||
    resourceGroups === undefined ||
    resourceGroups.length === 0
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement production requires its complete exact required-slot set",
    );
  }

  const expectedSlots = expectedSlotIds as string[];
  const isExactIdSet = (
    expected: readonly string[],
    actual: unknown,
  ): actual is string[] =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (id) =>
        typeof id === "string" && id.trim().length > 0 && expected.includes(id),
    ) &&
    new Set(actual).size === actual.length;

  const resourceGroupIds = new Set<string>();
  const requestIds = new Set<string>();
  const reservationIds = new Set<string>();
  const shipmentIds = new Set<string>();
  const jobIds = new Set<string>();
  const coveredSlotIds = new Set<string>();
  const resourceGroupsById = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const value of resourceGroups) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement production requires authoritative resource-to-slot group records",
      );
    }
    const group = value as Readonly<Record<string, unknown>>;
    const groupId = group.id;
    const slotIds = group.slotIds;
    const requestId = group.replacementRequestId;
    const reservationId = group.replacementReservationId;
    const shipmentId = group.replacementShipmentId;
    const jobId = group.currentReplacementJobId;
    if (
      typeof groupId !== "string" ||
      groupId.trim().length === 0 ||
      resourceGroupIds.has(groupId) ||
      !Array.isArray(slotIds) ||
      slotIds.length === 0 ||
      !isExactIdSet(
        Array.isArray(slotIds) ? (slotIds as string[]) : [],
        slotIds,
      ) ||
      !(slotIds as string[]).every((slotId) =>
        expectedSlots.includes(slotId),
      ) ||
      (slotIds as string[]).some((slotId) => coveredSlotIds.has(slotId)) ||
      group.claimId !== claimId ||
      group.resolutionId !== resolutionId ||
      group.replacementSetId !== replacementSetId ||
      typeof requestId !== "string" ||
      requestId.trim().length === 0 ||
      requestIds.has(requestId) ||
      group.replacementRequestClaimId !== claimId ||
      group.replacementRequestResolutionId !== resolutionId ||
      !isExactIdSet(slotIds as string[], group.replacementRequestSlotIds) ||
      typeof reservationId !== "string" ||
      reservationId.trim().length === 0 ||
      reservationIds.has(reservationId) ||
      group.replacementReservationRequestId !== requestId ||
      !isExactIdSet(slotIds as string[], group.replacementReservationSlotIds) ||
      typeof shipmentId !== "string" ||
      shipmentId.trim().length === 0 ||
      shipmentIds.has(shipmentId) ||
      group.replacementShipmentRequestId !== requestId ||
      group.replacementShipmentReservationId !== reservationId ||
      !isExactIdSet(slotIds as string[], group.replacementShipmentSlotIds) ||
      typeof jobId !== "string" ||
      jobId.trim().length === 0 ||
      jobIds.has(jobId) ||
      group.currentReplacementJobRequestId !== requestId ||
      group.currentReplacementJobReservationId !== reservationId ||
      group.currentReplacementJobShipmentId !== shipmentId ||
      !isExactIdSet(slotIds as string[], group.currentReplacementJobSlotIds) ||
      group.currentReplacementJobLineageLeaf !== true ||
      group.currentReplacementJobStatus !== "created"
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "each replacement resource group must bind its exact Claim child slots to one request, reservation, Shipment, and current Job leaf",
      );
    }
    resourceGroupIds.add(groupId);
    requestIds.add(requestId);
    reservationIds.add(reservationId);
    shipmentIds.add(shipmentId);
    jobIds.add(jobId);
    for (const slotId of slotIds as string[]) {
      coveredSlotIds.add(slotId);
    }
    resourceGroupsById.set(groupId, group);
  }
  if (expectedSlots.some((slotId) => !coveredSlotIds.has(slotId))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement production cannot omit a required slot binding",
    );
  }
  const boundSlotIds = new Set<string>();
  for (const value of bindings) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement production requires exact slot-to-resource-group records",
      );
    }
    const binding = value as Readonly<Record<string, unknown>>;
    const slotId = binding.slotId;
    const resourceGroupId = binding.replacementResourceGroupId;
    const group =
      typeof resourceGroupId === "string"
        ? resourceGroupsById.get(resourceGroupId)
        : undefined;
    if (
      typeof slotId !== "string" ||
      slotId.trim().length === 0 ||
      boundSlotIds.has(slotId) ||
      !expectedSlots.includes(slotId) ||
      group === undefined ||
      !Array.isArray(group.slotIds) ||
      !group.slotIds.includes(slotId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement production requires every required slot to reference its exact authoritative resource group",
      );
    }
    boundSlotIds.add(slotId);
  }
  if (expectedSlots.some((slotId) => !boundSlotIds.has(slotId))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement production cannot omit a required slot-to-resource-group binding",
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

function requireIndependentReplacementResourceSet<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const resolutionSlotId = context?.claimSlotId;
  const replacementSetId = context?.replacementSetId;
  const expected = Array.isArray(context?.expectedReplacementRequiredSlotIds)
    ? context.expectedReplacementRequiredSlotIds
    : undefined;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const exact = (
    expectedIds: readonly string[],
    value: unknown,
  ): value is string[] =>
    Array.isArray(value) &&
    value.length === expectedIds.length &&
    value.every((id) => nonBlank(id) && expectedIds.includes(id)) &&
    new Set(value).size === value.length;
  if (
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(resolutionSlotId) ||
    !nonBlank(replacementSetId) ||
    context?.replacementRequiredSetClaimId !== claimId ||
    context?.replacementRequiredSetResolutionId !== resolutionId ||
    context?.replacementRequiredSetId !== replacementSetId ||
    !Array.isArray(expected) ||
    expected.length === 0 ||
    !exact(expected as string[], expected) ||
    !(expected as string[]).includes(resolutionSlotId)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement production requires its exact required-slot scope",
    );
  }
  const expectedSlots = expected as string[];
  const records = (collection: unknown, label: string, requireLeaf = false) => {
    if (!Array.isArray(collection) || collection.length === 0) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        `replacement production requires ${label} records`,
      );
    }
    const byId = new Map<string, Readonly<Record<string, unknown>>>();
    const covered = new Set<string>();
    for (const value of collection) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement production requires exact ${label} identity records`,
        );
      }
      const record = value as Readonly<Record<string, unknown>>;
      const id = record.id;
      const slotIds = record.slotIds;
      if (
        !nonBlank(id) ||
        byId.has(id) ||
        !Array.isArray(slotIds) ||
        slotIds.length === 0 ||
        !exact(slotIds as string[], slotIds) ||
        !(slotIds as string[]).every(
          (slotId) => expectedSlots.includes(slotId) && !covered.has(slotId),
        ) ||
        record.claimId !== claimId ||
        record.resolutionId !== resolutionId ||
        record.replacementSetId !== replacementSetId ||
        (requireLeaf &&
          (record.currentReplacementJobLineageLeaf !== true ||
            record.currentReplacementJobStatus !== "created"))
      ) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement ${label} must form an exact rooted slot partition`,
        );
      }
      byId.set(id, record);
      for (const slotId of slotIds as string[]) covered.add(slotId);
    }
    if (expectedSlots.some((slotId) => !covered.has(slotId))) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        `replacement ${label} cannot omit a required slot`,
      );
    }
    return byId;
  };
  const requests = records(context?.replacementRequiredRequests, "request");
  const reservations = records(
    context?.replacementRequiredReservations,
    "reservation",
  );
  const shipments = records(context?.replacementRequiredShipments, "Shipment");
  const jobs = records(context?.replacementRequiredJobs, "Job", true);
  const bindings = context?.replacementRequiredSlotBindings;
  if (!Array.isArray(bindings) || bindings.length !== expectedSlots.length) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement production requires exact per-slot resource links",
    );
  }
  const links = new Map<string, Readonly<Record<string, unknown>>>();
  for (const value of bindings) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement production requires resource link records",
      );
    }
    const link = value as Readonly<Record<string, unknown>>;
    const slotId = link.slotId;
    const request = requests.get(link.replacementRequestId as string);
    const reservation = reservations.get(
      link.replacementReservationId as string,
    );
    const shipment = shipments.get(link.replacementShipmentId as string);
    const job = jobs.get(link.currentReplacementJobId as string);
    if (
      !nonBlank(slotId) ||
      links.has(slotId) ||
      !expectedSlots.includes(slotId) ||
      request === undefined ||
      reservation === undefined ||
      shipment === undefined ||
      job === undefined ||
      ![request, reservation, shipment, job].every(
        (record) =>
          Array.isArray(record.slotIds) && record.slotIds.includes(slotId),
      )
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement slot links must reference every authoritative resource dimension",
      );
    }
    links.set(slotId, link);
  }
  const linkedIds = (slotIds: readonly string[], key: string) => [
    ...new Set(
      slotIds.map((slotId) => links.get(slotId)?.[key]).filter(nonBlank),
    ),
  ];
  const verifyRelations = (
    all: Map<string, Readonly<Record<string, unknown>>>,
    fields: readonly string[],
  ) => {
    for (const [id, record] of all) {
      const slotIds = record.slotIds as string[];
      for (const field of fields) {
        const linkKey =
          field === "replacementRequestIds"
            ? "replacementRequestId"
            : field === "replacementReservationIds"
              ? "replacementReservationId"
              : field === "replacementShipmentIds"
                ? "replacementShipmentId"
                : "currentReplacementJobId";
        if (!exact(linkedIds(slotIds, linkKey), record[field])) {
          throw new TransitionGuardError(
            lifecycle,
            command.current,
            command.target,
            "replacement resource relationship backlinks must equal the authoritative slot links",
          );
        }
      }
      if (!nonBlank(id))
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          "replacement resources require stable identities",
        );
    }
  };
  verifyRelations(requests, [
    "replacementReservationIds",
    "currentReplacementJobIds",
  ]);
  verifyRelations(reservations, [
    "replacementRequestIds",
    "currentReplacementJobIds",
  ]);
  verifyRelations(shipments, [
    "replacementRequestIds",
    "replacementReservationIds",
    "currentReplacementJobIds",
  ]);
  verifyRelations(jobs, [
    "replacementRequestIds",
    "replacementReservationIds",
    "replacementShipmentIds",
  ]);
  for (const reservation of reservations.values()) {
    if (
      !Array.isArray(reservation.currentReplacementJobIds) ||
      reservation.currentReplacementJobIds.length !== 1
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "each replacement ProductionReservation must reference exactly one current Job",
      );
    }
  }
  for (const job of jobs.values()) {
    if (
      !Array.isArray(job.replacementReservationIds) ||
      job.replacementReservationIds.length !== 1 ||
      !Array.isArray(job.replacementShipmentIds) ||
      job.replacementShipmentIds.length !== 1
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "each replacement Job must reference exactly one ProductionReservation and one Shipment",
      );
    }
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

function requireAtomicCompleteReplacementHandoff<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  cancellationRaceShipmentId?: string,
): void {
  if (Array.isArray(command.context?.replacementRequiredRequests)) {
    requireIndependentReplacementHandoff(
      lifecycle,
      command,
      cancellationRaceShipmentId,
    );
    return;
  }
  requireCompleteReplacementRequiredSlotSet(lifecycle, command);
  const resolutionId = command.context?.claimSlotResolutionId;
  const claimId = command.context?.claimId;
  const resolutionSlotId = command.context?.claimSlotId;
  const replacementSetId = command.context?.replacementSetId;
  const authorizationId = command.context?.replacementFulfilmentAuthorizationId;
  const requiredSlotIdsValue =
    command.context?.expectedReplacementRequiredSlotIds;
  const handoffSlotIdsValue = command.context?.replacementHandoffSlotIds;
  const authorizationSlotIdsValue =
    command.context?.replacementAuthorizationSlotIds;
  const authorizationShipmentIdsValue =
    command.context?.replacementAuthorizationShipmentIds;
  const bindingsValue = command.context?.replacementHandoffSlotBindings;
  const handoffGroupsValue = command.context?.replacementHandoffResourceGroups;
  const setupGroupsValue = command.context?.replacementRequiredResourceGroups;
  const requiredSlotIds = Array.isArray(requiredSlotIdsValue)
    ? [...requiredSlotIdsValue]
    : undefined;
  const handoffSlotIds = Array.isArray(handoffSlotIdsValue)
    ? [...handoffSlotIdsValue]
    : undefined;
  const authorizationSlotIds = Array.isArray(authorizationSlotIdsValue)
    ? [...authorizationSlotIdsValue]
    : undefined;
  const authorizationShipmentIds = Array.isArray(authorizationShipmentIdsValue)
    ? [...authorizationShipmentIdsValue]
    : undefined;
  const bindings = Array.isArray(bindingsValue)
    ? [...bindingsValue]
    : undefined;
  const handoffGroups = Array.isArray(handoffGroupsValue)
    ? [...handoffGroupsValue]
    : undefined;
  const setupGroups = Array.isArray(setupGroupsValue)
    ? [...setupGroupsValue]
    : undefined;
  const isExactIdArray = (
    expected: readonly unknown[] | undefined,
    actual: readonly unknown[] | undefined,
  ): actual is string[] =>
    expected !== undefined &&
    expected.length > 0 &&
    actual !== undefined &&
    actual.length === expected.length &&
    expected.every((id) => typeof id === "string" && id.trim().length > 0) &&
    new Set(expected).size === expected.length &&
    actual.every(
      (id) =>
        typeof id === "string" && id.trim().length > 0 && expected.includes(id),
    ) &&
    new Set(actual).size === actual.length;

  if (
    typeof resolutionId !== "string" ||
    resolutionId.trim().length === 0 ||
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    typeof resolutionSlotId !== "string" ||
    resolutionSlotId.trim().length === 0 ||
    typeof replacementSetId !== "string" ||
    replacementSetId.trim().length === 0 ||
    command.context?.replacementRequiredSetId !== replacementSetId ||
    command.context?.replacementRequiredSetClaimId !== claimId ||
    command.context?.replacementRequiredSetResolutionId !== resolutionId ||
    !isExactIdArray(requiredSlotIds, handoffSlotIds) ||
    !isExactIdArray(requiredSlotIds, authorizationSlotIds) ||
    requiredSlotIds === undefined ||
    !requiredSlotIds.includes(resolutionSlotId) ||
    typeof authorizationId !== "string" ||
    authorizationId.trim().length === 0 ||
    command.context?.replacementAuthorizationClaimId !== claimId ||
    command.context?.replacementAuthorizationResolutionId !== resolutionId ||
    command.context?.replacementAuthorizationSetId !== replacementSetId ||
    authorizationShipmentIds === undefined ||
    authorizationShipmentIds.length === 0 ||
    authorizationShipmentIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(authorizationShipmentIds).size !==
      authorizationShipmentIds.length ||
    bindings === undefined ||
    bindings.length !== requiredSlotIds.length ||
    handoffGroups === undefined ||
    handoffGroups.length === 0 ||
    setupGroups === undefined ||
    setupGroups.length === 0 ||
    command.context?.replacementConsumedAuthorizationId !== authorizationId ||
    command.context?.replacementConsumedAuthorizationClaimId !== claimId ||
    command.context?.replacementConsumedAuthorizationResolutionId !==
      resolutionId ||
    command.context?.replacementConsumedAuthorizationSetId !==
      replacementSetId ||
    command.context?.replacementAuthorizationStatusBefore !== "issued" ||
    command.context?.replacementAuthorizationStatusAfter !== "consumed" ||
    command.context?.replacementHandoffAuthorizationId !== authorizationId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement handoff requires the exact Claim child authorization and complete setup slot set",
    );
  }

  const expectedSlots = requiredSlotIds as string[];
  const expectedShipments = authorizationShipmentIds as string[];
  const isExactStringIdSet = (
    expected: readonly string[],
    actual: unknown,
  ): actual is string[] =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (id) =>
        typeof id === "string" && id.trim().length > 0 && expected.includes(id),
    ) &&
    new Set(actual).size === actual.length;
  const setupGroupsById = new Map<string, Readonly<Record<string, unknown>>>();
  for (const value of setupGroups) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement handoff requires the exact persisted setup resource groups",
      );
    }
    const setup = value as Readonly<Record<string, unknown>>;
    const setupGroupId = setup.id;
    if (
      typeof setupGroupId !== "string" ||
      setupGroupId.trim().length === 0 ||
      setupGroupsById.has(setupGroupId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement handoff setup resource groups must form one exact set",
      );
    }
    setupGroupsById.set(setupGroupId, setup);
  }
  const handoffGroupsById = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const handoffGroupSlotIds = new Set<string>();
  const handoffShipmentIds = new Set<string>();
  const handoffJobIds = new Set<string>();
  for (const value of handoffGroups) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement handoff requires authoritative resource-to-slot group records",
      );
    }
    const group = value as Readonly<Record<string, unknown>>;
    const groupId = group.id;
    const setupGroupId = group.setupResourceGroupId;
    const slotIds = group.slotIds;
    const shipmentId = group.replacementShipmentId;
    const jobId = group.currentReplacementJobId;
    const setup =
      typeof setupGroupId === "string"
        ? setupGroupsById.get(setupGroupId)
        : undefined;
    const expectedShipmentPreviousStatus =
      cancellationRaceShipmentId === shipmentId
        ? "cancellation_pending"
        : "label_created";
    if (
      typeof groupId !== "string" ||
      groupId.trim().length === 0 ||
      handoffGroupsById.has(groupId) ||
      typeof setupGroupId !== "string" ||
      setupGroupId !== groupId ||
      setup === undefined ||
      !Array.isArray(setup.slotIds) ||
      !isExactStringIdSet(setup.slotIds as string[], slotIds) ||
      (slotIds as string[]).some(
        (slotId) =>
          !expectedSlots.includes(slotId) || handoffGroupSlotIds.has(slotId),
      ) ||
      group.claimId !== claimId ||
      group.resolutionId !== resolutionId ||
      group.replacementSetId !== replacementSetId ||
      typeof shipmentId !== "string" ||
      shipmentId.trim().length === 0 ||
      handoffShipmentIds.has(shipmentId) ||
      !expectedShipments.includes(shipmentId) ||
      group.replacementShipmentClaimId !== claimId ||
      group.replacementShipmentResolutionId !== resolutionId ||
      group.replacementShipmentSetId !== replacementSetId ||
      !isExactStringIdSet(
        slotIds as string[],
        group.replacementShipmentSlotIds,
      ) ||
      group.replacementShipmentPreviousStatus !==
        expectedShipmentPreviousStatus ||
      group.replacementShipmentTargetStatus !== "handed_over" ||
      setup.replacementShipmentId !== shipmentId ||
      typeof jobId !== "string" ||
      jobId.trim().length === 0 ||
      handoffJobIds.has(jobId) ||
      group.currentReplacementJobClaimId !== claimId ||
      group.currentReplacementJobResolutionId !== resolutionId ||
      group.currentReplacementJobSetId !== replacementSetId ||
      group.currentReplacementJobShipmentId !== shipmentId ||
      !isExactStringIdSet(
        slotIds as string[],
        group.currentReplacementJobSlotIds,
      ) ||
      group.currentReplacementJobLineageLeaf !== true ||
      group.currentReplacementJobPreviousStatus !== "packed" ||
      group.currentReplacementJobTargetStatus !== "handed_over" ||
      setup.currentReplacementJobId !== jobId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "every replacement resource group must hand over its exact Shipment and current packed Job leaf",
      );
    }
    handoffGroupsById.set(groupId, group);
    handoffShipmentIds.add(shipmentId);
    handoffJobIds.add(jobId);
    for (const slotId of slotIds as string[]) {
      handoffGroupSlotIds.add(slotId);
    }
  }
  if (
    setupGroupsById.size !== handoffGroupsById.size ||
    [...setupGroupsById.keys()].some(
      (groupId) => !handoffGroupsById.has(groupId),
    ) ||
    expectedSlots.some((slotId) => !handoffGroupSlotIds.has(slotId)) ||
    !isExactStringIdSet(expectedShipments, [...handoffShipmentIds]) ||
    (cancellationRaceShipmentId !== undefined &&
      !handoffShipmentIds.has(cancellationRaceShipmentId))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement handoff cannot omit or substitute an authorized replacement resource group",
    );
  }
  const boundSlotIds = new Set<string>();
  for (const value of bindings) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement handoff requires exact slot-to-resource-group records",
      );
    }
    const binding = value as Readonly<Record<string, unknown>>;
    const slotId = binding.slotId;
    const resourceGroupId = binding.replacementResourceGroupId;
    const group =
      typeof resourceGroupId === "string"
        ? handoffGroupsById.get(resourceGroupId)
        : undefined;
    if (
      typeof slotId !== "string" ||
      slotId.trim().length === 0 ||
      boundSlotIds.has(slotId) ||
      !expectedSlots.includes(slotId) ||
      group === undefined ||
      !Array.isArray(group.slotIds) ||
      !group.slotIds.includes(slotId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "every replacement slot must reference its exact authoritative handoff resource group",
      );
    }
    boundSlotIds.add(slotId);
  }
  if (
    expectedSlots.some((slotId) => !boundSlotIds.has(slotId)) ||
    expectedSlots.some((slotId) => !handoffGroupSlotIds.has(slotId))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement handoff cannot omit an authorized replacement slot or Shipment",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "replacementHandoffSlotSetComplete",
    "replacement handoff requires the authoritative complete setup slot set",
  );
  requireFlag(
    lifecycle,
    command,
    "replacementHandoffAtomic",
    "replacement authorization consumption, Shipment handoff, and Job transitions must be atomic",
  );
}

function requireIndependentReplacementHandoff<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  cancellationRaceShipmentId?: string,
): void {
  requireIndependentReplacementResourceSet(lifecycle, command);
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const exact = (
    expectedIds: readonly string[],
    value: unknown,
  ): value is string[] =>
    Array.isArray(value) &&
    value.length === expectedIds.length &&
    value.every((id) => nonBlank(id) && expectedIds.includes(id)) &&
    new Set(value).size === value.length;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const replacementSetId = context?.replacementSetId;
  const authorizationId = context?.replacementFulfilmentAuthorizationId;
  const selectedShipmentId = context?.replacementAuthorizationShipmentId;
  const setupShipments = Array.isArray(context?.replacementRequiredShipments)
    ? context.replacementRequiredShipments
    : [];
  const setupJobs = Array.isArray(context?.replacementRequiredJobs)
    ? context.replacementRequiredJobs
    : [];
  const handoffShipments = Array.isArray(context?.replacementHandoffShipments)
    ? context.replacementHandoffShipments
    : undefined;
  const handoffJobs = Array.isArray(context?.replacementHandoffJobs)
    ? context.replacementHandoffJobs
    : undefined;
  const handoffLinks = Array.isArray(context?.replacementHandoffSlotBindings)
    ? context.replacementHandoffSlotBindings
    : undefined;
  const shipmentMap = new Map(
    setupShipments
      .filter(
        (value): value is Readonly<Record<string, unknown>> =>
          typeof value === "object" && value !== null && !Array.isArray(value),
      )
      .map((record) => [record.id, record]),
  );
  const jobMap = new Map(
    setupJobs
      .filter(
        (value): value is Readonly<Record<string, unknown>> =>
          typeof value === "object" && value !== null && !Array.isArray(value),
      )
      .map((record) => [record.id, record]),
  );
  const setupLinks = new Map(
    (context?.replacementRequiredSlotBindings as readonly unknown[])
      .filter(
        (value): value is Readonly<Record<string, unknown>> =>
          typeof value === "object" && value !== null && !Array.isArray(value),
      )
      .map((link) => [link.slotId, link]),
  );
  const selectedShipment = shipmentMap.get(selectedShipmentId);
  const selectedSlots = Array.isArray(selectedShipment?.slotIds)
    ? (selectedShipment.slotIds as string[])
    : undefined;
  const selectedJobIds = selectedSlots
    ? [
        ...new Set(
          selectedSlots
            .map((slotId) => setupLinks.get(slotId)?.currentReplacementJobId)
            .filter(nonBlank),
        ),
      ]
    : undefined;
  if (
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(replacementSetId) ||
    !nonBlank(authorizationId) ||
    !nonBlank(selectedShipmentId) ||
    context?.replacementHandoffShipmentId !== selectedShipmentId ||
    selectedSlots === undefined ||
    selectedSlots.length === 0 ||
    selectedJobIds === undefined ||
    selectedJobIds.length === 0 ||
    context?.replacementAuthorizationClaimId !== claimId ||
    context?.replacementAuthorizationResolutionId !== resolutionId ||
    context?.replacementAuthorizationSetId !== replacementSetId ||
    context?.replacementConsumedAuthorizationId !== authorizationId ||
    context?.replacementConsumedAuthorizationClaimId !== claimId ||
    context?.replacementConsumedAuthorizationResolutionId !== resolutionId ||
    context?.replacementConsumedAuthorizationSetId !== replacementSetId ||
    context?.replacementAuthorizationStatusBefore !== "issued" ||
    context?.replacementAuthorizationStatusAfter !== "consumed" ||
    context?.replacementHandoffAuthorizationId !== authorizationId ||
    !exact(selectedSlots, context?.replacementHandoffSlotIds) ||
    !exact(selectedSlots, context?.replacementAuthorizationSlotIds) ||
    !exact(
      [selectedShipmentId],
      context?.replacementAuthorizationShipmentIds,
    ) ||
    !Array.isArray(handoffShipments) ||
    !Array.isArray(handoffJobs) ||
    !Array.isArray(handoffLinks) ||
    handoffLinks.length !== selectedSlots.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement handoff requires exact authorization and complete setup slot scope",
    );
  }
  const verify = (
    records: readonly unknown[],
    setup: Map<unknown, Readonly<Record<string, unknown>>>,
    requiredIds: readonly string[],
    requiredSlots: readonly string[],
    label: string,
    job = false,
  ) => {
    const ids = new Set<string>();
    const covered = new Set<string>();
    for (const value of records) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement handoff requires ${label} records`,
        );
      const record = value as Readonly<Record<string, unknown>>;
      const id = record.id;
      const persisted = setup.get(id);
      const expectedPrevious =
        cancellationRaceShipmentId === id
          ? "cancellation_pending"
          : job
            ? "packed"
            : "label_created";
      if (
        !nonBlank(id) ||
        ids.has(id) ||
        persisted === undefined ||
        !exact(persisted.slotIds as string[], record.slotIds) ||
        record.claimId !== claimId ||
        record.resolutionId !== resolutionId ||
        record.replacementSetId !== replacementSetId ||
        record.previousStatus !== expectedPrevious ||
        record.targetStatus !== "handed_over" ||
        (job && record.currentReplacementJobLineageLeaf !== true)
      )
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement handoff must preserve each exact ${label} identity, membership, and status`,
        );
      ids.add(id);
      for (const slotId of record.slotIds as string[]) covered.add(slotId);
    }
    if (!exact(requiredIds, [...ids]) || !exact(requiredSlots, [...covered]))
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        `replacement handoff cannot omit or substitute a ${label}`,
      );
    return ids;
  };
  const shipmentIds = verify(
    handoffShipments,
    shipmentMap,
    [selectedShipmentId],
    selectedSlots,
    "Shipment",
  );
  const handedOffJobIds = verify(
    handoffJobs,
    jobMap,
    selectedJobIds,
    selectedSlots,
    "Job",
    true,
  );
  if (
    !exact([...shipmentIds], context?.replacementAuthorizationShipmentIds) ||
    (cancellationRaceShipmentId !== undefined &&
      !shipmentIds.has(cancellationRaceShipmentId))
  )
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement handoff authorization must include its exact Shipment set",
    );
  const linked = new Set<string>();
  for (const value of handoffLinks) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement handoff requires per-slot resource links",
      );
    const link = value as Readonly<Record<string, unknown>>;
    const setup = setupLinks.get(link.slotId);
    if (
      !nonBlank(link.slotId) ||
      linked.has(link.slotId) ||
      !selectedSlots.includes(link.slotId) ||
      setup === undefined ||
      setup.replacementRequestId !== link.replacementRequestId ||
      setup.replacementReservationId !== link.replacementReservationId ||
      setup.replacementShipmentId !== link.replacementShipmentId ||
      setup.currentReplacementJobId !== link.currentReplacementJobId ||
      !shipmentIds.has(link.replacementShipmentId as string) ||
      !handedOffJobIds.has(link.currentReplacementJobId as string)
    )
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement handoff links must preserve every exact setup resource assignment",
      );
    linked.add(link.slotId);
  }
  if (!exact(selectedSlots, [...linked]))
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement handoff cannot omit a required slot link",
    );
  requireFlag(
    lifecycle,
    command,
    "replacementHandoffSlotSetComplete",
    "replacement handoff requires the authoritative complete setup slot set",
  );
  requireFlag(
    lifecycle,
    command,
    "replacementHandoffAtomic",
    "replacement authorization consumption, Shipment handoff, and Job transitions must be atomic",
  );
}

function requireExactReshipmentSetup<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const originalShipmentId = context?.shipmentId;
  const expectedClaimId = context?.reshipmentSetupExpectedClaimId;
  const expectedResolutionId = context?.reshipmentSetupExpectedResolutionId;
  const expectedSlotId = context?.reshipmentSetupExpectedSlotId;
  const expectedOrderId = context?.reshipmentSetupExpectedOrderId;
  const expectedPhaseId = context?.reshipmentSetupExpectedPhaseId;
  const expectedOriginalShipmentId =
    context?.reshipmentSetupExpectedOriginalShipmentId;
  const newShipmentId = context?.reshipmentShipmentId;
  const authorizationId = context?.reshipmentAuthorizationId;
  const setupResultId = context?.reshipmentSetupResultId;
  const allocationId = context?.reshipmentSetupAllocationId;
  const shipmentStatus = context?.shipmentStatus;
  const custodyConfirmedAt = context?.reshipmentSetupCustodyConfirmedAt;
  const freshQcPassedAt = context?.reshipmentSetupFreshQcPassedAt;

  if (
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(slotId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(originalShipmentId) ||
    !nonBlank(expectedClaimId) ||
    claimId !== expectedClaimId ||
    !nonBlank(expectedResolutionId) ||
    resolutionId !== expectedResolutionId ||
    !nonBlank(expectedSlotId) ||
    slotId !== expectedSlotId ||
    !nonBlank(expectedOrderId) ||
    orderId !== expectedOrderId ||
    !nonBlank(expectedPhaseId) ||
    phaseId !== expectedPhaseId ||
    !nonBlank(expectedOriginalShipmentId) ||
    originalShipmentId !== expectedOriginalShipmentId ||
    !nonBlank(newShipmentId) ||
    originalShipmentId === newShipmentId ||
    !nonBlank(authorizationId) ||
    !nonBlank(setupResultId) ||
    !nonBlank(allocationId) ||
    (shipmentStatus !== "returned" && shipmentStatus !== "recovered") ||
    !(custodyConfirmedAt instanceof Instant) ||
    !(freshQcPassedAt instanceof Instant) ||
    freshQcPassedAt.compare(custodyConfirmedAt) <= 0 ||
    context?.reshipmentSetupClaimId !== claimId ||
    context?.reshipmentSetupResolutionId !== resolutionId ||
    context?.reshipmentSetupSlotId !== slotId ||
    context?.reshipmentSetupOrderId !== orderId ||
    context?.reshipmentSetupPhaseId !== phaseId ||
    context?.reshipmentSetupResolutionPreviousStatus !== command.current ||
    context?.reshipmentSetupResolutionTargetStatus !== "reship_pending" ||
    context?.reshipmentSetupOriginalShipmentId !== originalShipmentId ||
    context?.reshipmentSetupOriginalShipmentClaimId !== claimId ||
    context?.reshipmentSetupOriginalShipmentResolutionId !== resolutionId ||
    context?.reshipmentSetupOriginalShipmentSlotId !== slotId ||
    context?.reshipmentSetupOriginalShipmentOrderId !== orderId ||
    context?.reshipmentSetupOriginalShipmentPhaseId !== phaseId ||
    context?.reshipmentSetupOriginalShipmentStatus !== shipmentStatus ||
    context?.reshipmentSetupOriginalShipmentCurrentLineageLeaf !== true ||
    context?.reshipmentSetupOriginalShipmentAllocationId !== allocationId ||
    context?.reshipmentSetupCustodyShipmentId !== originalShipmentId ||
    context?.reshipmentSetupCustodyClaimId !== claimId ||
    context?.reshipmentSetupCustodyResolutionId !== resolutionId ||
    context?.reshipmentSetupCustodyStatus !== shipmentStatus ||
    context?.reshipmentSetupQcShipmentId !== originalShipmentId ||
    context?.reshipmentSetupQcClaimId !== claimId ||
    context?.reshipmentSetupQcResolutionId !== resolutionId ||
    context?.reshipmentSetupNewShipmentId !== newShipmentId ||
    context?.reshipmentSetupNewShipmentClaimId !== claimId ||
    context?.reshipmentSetupNewShipmentResolutionId !== resolutionId ||
    context?.reshipmentSetupNewShipmentSlotId !== slotId ||
    context?.reshipmentSetupNewShipmentOrderId !== orderId ||
    context?.reshipmentSetupNewShipmentPhaseId !== phaseId ||
    context?.reshipmentSetupNewShipmentReplacesShipmentId !==
      originalShipmentId ||
    context?.reshipmentSetupNewShipmentAllocationId !== allocationId ||
    context?.reshipmentSetupNewShipmentOriginClaimId !== claimId ||
    context?.reshipmentSetupNewShipmentStatus !== "planned" ||
    context?.reshipmentSetupNewShipmentCurrentLineageLeaf !== true ||
    context?.reshipmentSetupAuthorizationId !== authorizationId ||
    context?.reshipmentCustodyAuthorizationId !== authorizationId ||
    context?.reshipmentSetupAuthorizationClaimId !== claimId ||
    context?.reshipmentSetupAuthorizationResolutionId !== resolutionId ||
    context?.reshipmentSetupAuthorizationSlotId !== slotId ||
    context?.reshipmentSetupAuthorizationOrderId !== orderId ||
    context?.reshipmentSetupAuthorizationPhaseId !== phaseId ||
    context?.reshipmentSetupAuthorizationOriginalShipmentId !==
      originalShipmentId ||
    context?.reshipmentSetupAuthorizationNewShipmentId !== newShipmentId ||
    context?.reshipmentSetupAuthorizationStatus !== "issued" ||
    context?.reshipmentSetupAuthorizationAmountDueMinor !== 0n ||
    context?.reshipmentSetupAuthorizationResultId !== setupResultId ||
    context?.reshipmentSetupResolutionResultId !== setupResultId ||
    context?.reshipmentSetupNewShipmentResultId !== setupResultId ||
    context?.reshipmentSetupCustodyResultId !== setupResultId ||
    context?.reshipmentSetupQcResultId !== setupResultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "reship selection requires the exact custody-backed Claim child, Shipment, allocation, and authorization setup result",
    );
  }
  requireFlag(
    lifecycle,
    command,
    "custodyConfirmed",
    "reship selection requires confirmed custody of the exact original Shipment",
  );
  requireFlag(
    lifecycle,
    command,
    "freshQcPassed",
    "reship selection requires fresh quality control for the exact original Shipment",
  );
  requireFlag(
    lifecycle,
    command,
    "reshipmentAuthorizationCreated",
    "reship selection requires its exact custody-backed authorization",
  );
  requireFlag(
    lifecycle,
    command,
    "reshipmentAuthorizationSetupAtomic",
    "reship authorization, new Shipment, and child selection must be persisted atomically",
  );
}

function requireExactReshipmentHandoff<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  cancellationRace = false,
): void {
  const context = command.context;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const currentShipmentId = context?.shipmentId;
  const originalShipmentId = context?.reshipmentOriginalShipmentId;
  const newShipmentId = context?.reshipmentShipmentId;
  const authorizationId = context?.reshipmentAuthorizationId;
  const consumedAuthorizationId = context?.reshipmentConsumedAuthorizationId;
  const originalJobId = context?.reshipmentOriginalJobId;
  const originalJobStatus = context?.reshipmentHandoffOriginalJobPreviousStatus;

  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

  if (
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(slotId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(currentShipmentId) ||
    !nonBlank(originalShipmentId) ||
    !nonBlank(newShipmentId) ||
    originalShipmentId === newShipmentId ||
    !nonBlank(authorizationId) ||
    !nonBlank(consumedAuthorizationId) ||
    authorizationId !== consumedAuthorizationId ||
    !nonBlank(originalJobId) ||
    (cancellationRace
      ? currentShipmentId !== newShipmentId
      : currentShipmentId !== originalShipmentId) ||
    context?.reshipmentResolutionClaimId !== claimId ||
    context?.reshipmentResolutionId !== resolutionId ||
    context?.reshipmentResolutionSlotId !== slotId ||
    context?.reshipmentResolutionOrderId !== orderId ||
    context?.reshipmentResolutionPhaseId !== phaseId ||
    context?.reshipmentResolutionPreviousStatus !== "reship_pending" ||
    context?.reshipmentResolutionTargetStatus !== "reship_shipped" ||
    context?.reshipmentOriginalShipmentId !== originalShipmentId ||
    context?.reshipmentOriginalShipmentClaimId !== claimId ||
    context?.reshipmentOriginalShipmentResolutionId !== resolutionId ||
    context?.reshipmentOriginalShipmentSlotId !== slotId ||
    context?.reshipmentOriginalShipmentOrderId !== orderId ||
    context?.reshipmentOriginalShipmentPhaseId !== phaseId ||
    context?.reshipmentNewShipmentId !== newShipmentId ||
    context?.reshipmentNewShipmentClaimId !== claimId ||
    context?.reshipmentNewShipmentResolutionId !== resolutionId ||
    context?.reshipmentNewShipmentSlotId !== slotId ||
    context?.reshipmentNewShipmentOrderId !== orderId ||
    context?.reshipmentNewShipmentPhaseId !== phaseId ||
    context?.reshipmentAuthorizationClaimId !== claimId ||
    context?.reshipmentAuthorizationResolutionId !== resolutionId ||
    context?.reshipmentAuthorizationSlotId !== slotId ||
    context?.reshipmentAuthorizationOrderId !== orderId ||
    context?.reshipmentAuthorizationPhaseId !== phaseId ||
    context?.reshipmentAuthorizationOriginalShipmentId !== originalShipmentId ||
    context?.reshipmentAuthorizationNewShipmentId !== newShipmentId ||
    context?.reshipmentCustodyAuthorizationId !== authorizationId ||
    context?.reshipmentConsumedAuthorizationClaimId !== claimId ||
    context?.reshipmentConsumedAuthorizationResolutionId !== resolutionId ||
    context?.reshipmentConsumedAuthorizationSlotId !== slotId ||
    context?.reshipmentConsumedAuthorizationOriginalShipmentId !==
      originalShipmentId ||
    context?.reshipmentConsumedAuthorizationNewShipmentId !== newShipmentId ||
    context?.reshipmentConsumedAuthorizationId !== authorizationId ||
    context?.reshipmentAuthorizationStatusBefore !== "issued" ||
    context?.reshipmentAuthorizationStatusAfter !== "consumed" ||
    context?.reshipmentHandoffClaimId !== claimId ||
    context?.reshipmentHandoffResolutionId !== resolutionId ||
    context?.reshipmentHandoffSlotId !== slotId ||
    context?.reshipmentHandoffOrderId !== orderId ||
    context?.reshipmentHandoffPhaseId !== phaseId ||
    context?.reshipmentHandoffOriginalShipmentId !== originalShipmentId ||
    context?.reshipmentHandoffNewShipmentId !== newShipmentId ||
    context?.reshipmentHandoffAuthorizationId !== authorizationId ||
    context?.reshipmentHandoffShipmentId !== newShipmentId ||
    context?.reshipmentHandoffShipmentPreviousStatus !==
      (cancellationRace ? "cancellation_pending" : "label_created") ||
    context?.reshipmentHandoffShipmentTargetStatus !== "handed_over" ||
    context?.reshipmentHandoffOriginalJobId !== originalJobId ||
    context?.reshipmentHandoffOriginalJobShipmentId !== originalShipmentId ||
    context?.reshipmentHandoffOriginalJobClaimId !== claimId ||
    context?.reshipmentHandoffOriginalJobResolutionId !== resolutionId ||
    context?.reshipmentHandoffOriginalJobSlotId !== slotId ||
    context?.reshipmentHandoffOriginalJobOrderId !== orderId ||
    context?.reshipmentHandoffOriginalJobPhaseId !== phaseId ||
    (originalJobStatus !== "handed_over" && originalJobStatus !== "settled") ||
    context?.reshipmentHandoffOriginalJobTargetStatus !== originalJobStatus ||
    context?.reshipmentHandoffOriginalJobTransitioned !== false ||
    context?.reshipmentHandoffShipmentOnly !== true ||
    context?.reshipmentHandoffAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "reship handoff requires the exact Claim child, custody authorization, new Shipment result, and unchanged original Job",
    );
  }
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
        requireAtomicWholeClaimRejection("ClaimSlotResolution", command);
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
        requireExactReshipmentHandoff("ClaimSlotResolution", command);
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
        requireAtomicCompleteReplacementHandoff("ClaimSlotResolution", command);
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
        requireExactReshipmentSetup("ClaimSlotResolution", command);
      }
      if (command.target === "withdrawn") {
        requireAtomicWholeClaimWithdrawal("ClaimSlotResolution", command);
        requireFlag(
          "ClaimSlotResolution",
          command,
          "cleanPostDeliveryQualityClaim",
          "only a clean post-delivery quality claim can be withdrawn",
        );
      }
    },
  };
