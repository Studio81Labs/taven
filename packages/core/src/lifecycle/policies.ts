import { Instant } from "../primitives/time.js";
import {
  TransitionGuardError,
  type TransitionCommand,
  type TransitionPolicy,
} from "./transition.js";

function hasExactRefundedCancellationRecoveryMarker(
  context: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const reconciliation = record(context?.handoffRefundedReconciliation);
  const settlement = record(context?.handoffRefundedSettlement);
  const reconciliationId = context?.handoffReconciliationId;
  const settlementId = context?.handoffSettlementId;
  return (
    context?.cancellationRaceRefundedAggregate === true &&
    context.cancellationRaceHandoffKind === "unauthorized_reconciliation" &&
    context.cancellationRaceResultKind === "unauthorized_reconciliation" &&
    context.handoffReconciliation === true &&
    context.handoffSettlementCompleted === true &&
    context.handoffReconciliationAtomic === true &&
    context.handoffSettlementImmutable === true &&
    nonBlank(reconciliationId) &&
    nonBlank(settlementId) &&
    reconciliation?.id === reconciliationId &&
    reconciliation.orderSettlementId === settlementId &&
    reconciliation.status === "completed" &&
    reconciliation.immutable === true &&
    settlement?.id === settlementId &&
    settlement.kind === "unauthorized_handoff" &&
    settlement.immutable === true
  );
}

function hasExactNoIntentPaymentTerminalSnapshot(
  state: string,
  context: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (state !== "failed" && state !== "voided") return false;
  const snapshotValue = context?.paymentTerminalSnapshot;
  const snapshot =
    typeof snapshotValue === "object" &&
    snapshotValue !== null &&
    !Array.isArray(snapshotValue)
      ? (snapshotValue as Readonly<Record<string, unknown>>)
      : undefined;
  const paymentId = context?.paymentId;
  const resultId = context?.paymentTerminalSnapshotResultId;
  const stateKey = context?.paymentTerminalSnapshotCurrentStateCommandKey;
  return (
    typeof paymentId === "string" &&
    paymentId.trim().length > 0 &&
    typeof resultId === "string" &&
    resultId.trim().length > 0 &&
    typeof stateKey === "string" &&
    stateKey.trim().length > 0 &&
    snapshot?.id === paymentId &&
    snapshot.status === state &&
    snapshot.providerIntentId === null &&
    snapshot.captureAuthorized === false &&
    snapshot.captureCutoffAt instanceof Instant &&
    snapshot.resultId === resultId &&
    snapshot.currentStateCommandKey === stateKey &&
    snapshot.immutable === true
  );
}

function hasExactRecoverableProviderVoidCancellationRace(
  context: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const shipmentId = context?.shipmentId;
  const carrierLabelId = context?.carrierLabelId;
  const providerEventId = context?.providerEventId;
  const providerTransactionId = context?.shipmentProviderTransactionId;
  const resultId = context?.cancellationRaceHandoffResultId;
  const expectedShipment = record(context?.cancellationRaceExpectedShipment);
  const acceptanceEvent = record(context?.cancellationRaceAcceptanceEvent);
  const voidEvent = record(context?.cancellationRaceSelectedVoidEvent);
  const resultShipment = record(context?.cancellationRaceResultShipment);
  const acceptanceOccurredAt = acceptanceEvent?.occurredAt;
  const acceptanceVerifiedAt = acceptanceEvent?.verifiedAt;
  const voidOccurredAt = voidEvent?.occurredAt;
  const voidVerifiedAt = voidEvent?.verifiedAt;
  const handedOverAt = resultShipment?.handedOverAt;
  const providerVoidedAt = expectedShipment?.providerVoidedAt;
  const cancelledAt = expectedShipment?.cancelledAt;
  const voidEventId = voidEvent?.id;
  const carrier = resultShipment?.carrier;

  return (
    nonBlank(shipmentId) &&
    nonBlank(carrierLabelId) &&
    nonBlank(providerEventId) &&
    nonBlank(providerTransactionId) &&
    nonBlank(resultId) &&
    nonBlank(voidEventId) &&
    nonBlank(carrier) &&
    context?.providerEventShipmentId === shipmentId &&
    context.providerEventTransactionId === providerTransactionId &&
    context.shipmentProviderScanEventId === providerEventId &&
    context.providerEventKind === "acceptance_scan" &&
    context.providerEventStatus === "handed_over" &&
    context.providerEventAuthenticated === true &&
    context.providerEventVerified === true &&
    context.verifiedProviderScan === true &&
    expectedShipment?.id === shipmentId &&
    expectedShipment.status === "cancelled" &&
    expectedShipment.providerVoidId === voidEventId &&
    providerVoidedAt instanceof Instant &&
    cancelledAt instanceof Instant &&
    expectedShipment.immutable === true &&
    resultShipment?.id === shipmentId &&
    resultShipment.previousStatus === "cancelled" &&
    resultShipment.targetStatus === "handed_over" &&
    resultShipment.carrierLabelId === carrierLabelId &&
    resultShipment.providerAcceptanceScanId === providerEventId &&
    handedOverAt instanceof Instant &&
    resultShipment.resultId === resultId &&
    resultShipment.immutable === true &&
    acceptanceEvent?.id === providerEventId &&
    acceptanceEvent.shipmentId === shipmentId &&
    acceptanceEvent.carrier === carrier &&
    acceptanceEvent.carrierLabelId === carrierLabelId &&
    acceptanceEvent.transactionId === providerTransactionId &&
    acceptanceEvent.kind === "acceptance_scan" &&
    acceptanceEvent.authenticated === true &&
    acceptanceEvent.verified === true &&
    acceptanceEvent.immutable === true &&
    acceptanceOccurredAt instanceof Instant &&
    acceptanceVerifiedAt instanceof Instant &&
    voidEvent?.shipmentId === shipmentId &&
    voidEvent.carrier === carrier &&
    voidEvent.carrierLabelId === carrierLabelId &&
    voidEvent.kind === "label_voided" &&
    voidEvent.authenticated === true &&
    voidEvent.verified === true &&
    voidEvent.immutable === true &&
    voidOccurredAt instanceof Instant &&
    voidVerifiedAt instanceof Instant &&
    handedOverAt.equals(acceptanceVerifiedAt) &&
    acceptanceOccurredAt.compare(voidOccurredAt) < 0 &&
    providerVoidedAt.equals(voidVerifiedAt) &&
    cancelledAt.epochMilliseconds >= voidVerifiedAt.epochMilliseconds - 5_000
  );
}

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
  const previousOrderResultId = context?.shipmentReadinessPreviousOrderResultId;
  const orderStateKey = context?.shipmentReadinessCurrentStateCommandKey;
  const expectedOrderValue = context?.shipmentReadinessExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
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
    command.aggregateId !== orderId ||
    !nonBlank(previousOrderResultId) ||
    !nonBlank(orderStateKey) ||
    command.currentStateResultId !== previousOrderResultId ||
    command.currentStateCommandKey !== orderStateKey ||
    expectedOrder?.id !== orderId ||
    expectedOrder.phaseId !== phaseId ||
    expectedOrder.status !== command.current ||
    expectedOrder.resultId !== previousOrderResultId ||
    expectedOrder.currentStateCommandKey !== orderStateKey ||
    expectedOrder.immutable !== true ||
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
  const orderPreviousResultId = context?.quotedTopologyOrderPreviousResultId;
  const orderStateKey = context?.quotedTopologyOrderCurrentStateCommandKey;
  const expectedOrderValue = context?.quotedTopologyExpectedOrder;
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
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const authoritativeSlotIdsValue = authoritativeSlotSet?.slotIds;
  const authoritativeSlotIds = Array.isArray(authoritativeSlotIdsValue)
    ? [...authoritativeSlotIdsValue]
    : undefined;

  if (
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(resultId) ||
    !nonBlank(orderPreviousResultId) ||
    !nonBlank(orderStateKey) ||
    command.aggregateId !== orderId ||
    command.currentStateResultId !== orderPreviousResultId ||
    command.currentStateCommandKey !== orderStateKey ||
    expectedOrder?.id !== orderId ||
    expectedOrder.status !== "draft" ||
    expectedOrder.resultId !== orderPreviousResultId ||
    expectedOrder.currentStateCommandKey !== orderStateKey ||
    expectedOrder.immutable !== true ||
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
  const selectedAggregateId =
    lifecycle === "Order" ? context?.orderId : context?.phaseId;
  const selectedAggregateStateKey =
    lifecycle === "Order"
      ? context?.completionOrderCurrentStateCommandKey
      : context?.completionPhaseCurrentStateCommandKey;
  const expectedAggregateValue =
    lifecycle === "Order"
      ? context?.completionExpectedOrder
      : context?.completionExpectedPhase;
  const expectedAggregate =
    typeof expectedAggregateValue === "object" &&
    expectedAggregateValue !== null &&
    !Array.isArray(expectedAggregateValue)
      ? (expectedAggregateValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expected = context?.expectedCompletionFulfilmentSlotIds;
  const outcomes = context?.completionFulfilmentSlotOutcomes;
  const topologyId = context?.completionAuthoritativePhaseTopologyId;
  const expectedTopologyId = context?.completionExpectedPhaseTopologyId;
  const topologyValue = context?.completionExpectedPhaseTopology;
  const topology =
    typeof topologyValue === "object" &&
    topologyValue !== null &&
    !Array.isArray(topologyValue)
      ? (topologyValue as Readonly<Record<string, unknown>>)
      : undefined;
  const setId = context?.completionAuthoritativeFulfilmentSlotSetId;
  const expectedSetId = context?.completionExpectedFulfilmentSlotSetId;
  const setResultId = context?.completionAuthoritativeFulfilmentSlotSetResultId;
  const authoritativeValue = context?.completionAuthoritativeFulfilmentSlotSet;
  const authoritative =
    typeof authoritativeValue === "object" &&
    authoritativeValue !== null &&
    !Array.isArray(authoritativeValue)
      ? (authoritativeValue as Readonly<Record<string, unknown>>)
      : undefined;
  const authoritativeIdsValue = authoritative?.slotIds;
  const authoritativeIds = Array.isArray(authoritativeIdsValue)
    ? [...authoritativeIdsValue]
    : undefined;
  const authoritativeSlotsValue = authoritative?.slotSnapshots;
  const authoritativeSlots = Array.isArray(authoritativeSlotsValue)
    ? [...authoritativeSlotsValue]
    : undefined;
  const completionResultId = context?.completionResultId;
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
  const expectedTopologyStatus =
    lifecycle === "Order" &&
    command.current === "awaiting_balance" &&
    command.target === "cancelled_settled"
      ? "qc_passed"
      : command.current;
  const expectedAggregateStatus =
    lifecycle === "OrderPhase(single)"
      ? expectedTopologyStatus
      : command.current;
  const authoritativeSlotById = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const authoritativeSlotSetValid =
    authoritativeSlots !== undefined &&
    authoritativeSlots.every((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
      const slot = value as Readonly<Record<string, unknown>>;
      if (
        !nonBlank(slot.id) ||
        authoritativeSlotById.has(slot.id) ||
        !authoritativeIds?.includes(slot.id) ||
        slot.orderId !== context?.orderId ||
        slot.phaseId !== context?.phaseId ||
        !nonBlank(slot.sourceResultId) ||
        !nonBlank(slot.sourceCurrentStateCommandKey) ||
        slot.immutable !== true
      ) {
        return false;
      }
      authoritativeSlotById.set(slot.id, slot);
      return true;
    }) &&
    authoritativeSlotById.size === authoritativeIds?.length;
  const ids = new Set<string>();
  let hasDeliveredOutcome = false;
  let hasCancelledRefundedOutcome = false;
  const valid =
    ((lifecycle === "Order" && command.aggregateId === context?.orderId) ||
      (lifecycle === "OrderPhase(single)" &&
        command.aggregateId === context?.phaseId)) &&
    nonBlank(selectedAggregateId) &&
    nonBlank(selectedAggregateStateKey) &&
    nonBlank(expectedAggregate?.resultId) &&
    command.currentStateResultId === expectedAggregate.resultId &&
    command.currentStateCommandKey === selectedAggregateStateKey &&
    expectedAggregate?.id === selectedAggregateId &&
    expectedAggregate.orderId === context?.orderId &&
    expectedAggregate.phaseId === context?.phaseId &&
    expectedAggregate.status === expectedAggregateStatus &&
    expectedAggregate.currentStateCommandKey === selectedAggregateStateKey &&
    expectedAggregate.phaseTopologyId === topologyId &&
    expectedAggregate.fulfilmentSlotSetId === setId &&
    expectedAggregate.fulfilmentSlotSetResultId === setResultId &&
    expectedAggregate.immutable === true &&
    nonBlank(topologyId) &&
    topologyId === context?.phaseId &&
    expectedTopologyId === topologyId &&
    topology?.id === topologyId &&
    topology?.orderId === context?.orderId &&
    topology?.kind === "single" &&
    topology?.status === expectedTopologyStatus &&
    topology?.authoritativeFulfilmentSlotSetId === setId &&
    topology?.authoritativeFulfilmentSlotSetResultId === setResultId &&
    topology?.immutable === true &&
    nonBlank(setId) &&
    expectedSetId === setId &&
    nonBlank(setResultId) &&
    nonBlank(command.ownershipSnapshotId) &&
    command.ownershipSnapshotId === setId &&
    nonBlank(command.ownershipSnapshotResultId) &&
    command.ownershipSnapshotResultId === setResultId &&
    authoritative?.id === setId &&
    authoritative?.orderId === context?.orderId &&
    authoritative?.phaseId === context?.phaseId &&
    authoritative?.phaseTopologyId === topologyId &&
    authoritative?.resultId === setResultId &&
    authoritative?.completionResultId === completionResultId &&
    authoritative?.completionTarget === command.target &&
    authoritative?.sourceStatus === command.current &&
    authoritative?.immutable === true &&
    context?.completionSlotSetOrderId === context?.orderId &&
    context?.completionSlotSetPhaseId === context?.phaseId &&
    context?.completionSlotSetPhaseTopologyId === topologyId &&
    authoritativeIds !== undefined &&
    authoritativeIds.length > 0 &&
    authoritativeIds.every(nonBlank) &&
    new Set(authoritativeIds).size === authoritativeIds.length &&
    authoritativeSlots !== undefined &&
    authoritativeSlots.length === authoritativeIds.length &&
    authoritativeSlotSetValid &&
    nonBlank(completionResultId) &&
    context?.completionResultAtomic === true &&
    Array.isArray(expected) &&
    expected.length > 0 &&
    new Set(expected).size === expected.length &&
    expected.every(nonBlank) &&
    hasSameNonEmptyStringSet(expected, authoritativeIds) &&
    Array.isArray(outcomes) &&
    outcomes.length === expected.length &&
    outcomes.every((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
      const outcome = value as Readonly<Record<string, unknown>>;
      const status = outcome.status;
      if (status === "delivered") hasDeliveredOutcome = true;
      if (status === "cancelled_refunded") hasCancelledRefundedOutcome = true;
      const source = nonBlank(outcome.slotId)
        ? authoritativeSlotById.get(outcome.slotId)
        : undefined;
      return (
        nonBlank(outcome.slotId) &&
        source !== undefined &&
        source.status === status &&
        source.sourceResultId === outcome.sourceResultId &&
        source.sourceCurrentStateCommandKey ===
          outcome.sourceCurrentStateCommandKey &&
        nonBlank(outcome.sourceResultId) &&
        nonBlank(outcome.sourceCurrentStateCommandKey) &&
        outcome.resultId === completionResultId &&
        outcome.completionTarget === command.target &&
        outcome.immutable === true &&
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
  const orderPreviousResultId =
    command.context?.confirmationOrderPreviousResultId;
  const phasePreviousResultId =
    command.context?.confirmationPhasePreviousResultId;
  const orderStateKey =
    command.context?.confirmationOrderCurrentStateCommandKey;
  const phaseStateKey =
    command.context?.confirmationPhaseCurrentStateCommandKey;
  const expectedOrderValue = command.context?.confirmationExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedPhaseValue = command.context?.confirmationExpectedPhase;
  const expectedPhase =
    typeof expectedPhaseValue === "object" &&
    expectedPhaseValue !== null &&
    !Array.isArray(expectedPhaseValue)
      ? (expectedPhaseValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    (lifecycle === "Order" && command.aggregateId !== orderId) ||
    (lifecycle === "OrderPhase(single)" && command.aggregateId !== phaseId) ||
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
      phaseReservationSetId ||
    typeof orderPreviousResultId !== "string" ||
    orderPreviousResultId.trim().length === 0 ||
    typeof phasePreviousResultId !== "string" ||
    phasePreviousResultId.trim().length === 0 ||
    typeof orderStateKey !== "string" ||
    orderStateKey.trim().length === 0 ||
    typeof phaseStateKey !== "string" ||
    phaseStateKey.trim().length === 0 ||
    (lifecycle === "Order" &&
      (command.currentStateResultId !== orderPreviousResultId ||
        command.currentStateCommandKey !== orderStateKey)) ||
    (lifecycle === "OrderPhase(single)" &&
      (command.currentStateResultId !== phasePreviousResultId ||
        command.currentStateCommandKey !== phaseStateKey)) ||
    expectedOrder?.id !== orderId ||
    expectedOrder.phaseId !== phaseId ||
    expectedOrder.status !== "quoted" ||
    expectedOrder.resultId !== orderPreviousResultId ||
    expectedOrder.currentStateCommandKey !== orderStateKey ||
    expectedOrder.immutable !== true ||
    expectedPhase?.id !== phaseId ||
    expectedPhase.orderId !== orderId ||
    expectedPhase.status !== "quoted" ||
    expectedPhase.resultId !== phasePreviousResultId ||
    expectedPhase.currentStateCommandKey !== phaseStateKey ||
    expectedPhase.immutable !== true
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
  const context = command.context;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const orderPreviousResultId = context?.phaseCancellationOrderPreviousResultId;
  const phasePreviousResultId = context?.phaseCancellationPhasePreviousResultId;
  const orderStateKey = context?.phaseCancellationOrderCurrentStateCommandKey;
  const phaseStateKey = context?.phaseCancellationPhaseCurrentStateCommandKey;
  const expectedOrderValue = context?.phaseCancellationExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedPhaseValue = context?.phaseCancellationExpectedPhase;
  const expectedPhase =
    typeof expectedPhaseValue === "object" &&
    expectedPhaseValue !== null &&
    !Array.isArray(expectedPhaseValue)
      ? (expectedPhaseValue as Readonly<Record<string, unknown>>)
      : undefined;
  const selectedAggregateId = isPhaseEntry ? phaseId : orderId;
  const selectedPreviousResultId = isPhaseEntry
    ? phasePreviousResultId
    : orderPreviousResultId;
  const selectedStateKey = isPhaseEntry ? phaseStateKey : orderStateKey;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.phaseCancellationOrderId !== orderId ||
    command.context?.phaseCancellationPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.phaseCancellationPhaseId !== phaseId ||
    typeof orderPreviousResultId !== "string" ||
    orderPreviousResultId.trim().length === 0 ||
    typeof phasePreviousResultId !== "string" ||
    phasePreviousResultId.trim().length === 0 ||
    typeof orderStateKey !== "string" ||
    orderStateKey.trim().length === 0 ||
    typeof phaseStateKey !== "string" ||
    phaseStateKey.trim().length === 0 ||
    command.aggregateId !== selectedAggregateId ||
    command.currentStateResultId !== selectedPreviousResultId ||
    command.currentStateCommandKey !== selectedStateKey ||
    expectedOrder?.id !== orderId ||
    expectedOrder.phaseId !== phaseId ||
    expectedOrder.status !== context?.phaseCancellationOrderPreviousStatus ||
    expectedOrder.resultId !== orderPreviousResultId ||
    expectedOrder.currentStateCommandKey !== orderStateKey ||
    expectedOrder.immutable !== true ||
    expectedPhase?.id !== phaseId ||
    expectedPhase.orderId !== orderId ||
    expectedPhase.status !== expectedPhaseDisposition.previous ||
    expectedPhase.resultId !== phasePreviousResultId ||
    expectedPhase.currentStateCommandKey !== phaseStateKey ||
    expectedPhase.immutable !== true
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
  const context = command.context;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const orderStateKey = context?.completionOrderCurrentStateCommandKey;
  const phaseStateKey = context?.completionPhaseCurrentStateCommandKey;
  const expectedOrderValue = context?.completionExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedPhaseValue = context?.completionExpectedPhase;
  const expectedPhase =
    typeof expectedPhaseValue === "object" &&
    expectedPhaseValue !== null &&
    !Array.isArray(expectedPhaseValue)
      ? (expectedPhaseValue as Readonly<Record<string, unknown>>)
      : undefined;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const selectedStateKey =
    lifecycle === "Order" ? orderStateKey : phaseStateKey;
  const selectedExpected =
    lifecycle === "Order" ? expectedOrder : expectedPhase;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    (lifecycle === "Order" && command.aggregateId !== orderId) ||
    (lifecycle === "OrderPhase(single)" && command.aggregateId !== phaseId) ||
    context?.orderCompletionOrderId !== orderId ||
    context?.orderCompletionPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    context?.orderCompletionPhaseId !== phaseId ||
    !nonBlank(selectedStateKey) ||
    !nonBlank(selectedExpected?.resultId) ||
    command.currentStateCommandKey !== selectedStateKey ||
    command.currentStateResultId !== selectedExpected.resultId ||
    expectedOrder?.id !== orderId ||
    expectedOrder.phaseId !== phaseId ||
    expectedOrder.status !== "delivered" ||
    expectedOrder.currentStateCommandKey !== orderStateKey ||
    !nonBlank(expectedOrder.resultId) ||
    expectedOrder.immutable !== true ||
    expectedPhase?.id !== phaseId ||
    expectedPhase.orderId !== orderId ||
    expectedPhase.status !== "delivered" ||
    expectedPhase.currentStateCommandKey !== phaseStateKey ||
    !nonBlank(expectedPhase.resultId) ||
    expectedPhase.immutable !== true ||
    context?.completionAuthoritativePhaseTopologyId !== phaseId ||
    expectedOrder.phaseTopologyId !==
      context?.completionAuthoritativePhaseTopologyId ||
    expectedPhase.phaseTopologyId !==
      context?.completionAuthoritativePhaseTopologyId
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
  const context = command.context;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const orderPreviousResultId = context?.productionStartOrderPreviousResultId;
  const phasePreviousResultId = context?.productionStartPhasePreviousResultId;
  const orderStateKey = context?.productionStartOrderCurrentStateCommandKey;
  const phaseStateKey = context?.productionStartPhaseCurrentStateCommandKey;
  const expectedOrderValue = context?.productionStartExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedPhaseValue = context?.productionStartExpectedPhase;
  const expectedPhase =
    typeof expectedPhaseValue === "object" &&
    expectedPhaseValue !== null &&
    !Array.isArray(expectedPhaseValue)
      ? (expectedPhaseValue as Readonly<Record<string, unknown>>)
      : undefined;
  const isPhaseEntry = lifecycle === "OrderPhase(single)";
  const selectedAggregateId = isPhaseEntry ? phaseId : orderId;
  const selectedPreviousResultId = isPhaseEntry
    ? phasePreviousResultId
    : orderPreviousResultId;
  const selectedStateKey = isPhaseEntry ? phaseStateKey : orderStateKey;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.productionStartOrderId !== orderId ||
    command.context?.productionStartPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    command.context?.productionStartPhaseId !== phaseId ||
    typeof orderPreviousResultId !== "string" ||
    orderPreviousResultId.trim().length === 0 ||
    typeof phasePreviousResultId !== "string" ||
    phasePreviousResultId.trim().length === 0 ||
    typeof orderStateKey !== "string" ||
    orderStateKey.trim().length === 0 ||
    typeof phaseStateKey !== "string" ||
    phaseStateKey.trim().length === 0 ||
    command.aggregateId !== selectedAggregateId ||
    command.currentStateResultId !== selectedPreviousResultId ||
    command.currentStateCommandKey !== selectedStateKey ||
    expectedOrder?.id !== orderId ||
    expectedOrder.phaseId !== phaseId ||
    expectedOrder.status !== "confirmed" ||
    expectedOrder.resultId !== orderPreviousResultId ||
    expectedOrder.currentStateCommandKey !== orderStateKey ||
    expectedOrder.immutable !== true ||
    expectedPhase?.id !== phaseId ||
    expectedPhase.orderId !== orderId ||
    expectedPhase.status !== "active" ||
    expectedPhase.resultId !== phasePreviousResultId ||
    expectedPhase.currentStateCommandKey !== phaseStateKey ||
    expectedPhase.immutable !== true
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
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const topologyId = command.context?.qcAuthoritativePhaseTopologyId;
  const expectedTopologyId = command.context?.qcExpectedPhaseTopologyId;
  const topologyValue = command.context?.qcExpectedPhaseTopology;
  const topology =
    typeof topologyValue === "object" &&
    topologyValue !== null &&
    !Array.isArray(topologyValue)
      ? (topologyValue as Readonly<Record<string, unknown>>)
      : undefined;
  const setId = command.context?.qcAuthoritativeFulfilmentSlotSetId;
  const expectedSetId = command.context?.qcExpectedFulfilmentSlotSetId;
  const setResultId = command.context?.qcAuthoritativeFulfilmentSlotSetResultId;
  const authoritativeValue = command.context?.qcAuthoritativeFulfilmentSlotSet;
  const authoritative =
    typeof authoritativeValue === "object" &&
    authoritativeValue !== null &&
    !Array.isArray(authoritativeValue)
      ? (authoritativeValue as Readonly<Record<string, unknown>>)
      : undefined;
  const authoritativeIdsValue = authoritative?.slotIds;
  const authoritativeIds = Array.isArray(authoritativeIdsValue)
    ? [...authoritativeIdsValue]
    : undefined;
  const expectedIdsValue = command.context?.expectedQcFulfilmentSlotIds;
  const slotsValue = command.context?.qcFulfilmentSlots;
  const expectedIds = Array.isArray(expectedIdsValue)
    ? [...expectedIdsValue]
    : undefined;
  const slots = Array.isArray(slotsValue) ? [...slotsValue] : undefined;
  const currentJobSourcesValue = authoritative?.currentJobSources;
  const currentJobSources = Array.isArray(currentJobSourcesValue)
    ? [...currentJobSourcesValue]
    : undefined;
  const resultId = context?.qcCompletionResultId;
  if (
    typeof topologyId !== "string" ||
    topologyId.trim().length === 0 ||
    topologyId !== phaseId ||
    expectedTopologyId !== topologyId ||
    topology?.id !== topologyId ||
    topology.orderId !== orderId ||
    topology.kind !== "single" ||
    topology.status !== command.current ||
    topology.authoritativeFulfilmentSlotSetId !== setId ||
    topology.authoritativeFulfilmentSlotSetResultId !== setResultId ||
    topology.immutable !== true ||
    typeof setId !== "string" ||
    setId.trim().length === 0 ||
    expectedSetId !== setId ||
    typeof setResultId !== "string" ||
    setResultId.trim().length === 0 ||
    authoritative?.id !== setId ||
    authoritative.orderId !== orderId ||
    authoritative.phaseId !== phaseId ||
    authoritative.phaseTopologyId !== topologyId ||
    authoritative.resultId !== setResultId ||
    authoritative.immutable !== true ||
    command.ownershipSnapshotId !== setId ||
    command.ownershipSnapshotResultId !== setResultId ||
    authoritativeIds === undefined ||
    authoritativeIds.length === 0 ||
    authoritativeIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(authoritativeIds).size !== authoritativeIds.length ||
    command.context?.qcSlotSetOrderId !== orderId ||
    command.context?.qcSlotSetPhaseId !== phaseId ||
    command.context?.qcSlotSetPhaseTopologyId !== topologyId ||
    expectedIds === undefined ||
    expectedIds.length === 0 ||
    expectedIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedIds).size !== expectedIds.length ||
    !hasSameNonEmptyStringSet(expectedIds, authoritativeIds) ||
    slots === undefined ||
    slots.length !== expectedIds.length ||
    !nonBlank(resultId) ||
    context?.qcCompletionOrderResultId !== resultId ||
    context?.qcCompletionPhaseResultId !== resultId ||
    currentJobSources === undefined ||
    currentJobSources.length !== authoritativeIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC completion requires the authoritative complete fulfilment slot set",
    );
  }
  const sourceBySlotId = new Map<string, Readonly<Record<string, unknown>>>();
  for (const value of currentJobSources) {
    const source = record(value);
    const slotId = source?.slotId;
    const jobId = source?.jobId;
    if (
      source === undefined ||
      !nonBlank(slotId) ||
      !nonBlank(jobId) ||
      sourceBySlotId.has(slotId) ||
      !authoritativeIds.includes(slotId) ||
      source.orderId !== orderId ||
      source.phaseId !== phaseId ||
      source.currentJobSlotId !== slotId ||
      source.currentJobLineageLeaf !== true ||
      !qcReadyJobStatuses.has(source.status as string) ||
      !nonBlank(source.resultId) ||
      !nonBlank(source.currentStateCommandKey) ||
      source.openReplacementRequestId !== null ||
      source.recoveryBlocked !== false ||
      source.immutable !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "QC readiness requires one immutable current Job source for every authoritative slot",
      );
    }
    sourceBySlotId.set(slotId, source);
  }
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
    const source = typeof id === "string" ? sourceBySlotId.get(id) : undefined;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      projectedIds.has(id) ||
      !authoritativeIds.includes(id) ||
      slot.authoritativeFulfilmentSlotSetId !== setId ||
      slot.authoritativePhaseTopologyId !== topologyId ||
      slot.orderId !== orderId ||
      slot.phaseId !== phaseId ||
      typeof currentJobId !== "string" ||
      currentJobId.trim().length === 0 ||
      source === undefined ||
      source.jobId !== currentJobId ||
      slot.currentJobSourceResultId !== source.resultId ||
      slot.currentJobSourceCommandKey !== source.currentStateCommandKey ||
      slot.currentJobImmutable !== true ||
      slot.qcCompletionResultId !== resultId ||
      slot.currentJobOrderId !== orderId ||
      slot.currentJobPhaseId !== phaseId ||
      slot.currentJobSlotId !== id ||
      slot.currentJobLineageLeaf !== true ||
      slot.currentJobStatus !== source.status ||
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
  if (
    authoritativeIds.some(
      (id) => !projectedIds.has(id) || !sourceBySlotId.has(id),
    )
  ) {
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
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const orderPreviousResultId = context?.qcCompletionOrderPreviousResultId;
  const phasePreviousResultId = context?.qcCompletionPhasePreviousResultId;
  const orderStateKey = context?.qcCompletionOrderCurrentStateCommandKey;
  const phaseStateKey = context?.qcCompletionPhaseCurrentStateCommandKey;
  const expectedOrderValue = context?.qcCompletionExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedPhaseValue = context?.qcCompletionExpectedPhase;
  const expectedPhase =
    typeof expectedPhaseValue === "object" &&
    expectedPhaseValue !== null &&
    !Array.isArray(expectedPhaseValue)
      ? (expectedPhaseValue as Readonly<Record<string, unknown>>)
      : undefined;
  const isPhaseEntry = lifecycle === "OrderPhase(single)";
  const selectedAggregateId = isPhaseEntry ? phaseId : orderId;
  const selectedPreviousResultId = isPhaseEntry
    ? phasePreviousResultId
    : orderPreviousResultId;
  const selectedStateKey = isPhaseEntry ? phaseStateKey : orderStateKey;
  if (
    command.aggregateId !== selectedAggregateId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    context?.qcCompletionOrderId !== orderId ||
    context?.qcCompletionPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    context?.qcCompletionPhaseId !== phaseId ||
    !nonBlank(orderPreviousResultId) ||
    !nonBlank(phasePreviousResultId) ||
    !nonBlank(orderStateKey) ||
    !nonBlank(phaseStateKey) ||
    command.currentStateResultId !== selectedPreviousResultId ||
    command.currentStateCommandKey !== selectedStateKey ||
    expectedOrder?.id !== orderId ||
    expectedOrder.phaseId !== phaseId ||
    expectedOrder.status !== previousStatus ||
    expectedOrder.resultId !== orderPreviousResultId ||
    expectedOrder.currentStateCommandKey !== orderStateKey ||
    expectedOrder.phaseTopologyId !== phaseId ||
    expectedOrder.immutable !== true ||
    expectedPhase?.id !== phaseId ||
    expectedPhase.orderId !== orderId ||
    expectedPhase.status !== previousStatus ||
    expectedPhase.resultId !== phasePreviousResultId ||
    expectedPhase.currentStateCommandKey !== phaseStateKey ||
    expectedPhase.phaseTopologyId !== phaseId ||
    expectedPhase.immutable !== true
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
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const orderPreviousResultId =
    command.context?.shipmentLineageOrderPreviousResultId;
  const orderStateKey =
    command.context?.shipmentLineageOrderCurrentStateCommandKey;
  const expectedOrderValue = command.context?.shipmentLineageExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const phasePreviousResultId =
    command.context?.shipmentLineagePhasePreviousResultId;
  const phaseStateKey =
    command.context?.shipmentLineagePhaseCurrentStateCommandKey;
  const expectedPhaseValue = command.context?.shipmentLineageExpectedPhase;
  const expectedPhase =
    typeof expectedPhaseValue === "object" &&
    expectedPhaseValue !== null &&
    !Array.isArray(expectedPhaseValue)
      ? (expectedPhaseValue as Readonly<Record<string, unknown>>)
      : undefined;
  const isPhaseEntry = lifecycle === "OrderPhase(single)";
  const setId = command.context?.shipmentLineageAuthoritativeSetId;
  const setResultId = command.context?.shipmentLineageAuthoritativeSetResultId;
  const setValue = command.context?.shipmentLineageAuthoritativeSet;
  const set =
    typeof setValue === "object" &&
    setValue !== null &&
    !Array.isArray(setValue)
      ? (setValue as Readonly<Record<string, unknown>>)
      : undefined;
  const shipmentIdsValue = set?.shipmentIds;
  const authoritativeIdsValue = set?.lineageLeafIds;
  const shipmentIds = Array.isArray(shipmentIdsValue)
    ? [...shipmentIdsValue]
    : undefined;
  const authoritativeIds = Array.isArray(authoritativeIdsValue)
    ? [...authoritativeIdsValue]
    : undefined;
  const authoritativeLeavesValue =
    command.context?.shipmentLineageAuthoritativeLeaves;
  const authoritativeLeaves = Array.isArray(authoritativeLeavesValue)
    ? [...authoritativeLeavesValue]
    : undefined;
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
    (isPhaseEntry
      ? !nonBlank(phasePreviousResultId) ||
        !nonBlank(phaseStateKey) ||
        command.aggregateId !== phaseId ||
        command.currentStateResultId !== phasePreviousResultId ||
        command.currentStateCommandKey !== phaseStateKey ||
        expectedPhase?.id !== phaseId ||
        expectedPhase.orderId !== orderId ||
        expectedPhase.status !== command.current ||
        expectedPhase.resultId !== phasePreviousResultId ||
        expectedPhase.currentStateCommandKey !== phaseStateKey ||
        expectedPhase.immutable !== true
      : !nonBlank(orderPreviousResultId) ||
        !nonBlank(orderStateKey) ||
        command.aggregateId !== orderId ||
        command.currentStateResultId !== orderPreviousResultId ||
        command.currentStateCommandKey !== orderStateKey ||
        expectedOrder?.id !== orderId ||
        expectedOrder.phaseId !== phaseId ||
        expectedOrder.status !== command.current ||
        expectedOrder.resultId !== orderPreviousResultId ||
        expectedOrder.currentStateCommandKey !== orderStateKey ||
        expectedOrder.immutable !== true) ||
    typeof setId !== "string" ||
    setId.trim().length === 0 ||
    typeof setResultId !== "string" ||
    setResultId.trim().length === 0 ||
    set?.id !== setId ||
    set.orderId !== orderId ||
    set.phaseId !== phaseId ||
    set.resultId !== setResultId ||
    set.immutable !== true ||
    shipmentIds === undefined ||
    authoritativeIds === undefined ||
    shipmentIds.length === 0 ||
    shipmentIds.length !== authoritativeIds.length ||
    shipmentIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    authoritativeIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(shipmentIds).size !== shipmentIds.length ||
    new Set(authoritativeIds).size !== authoritativeIds.length ||
    authoritativeLeaves === undefined ||
    authoritativeLeaves.length !== authoritativeIds.length ||
    expectedIds === undefined ||
    expectedIds.length === 0 ||
    expectedIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(expectedIds).size !== expectedIds.length ||
    !hasSameNonEmptyStringSet(expectedIds, authoritativeIds) ||
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
  const authoritativeShipmentByLeafId = new Map<string, string>();
  const projectedAuthoritativeShipmentIds = new Set<string>();
  for (const value of authoritativeLeaves) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "delivery requires immutable authoritative Shipment lineage records",
      );
    }
    const leaf = value as Readonly<Record<string, unknown>>;
    const shipmentId = leaf.shipmentId;
    const lineageLeafId = leaf.lineageLeafId;
    if (
      typeof shipmentId !== "string" ||
      !shipmentIds.includes(shipmentId) ||
      projectedAuthoritativeShipmentIds.has(shipmentId) ||
      typeof lineageLeafId !== "string" ||
      !authoritativeIds.includes(lineageLeafId) ||
      authoritativeShipmentByLeafId.has(lineageLeafId) ||
      leaf.orderId !== orderId ||
      leaf.phaseId !== phaseId ||
      leaf.status !== "delivered" ||
      leaf.currentLineageLeaf !== true ||
      leaf.resultId !== setResultId ||
      leaf.immutable !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "authoritative delivery topology must contain each exact current Shipment lineage leaf once",
      );
    }
    projectedAuthoritativeShipmentIds.add(shipmentId);
    authoritativeShipmentByLeafId.set(lineageLeafId, shipmentId);
  }
  if (
    shipmentIds.some((id) => !projectedAuthoritativeShipmentIds.has(id)) ||
    authoritativeIds.some((id) => !authoritativeShipmentByLeafId.has(id))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "authoritative delivery topology cannot omit a Shipment or lineage leaf",
    );
  }
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
      leaf.shipmentId !== authoritativeShipmentByLeafId.get(id as string) ||
      leaf.orderId !== orderId ||
      leaf.phaseId !== phaseId ||
      leaf.status !== "delivered" ||
      leaf.currentLineageLeaf !== true
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

function requireExactLateRefundSuccessReconciliation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  phase: "start" | "complete",
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const refundId = context?.refundTransactionId;
  const failureEventId = context?.lateRefundSuccessFailureProviderEventId;
  const successEventId = context?.refundCompletionProviderEventId;
  const provider = context?.lateRefundSuccessProvider;
  const providerTransactionId = context?.lateRefundSuccessProviderTransactionId;
  const amountMinor = context?.lateRefundSuccessAmountMinor;
  const currency = context?.lateRefundSuccessCurrency;
  const attemptKey = context?.lateRefundSuccessAttemptKey;
  const capturedAmountMinor = context?.lateRefundSuccessCapturedAmountMinor;
  const succeededBefore = context?.lateRefundSuccessSucceededBeforeMinor;
  const succeededAfter = context?.lateRefundSuccessSucceededAfterMinor;
  const refundSetBeforeId = context?.lateRefundSuccessRefundSetBeforeId;
  const refundSetBeforeResultId =
    context?.lateRefundSuccessRefundSetBeforeResultId;
  const refundSetAfterId = context?.lateRefundSuccessRefundSetAfterId;
  const refundSetAfterResultId =
    context?.lateRefundSuccessRefundSetAfterResultId;
  const sourceResultId = context?.lateRefundSuccessSourcePaymentResultId;
  const sourceStateKey = context?.lateRefundSuccessSourceCurrentStateCommandKey;
  const interimResultId = context?.refundCompletionPreviousPaymentResultId;
  const interimStateKey = context?.refundCompletionCurrentStateCommandKey;
  const finalResultId = context?.refundCompletionResultId;
  const sourcePayment = record(context?.lateRefundSuccessSourcePayment);
  const interimPayment = record(context?.refundCompletionExpectedPayment);
  const refund = record(context?.refundCompletionRefundTransaction);
  const failureEvent = record(context?.lateRefundSuccessFailureProviderEvent);
  const successEvent = record(context?.refundCompletionProviderEvent);
  const reconciledPayment = record(context?.lateRefundSuccessReconciledPayment);
  const parseRefundSet = (
    value: unknown,
    expectedId: unknown,
    expectedResultId: unknown,
  ) => {
    const snapshot = record(value);
    const refundIds = snapshot?.refundIds;
    const refunds = snapshot?.refundSnapshots;
    if (
      !nonBlank(expectedId) ||
      !nonBlank(expectedResultId) ||
      snapshot?.id !== expectedId ||
      snapshot.paymentId !== paymentId ||
      snapshot.resultId !== expectedResultId ||
      snapshot.immutable !== true ||
      !Array.isArray(refundIds) ||
      !Array.isArray(refunds) ||
      refundIds.length !== refunds.length ||
      refundIds.some((id) => !nonBlank(id)) ||
      new Set(refundIds).size !== refundIds.length
    ) {
      return undefined;
    }
    const rows = new Map<string, Readonly<Record<string, unknown>>>();
    let succeededAmountMinor = 0n;
    let pendingCount = 0;
    for (const value of refunds) {
      const row = record(value);
      const id = row?.id;
      const status = row?.status;
      const rowAmountMinor = row?.amountMinor;
      if (
        row === undefined ||
        !nonBlank(id) ||
        !refundIds.includes(id) ||
        rows.has(id) ||
        row.paymentId !== paymentId ||
        (status !== "pending" &&
          status !== "succeeded" &&
          status !== "failed") ||
        typeof rowAmountMinor !== "bigint" ||
        rowAmountMinor <= 0n ||
        !nonBlank(row.resultId) ||
        row.immutable !== true
      ) {
        return undefined;
      }
      rows.set(id, row);
      if (status === "succeeded") succeededAmountMinor += rowAmountMinor;
      if (status === "pending") pendingCount += 1;
    }
    if (refundIds.some((id) => !rows.has(id))) return undefined;
    return { pendingCount, rows, succeededAmountMinor };
  };
  const refundSetBefore = parseRefundSet(
    context?.lateRefundSuccessRefundSetBefore,
    refundSetBeforeId,
    refundSetBeforeResultId,
  );
  const refundSetAfter = parseRefundSet(
    context?.lateRefundSuccessRefundSetAfter,
    refundSetAfterId,
    refundSetAfterResultId,
  );
  let exactRefundSetTransition = false;
  if (
    refundSetBefore !== undefined &&
    refundSetAfter !== undefined &&
    refundSetBefore.rows.size === refundSetAfter.rows.size &&
    refundSetBefore.rows.has(refundId as string) &&
    refundSetAfter.rows.has(refundId as string)
  ) {
    exactRefundSetTransition = true;
    for (const [id, before] of refundSetBefore.rows) {
      const after = refundSetAfter.rows.get(id);
      if (
        after === undefined ||
        after.paymentId !== before.paymentId ||
        after.amountMinor !== before.amountMinor ||
        after.immutable !== true ||
        (id === refundId
          ? before.status !== "failed" ||
            before.amountMinor !== amountMinor ||
            before.resultId !== failureEventId ||
            after.status !== "succeeded" ||
            after.resultId !== finalResultId
          : after.status !== before.status ||
            after.resultId !== before.resultId)
      ) {
        exactRefundSetTransition = false;
        break;
      }
    }
  }
  const failureVerifiedAt = failureEvent?.verifiedAt;
  const successVerifiedAt = successEvent?.verifiedAt;
  const refundCompletedAt = refund?.completedAt;
  const derivedSucceededBefore = refundSetBefore?.succeededAmountMinor;
  const derivedSucceededAfter = refundSetAfter?.succeededAmountMinor;
  const expectedSource =
    derivedSucceededBefore === 0n ? "captured" : "partially_refunded";
  const expectedTarget =
    derivedSucceededAfter === capturedAmountMinor
      ? "refunded"
      : "partially_refunded";

  if (
    context?.paymentCaptureKind !== "late_refund_success" ||
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit" && role !== "balance") ||
    !nonBlank(refundId) ||
    !nonBlank(failureEventId) ||
    !nonBlank(successEventId) ||
    failureEventId === successEventId ||
    !nonBlank(provider) ||
    !nonBlank(providerTransactionId) ||
    typeof amountMinor !== "bigint" ||
    amountMinor <= 0n ||
    !nonBlank(currency) ||
    !nonBlank(attemptKey) ||
    typeof capturedAmountMinor !== "bigint" ||
    capturedAmountMinor <= 0n ||
    !exactRefundSetTransition ||
    refundSetBefore?.pendingCount !== 0 ||
    refundSetAfter?.pendingCount !== 0 ||
    derivedSucceededBefore === undefined ||
    derivedSucceededBefore < 0n ||
    derivedSucceededAfter === undefined ||
    derivedSucceededAfter !== derivedSucceededBefore + amountMinor ||
    derivedSucceededAfter > capturedAmountMinor ||
    typeof succeededBefore !== "bigint" ||
    succeededBefore !== derivedSucceededBefore ||
    typeof succeededAfter !== "bigint" ||
    succeededAfter !== derivedSucceededAfter ||
    !nonBlank(refundSetBeforeId) ||
    !nonBlank(refundSetBeforeResultId) ||
    !nonBlank(refundSetAfterId) ||
    !nonBlank(refundSetAfterResultId) ||
    refundSetBeforeId === refundSetAfterId ||
    refundSetBeforeResultId === refundSetAfterResultId ||
    !nonBlank(sourceResultId) ||
    !nonBlank(sourceStateKey) ||
    !nonBlank(interimResultId) ||
    !nonBlank(interimStateKey) ||
    !nonBlank(finalResultId) ||
    command.aggregateId !== paymentId ||
    (phase === "start" &&
      (command.current !== expectedSource ||
        command.target !== "refund_pending" ||
        command.currentStateResultId !== sourceResultId ||
        command.currentStateCommandKey !== sourceStateKey)) ||
    (phase === "complete" &&
      (command.current !== "refund_pending" ||
        command.target !== expectedTarget ||
        command.currentStateResultId !== interimResultId ||
        command.currentStateCommandKey !== interimStateKey)) ||
    sourcePayment?.id !== paymentId ||
    sourcePayment.orderId !== orderId ||
    sourcePayment.phaseId !== phaseId ||
    sourcePayment.role !== role ||
    sourcePayment.status !== expectedSource ||
    sourcePayment.capturedAmountMinor !== capturedAmountMinor ||
    sourcePayment.succeededRefundAmountMinor !== succeededBefore ||
    sourcePayment.failedRefundTransactionId !== refundId ||
    sourcePayment.authoritativeRefundSetId !== refundSetBeforeId ||
    sourcePayment.authoritativeRefundSetResultId !== refundSetBeforeResultId ||
    sourcePayment.resultId !== sourceResultId ||
    sourcePayment.currentStateCommandKey !== sourceStateKey ||
    sourcePayment.immutable !== true ||
    interimPayment?.id !== paymentId ||
    interimPayment.orderId !== orderId ||
    interimPayment.phaseId !== phaseId ||
    interimPayment.role !== role ||
    interimPayment.status !== "refund_pending" ||
    interimPayment.activeRefundTransactionId !== refundId ||
    interimPayment.capturedAmountMinor !== capturedAmountMinor ||
    interimPayment.succeededRefundAmountMinor !== succeededAfter ||
    interimPayment.authoritativeRefundSetId !== refundSetAfterId ||
    interimPayment.authoritativeRefundSetResultId !== refundSetAfterResultId ||
    interimPayment.resultId !== interimResultId ||
    interimPayment.currentStateCommandKey !== interimStateKey ||
    interimPayment.immutable !== true ||
    refund?.id !== refundId ||
    refund.paymentId !== paymentId ||
    refund.orderId !== orderId ||
    refund.phaseId !== phaseId ||
    refund.previousStatus !== "failed" ||
    refund.targetStatus !== "succeeded" ||
    refund.status !== "succeeded" ||
    refund.provider !== provider ||
    refund.providerTransactionId !== providerTransactionId ||
    refund.amountMinor !== amountMinor ||
    refund.currency !== currency ||
    refund.idempotencyKey !== attemptKey ||
    refund.failureProviderEventId !== failureEventId ||
    refund.providerEventId !== successEventId ||
    !(refundCompletedAt instanceof Instant) ||
    refund.resultId !== finalResultId ||
    refund.immutable !== true ||
    failureEvent?.id !== failureEventId ||
    failureEvent.paymentId !== paymentId ||
    failureEvent.refundTransactionId !== refundId ||
    failureEvent.provider !== provider ||
    failureEvent.providerTransactionId !== providerTransactionId ||
    failureEvent.kind !== "refund_failed" ||
    failureEvent.amountMinor !== amountMinor ||
    failureEvent.currency !== currency ||
    failureEvent.authenticated !== true ||
    failureEvent.verified !== true ||
    !(failureVerifiedAt instanceof Instant) ||
    failureEvent.immutable !== true ||
    successEvent?.id !== successEventId ||
    successEvent.paymentId !== paymentId ||
    successEvent.refundTransactionId !== refundId ||
    successEvent.provider !== provider ||
    successEvent.providerTransactionId !== providerTransactionId ||
    successEvent.kind !== "refund_succeeded" ||
    successEvent.amountMinor !== amountMinor ||
    successEvent.currency !== currency ||
    successEvent.status !== "succeeded" ||
    successEvent.projectedTarget !== expectedTarget ||
    successEvent.authenticated !== true ||
    successEvent.verified !== true ||
    !(successVerifiedAt instanceof Instant) ||
    successEvent.resultId !== finalResultId ||
    successEvent.immutable !== true ||
    failureVerifiedAt.compare(successVerifiedAt) >= 0 ||
    !refundCompletedAt.equals(successVerifiedAt) ||
    reconciledPayment?.id !== paymentId ||
    reconciledPayment.orderId !== orderId ||
    reconciledPayment.phaseId !== phaseId ||
    reconciledPayment.role !== role ||
    reconciledPayment.previousStatus !== expectedSource ||
    reconciledPayment.intermediateStatus !== "refund_pending" ||
    reconciledPayment.targetStatus !== expectedTarget ||
    reconciledPayment.capturedAmountMinor !== capturedAmountMinor ||
    reconciledPayment.succeededRefundAmountMinor !== succeededAfter ||
    reconciledPayment.refundTransactionId !== refundId ||
    reconciledPayment.authoritativeRefundSetId !== refundSetAfterId ||
    reconciledPayment.authoritativeRefundSetResultId !==
      refundSetAfterResultId ||
    reconciledPayment.resultId !== finalResultId ||
    reconciledPayment.immutable !== true ||
    context?.lateRefundSuccessPaymentResultId !== finalResultId ||
    context?.lateRefundSuccessRefundTransactionResultId !== finalResultId ||
    context?.lateRefundSuccessProviderEventResultId !== finalResultId ||
    context?.lateRefundSuccessCompleted !== true ||
    context?.lateRefundSuccessAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "late refund success requires the exact failed attempt, matching provider receipts, authoritative refund-set change, and atomic Payment projection",
    );
  }
}

function requireExactPaymentRefundCompletion<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const refundTransactionId = context?.refundTransactionId;
  const providerEventId = context?.refundCompletionProviderEventId;
  const previousResultId = context?.refundCompletionPreviousPaymentResultId;
  const resultId = context?.refundCompletionResultId;
  const stateKey = context?.refundCompletionCurrentStateCommandKey;
  const refundSetBeforeId = context?.refundCompletionRefundSetBeforeId;
  const refundSetBeforeResultId =
    context?.refundCompletionRefundSetBeforeResultId;
  const refundSetAfterId = context?.refundCompletionRefundSetAfterId;
  const refundSetAfterResultId =
    context?.refundCompletionRefundSetAfterResultId;
  const expected = record(context?.refundCompletionExpectedPayment);
  const reconciled = record(context?.refundCompletionReconciledPayment);
  const refund = record(context?.refundCompletionRefundTransaction);
  const event = record(context?.refundCompletionProviderEvent);
  const lateSuccess = context?.paymentCaptureKind === "late_refund_success";
  if (lateSuccess) {
    requireExactLateRefundSuccessReconciliation(lifecycle, command, "complete");
    return;
  }
  const parseRefundSet = (
    value: unknown,
    expectedId: unknown,
    expectedResultId: unknown,
  ) => {
    const snapshot = record(value);
    const refundIds = snapshot?.refundIds;
    const refunds = snapshot?.refundSnapshots;
    if (
      !nonBlank(expectedId) ||
      !nonBlank(expectedResultId) ||
      snapshot?.id !== expectedId ||
      snapshot.paymentId !== paymentId ||
      snapshot.resultId !== expectedResultId ||
      snapshot.immutable !== true ||
      !Array.isArray(refundIds) ||
      !Array.isArray(refunds) ||
      refundIds.length !== refunds.length ||
      refundIds.some((id) => !nonBlank(id)) ||
      new Set(refundIds).size !== refundIds.length
    ) {
      return undefined;
    }
    const rows = new Map<string, Readonly<Record<string, unknown>>>();
    let succeededAmountMinor = 0n;
    let pendingCount = 0;
    for (const value of refunds) {
      const row = record(value);
      const id = row?.id;
      const status = row?.status;
      const amountMinor = row?.amountMinor;
      if (
        row === undefined ||
        !nonBlank(id) ||
        !refundIds.includes(id) ||
        rows.has(id) ||
        row.paymentId !== paymentId ||
        (status !== "pending" &&
          status !== "succeeded" &&
          status !== "failed") ||
        typeof amountMinor !== "bigint" ||
        amountMinor <= 0n ||
        !nonBlank(row.resultId) ||
        row.immutable !== true
      ) {
        return undefined;
      }
      rows.set(id, row);
      if (status === "succeeded") succeededAmountMinor += amountMinor;
      if (status === "pending") pendingCount += 1;
    }
    if (refundIds.some((id) => !rows.has(id))) return undefined;
    return { pendingCount, rows, succeededAmountMinor };
  };
  const refundSetBefore = parseRefundSet(
    context?.refundCompletionRefundSetBefore,
    refundSetBeforeId,
    refundSetBeforeResultId,
  );
  const refundSetAfter = parseRefundSet(
    context?.refundCompletionRefundSetAfter,
    refundSetAfterId,
    refundSetAfterResultId,
  );
  const refundAmountMinor = refund?.amountMinor;
  const refundPreviousResultId = refund?.previousResultId;
  let exactRefundSetTransition = false;
  if (
    refundSetBefore !== undefined &&
    refundSetAfter !== undefined &&
    refundSetBefore.rows.size === refundSetAfter.rows.size &&
    nonBlank(refundTransactionId) &&
    refundSetBefore.rows.has(refundTransactionId) &&
    refundSetAfter.rows.has(refundTransactionId)
  ) {
    exactRefundSetTransition = true;
    for (const [id, before] of refundSetBefore.rows) {
      const after = refundSetAfter.rows.get(id);
      if (
        after === undefined ||
        after.paymentId !== before.paymentId ||
        after.amountMinor !== before.amountMinor ||
        after.immutable !== true ||
        (id === refundTransactionId
          ? before.status !== "pending" ||
            before.amountMinor !== refundAmountMinor ||
            before.resultId !== refundPreviousResultId ||
            after.status !== "succeeded" ||
            after.resultId !== resultId
          : after.status !== before.status ||
            after.resultId !== before.resultId)
      ) {
        exactRefundSetTransition = false;
        break;
      }
    }
  }
  const capturedAmountMinor = expected?.capturedAmountMinor;
  const succeededBefore = refundSetBefore?.succeededAmountMinor;
  const succeededAfter = refundSetAfter?.succeededAmountMinor;
  const expectedTarget =
    typeof capturedAmountMinor === "bigint" &&
    succeededAfter === capturedAmountMinor
      ? "refunded"
      : typeof capturedAmountMinor === "bigint" &&
          succeededAfter !== undefined &&
          succeededAfter > 0n &&
          succeededAfter < capturedAmountMinor
        ? "partially_refunded"
        : undefined;
  const provider = expected?.provider;
  const currency = expected?.currency;
  const providerTransactionId = refund?.providerTransactionId;
  const requestedAt = refund?.requestedAt;
  const completedAt = refund?.completedAt;
  const occurredAt = event?.occurredAt;
  const authenticatedAt = event?.authenticatedAt;
  const verifiedAt = event?.verifiedAt;
  if (
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit" && role !== "balance") ||
    !nonBlank(refundTransactionId) ||
    !nonBlank(providerEventId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(resultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(provider) ||
    !nonBlank(providerTransactionId) ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency) ||
    typeof refundAmountMinor !== "bigint" ||
    refundAmountMinor <= 0n ||
    !nonBlank(refundPreviousResultId) ||
    typeof capturedAmountMinor !== "bigint" ||
    capturedAmountMinor <= 0n ||
    !exactRefundSetTransition ||
    refundSetBefore?.pendingCount !== 1 ||
    refundSetAfter?.pendingCount !== 0 ||
    succeededBefore === undefined ||
    succeededBefore < 0n ||
    succeededAfter === undefined ||
    succeededAfter !== succeededBefore + refundAmountMinor ||
    succeededAfter > capturedAmountMinor ||
    expectedTarget === undefined ||
    !nonBlank(refundSetBeforeId) ||
    !nonBlank(refundSetBeforeResultId) ||
    !nonBlank(refundSetAfterId) ||
    !nonBlank(refundSetAfterResultId) ||
    refundSetBeforeId === refundSetAfterId ||
    refundSetBeforeResultId === refundSetAfterResultId ||
    command.aggregateId !== paymentId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    context?.refundWebhookPaymentId !== paymentId ||
    context?.refundWebhookRefundTransactionId !== refundTransactionId ||
    context?.refundWebhookStatus !== "succeeded" ||
    context?.refundWebhookProjectedTarget !== expectedTarget ||
    context?.refundWebhookAuthenticated !== true ||
    context?.refundWebhookVerified !== true ||
    expected?.id !== paymentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.role !== role ||
    expected.provider !== provider ||
    expected.currency !== currency ||
    expected.status !== "refund_pending" ||
    expected.activeRefundTransactionId !== refundTransactionId ||
    expected.succeededRefundAmountMinor !== succeededBefore ||
    expected.authoritativeRefundSetId !== refundSetBeforeId ||
    expected.authoritativeRefundSetResultId !== refundSetBeforeResultId ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true ||
    reconciled?.id !== paymentId ||
    reconciled.orderId !== orderId ||
    reconciled.phaseId !== phaseId ||
    reconciled.role !== role ||
    reconciled.provider !== provider ||
    reconciled.currency !== currency ||
    reconciled.previousStatus !== "refund_pending" ||
    reconciled.targetStatus !== expectedTarget ||
    reconciled.activeRefundTransactionId !== null ||
    reconciled.capturedAmountMinor !== capturedAmountMinor ||
    reconciled.succeededRefundAmountMinor !== succeededAfter ||
    reconciled.refundTransactionId !== refundTransactionId ||
    reconciled.authoritativeRefundSetId !== refundSetAfterId ||
    reconciled.authoritativeRefundSetResultId !== refundSetAfterResultId ||
    reconciled.resultId !== resultId ||
    reconciled.immutable !== true ||
    refund?.id !== refundTransactionId ||
    refund.paymentId !== paymentId ||
    refund.orderId !== orderId ||
    refund.phaseId !== phaseId ||
    refund.previousStatus !== "pending" ||
    refund.targetStatus !== "succeeded" ||
    refund.status !== "succeeded" ||
    refund.provider !== provider ||
    refund.currency !== currency ||
    refund.providerEventId !== providerEventId ||
    !(requestedAt instanceof Instant) ||
    !(completedAt instanceof Instant) ||
    completedAt.epochMilliseconds < requestedAt.epochMilliseconds - 5_000 ||
    refund.resultId !== resultId ||
    refund.immutable !== true ||
    event?.id !== providerEventId ||
    event.paymentId !== paymentId ||
    event.refundTransactionId !== refundTransactionId ||
    event.provider !== provider ||
    event.providerTransactionId !== providerTransactionId ||
    event.kind !== "refund_succeeded" ||
    event.amountMinor !== refundAmountMinor ||
    event.currency !== currency ||
    event.status !== "succeeded" ||
    event.projectedTarget !== expectedTarget ||
    event.authenticated !== true ||
    event.verified !== true ||
    !(occurredAt instanceof Instant) ||
    !(authenticatedAt instanceof Instant) ||
    !(verifiedAt instanceof Instant) ||
    occurredAt.epochMilliseconds < requestedAt.epochMilliseconds - 5_000 ||
    authenticatedAt.epochMilliseconds < occurredAt.epochMilliseconds - 5_000 ||
    verifiedAt.compare(authenticatedAt) < 0 ||
    !completedAt.equals(verifiedAt) ||
    event.resultId !== resultId ||
    event.immutable !== true ||
    command.target !== expectedTarget ||
    context?.refundCompletionPaymentResultId !== resultId ||
    context?.refundCompletionRefundTransactionResultId !== resultId ||
    context?.refundCompletionProviderEventResultId !== resultId ||
    context?.refundCompletionCompleted !== true ||
    context?.refundCompletionAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "refund completion requires the command-selected Payment, its exact RefundTransaction, provider event, and atomic result",
    );
  }
}

function requireExactRefundFailureRollback<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const refundTransactionId = context?.refundFailureTransactionId;
  const providerEventId = context?.refundFailureProviderEventId;
  const provider = context?.refundFailureProvider;
  const providerTransactionId = context?.refundFailureProviderTransactionId;
  const amountMinor = context?.refundFailureAmountMinor;
  const currency = context?.refundFailureCurrency;
  const previousResultId =
    context?.refundFailureRollbackPreviousPaymentResultId;
  const stateKey = context?.refundFailureRollbackCurrentStateCommandKey;
  const resultId = context?.refundFailureRollbackResultId;
  const attemptKey = context?.refundFailureAttemptKey;
  const capturedAmountMinor = context?.refundFailureCapturedAmountMinor;
  const succeededAmountMinor = context?.refundFailureSucceededAmountMinor;
  const expectedTarget =
    typeof succeededAmountMinor === "bigint" && succeededAmountMinor === 0n
      ? "captured"
      : "partially_refunded";
  const expectedPayment = record(context?.refundFailureRollbackExpectedPayment);
  const restoredPayment = record(context?.refundFailureRollbackRestoredPayment);
  const refundTransaction = record(
    context?.refundFailureRollbackRefundTransaction,
  );
  const failure = record(context?.refundFailureProviderEvidence);

  if (
    command.target === "captured" &&
    typeof expectedPayment?.providerFailureEventId === "string" &&
    expectedPayment.providerFailureEventId.trim().length > 0
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "failed-source late capture must retain compensation provenance and retry its refund",
    );
  }

  if (
    context?.paymentCaptureKind !== "refund_failure_rollback" ||
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit" && role !== "balance") ||
    !nonBlank(refundTransactionId) ||
    !nonBlank(providerEventId) ||
    !nonBlank(provider) ||
    !nonBlank(providerTransactionId) ||
    typeof amountMinor !== "bigint" ||
    amountMinor <= 0n ||
    !nonBlank(currency) ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(resultId) ||
    !nonBlank(attemptKey) ||
    typeof capturedAmountMinor !== "bigint" ||
    capturedAmountMinor <= 0n ||
    typeof succeededAmountMinor !== "bigint" ||
    succeededAmountMinor < 0n ||
    succeededAmountMinor >= capturedAmountMinor ||
    (command.target !== "captured" &&
      command.target !== "partially_refunded") ||
    command.target !== expectedTarget ||
    context?.refundFailureRollbackTargetStatus !== expectedTarget ||
    command.aggregateId !== paymentId ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedPayment?.id !== paymentId ||
    !Object.prototype.hasOwnProperty.call(
      expectedPayment,
      "providerFailureEventId",
    ) ||
    (expectedPayment.providerFailureEventId !== null &&
      !nonBlank(expectedPayment.providerFailureEventId)) ||
    expectedPayment.orderId !== orderId ||
    expectedPayment.phaseId !== phaseId ||
    expectedPayment.role !== role ||
    expectedPayment.provider !== provider ||
    expectedPayment.currency !== currency ||
    expectedPayment.status !== "refund_pending" ||
    expectedPayment.activeRefundTransactionId !== refundTransactionId ||
    expectedPayment.capturedAmountMinor !== capturedAmountMinor ||
    expectedPayment.succeededRefundAmountMinor !== succeededAmountMinor ||
    expectedPayment.resultId !== previousResultId ||
    expectedPayment.currentStateCommandKey !== stateKey ||
    expectedPayment.immutable !== true ||
    restoredPayment?.id !== paymentId ||
    !Object.prototype.hasOwnProperty.call(
      restoredPayment,
      "providerFailureEventId",
    ) ||
    restoredPayment.providerFailureEventId !==
      expectedPayment.providerFailureEventId ||
    restoredPayment.orderId !== orderId ||
    restoredPayment.phaseId !== phaseId ||
    restoredPayment.role !== role ||
    restoredPayment.provider !== provider ||
    restoredPayment.currency !== currency ||
    restoredPayment.previousStatus !== "refund_pending" ||
    restoredPayment.targetStatus !== expectedTarget ||
    restoredPayment.capturedAmountMinor !== capturedAmountMinor ||
    restoredPayment.succeededRefundAmountMinor !== succeededAmountMinor ||
    restoredPayment.resultId !== resultId ||
    restoredPayment.immutable !== true ||
    refundTransaction?.id !== refundTransactionId ||
    refundTransaction.paymentId !== paymentId ||
    refundTransaction.provider !== provider ||
    refundTransaction.providerRefundId !== providerTransactionId ||
    refundTransaction.amountMinor !== amountMinor ||
    refundTransaction.status !== "failed" ||
    refundTransaction.idempotencyKey !== attemptKey ||
    refundTransaction.resultId !== resultId ||
    refundTransaction.immutable !== true ||
    failure?.id !== providerEventId ||
    failure.paymentId !== paymentId ||
    failure.refundTransactionId !== refundTransactionId ||
    failure.provider !== provider ||
    failure.providerTransactionId !== providerTransactionId ||
    failure.kind !== "REFUND_FAILED" ||
    failure.amountMinor !== amountMinor ||
    failure.currency !== currency ||
    failure.attemptKey !== attemptKey ||
    failure.outcome !== "failed" ||
    failure.authenticated !== true ||
    failure.verified !== true ||
    failure.resultId !== resultId ||
    failure.immutable !== true ||
    context?.refundFailureRollbackPaymentResultId !== resultId ||
    context?.refundFailureRollbackTransactionResultId !== resultId ||
    context?.refundFailureRollbackEvidenceResultId !== resultId ||
    context?.refundFailureLatestTransactionId !== refundTransactionId ||
    context?.refundFailureSucceededRefundSetComplete !== true ||
    context?.refundFailureNoPendingRefunds !== true ||
    context?.refundFailureNoSuccessfulRefunds !==
      (succeededAmountMinor === 0n) ||
    context?.refundFailureRollbackCompleted !== true ||
    context?.refundFailureRollbackAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "refund failure rollback requires the exact Payment restoration, failed latest RefundTransaction, provider failure, financial totals, and atomic result",
    );
  }
}

function requireBalancePaymentDeadlineSetup<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  bindCommandToOrder = false,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const paymentId = context?.balancePaymentId;
  const scheduleId = context?.balanceDeadlineSetupScheduleId;
  const resultId = context?.balanceDeadlineSetupResultId;
  const createdAt = context?.balanceDeadlineSetupCreatedAt;
  const qcApprovedAt = context?.balanceDeadlineSetupQcApprovedAt;
  const paymentDays = context?.balanceDeadlineSetupPaymentDays;
  const balanceDueAt = context?.balanceDueAt;
  const orderValue = context?.balanceDeadlineSetupOrder;
  const order =
    typeof orderValue === "object" &&
    orderValue !== null &&
    !Array.isArray(orderValue)
      ? (orderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const previousOrderResultId =
    context?.balanceDeadlineSetupPreviousOrderResultId;
  const orderStateKey = context?.balanceDeadlineSetupCurrentStateCommandKey;
  const expectedOrderValue = context?.balanceDeadlineSetupExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const phaseValue = context?.balanceDeadlineSetupPhase;
  const phase =
    typeof phaseValue === "object" &&
    phaseValue !== null &&
    !Array.isArray(phaseValue)
      ? (phaseValue as Readonly<Record<string, unknown>>)
      : undefined;
  const paymentValue = context?.balanceDeadlineSetupPayment;
  const payment =
    typeof paymentValue === "object" &&
    paymentValue !== null &&
    !Array.isArray(paymentValue)
      ? (paymentValue as Readonly<Record<string, unknown>>)
      : undefined;
  const scheduleValue = context?.balanceDeadlineSetupSchedule;
  const schedule =
    typeof scheduleValue === "object" &&
    scheduleValue !== null &&
    !Array.isArray(scheduleValue)
      ? (scheduleValue as Readonly<Record<string, unknown>>)
      : undefined;
  const deadlineValue = context?.balanceDeadlineSetupDeadline;
  const deadline =
    typeof deadlineValue === "object" &&
    deadlineValue !== null &&
    !Array.isArray(deadlineValue)
      ? (deadlineValue as Readonly<Record<string, unknown>>)
      : undefined;
  const scheduleDueAt = schedule?.dueAt;
  const deadlineDueAt = deadline?.dueAt;
  if (
    !nonBlank(orderId) ||
    (bindCommandToOrder && command.aggregateId !== orderId) ||
    (bindCommandToOrder &&
      (!nonBlank(previousOrderResultId) ||
        !nonBlank(orderStateKey) ||
        command.currentStateResultId !== previousOrderResultId ||
        command.currentStateCommandKey !== orderStateKey ||
        expectedOrder?.id !== orderId ||
        expectedOrder.phaseId !== phaseId ||
        expectedOrder.status !== "qc_passed" ||
        expectedOrder.resultId !== previousOrderResultId ||
        expectedOrder.currentStateCommandKey !== orderStateKey ||
        expectedOrder.immutable !== true)) ||
    !nonBlank(phaseId) ||
    !nonBlank(paymentId) ||
    !nonBlank(scheduleId) ||
    !nonBlank(resultId) ||
    !(createdAt instanceof Instant) ||
    !(qcApprovedAt instanceof Instant) ||
    typeof paymentDays !== "number" ||
    !Number.isSafeInteger(paymentDays) ||
    paymentDays <= 0 ||
    !(balanceDueAt instanceof Instant) ||
    createdAt.compare(balanceDueAt) >= 0 ||
    qcApprovedAt.epochMilliseconds + paymentDays * 86_400_000 !==
      balanceDueAt.epochMilliseconds ||
    context?.balanceDeadlineSetupOrderId !== orderId ||
    context?.balanceDeadlineSetupPhaseId !== phaseId ||
    context?.balanceDeadlineSetupPaymentId !== paymentId ||
    context?.balanceDeadlineSetupOrderPreviousStatus !== "qc_passed" ||
    context?.balanceDeadlineSetupOrderTargetStatus !== "awaiting_balance" ||
    context?.balanceDeadlineSetupPhasePreviousStatus !== "qc_passed" ||
    context?.balanceDeadlineSetupPhaseTargetStatus !== "qc_passed" ||
    context?.balanceDeadlineSetupOrderResultId !== resultId ||
    context?.balanceDeadlineSetupPhaseResultId !== resultId ||
    context?.balanceDeadlineSetupPaymentResultId !== resultId ||
    context?.balanceDeadlineSetupScheduleResultId !== resultId ||
    context?.balanceDeadlineSetupDeadlineResultId !== resultId ||
    order?.id !== orderId ||
    order.phaseId !== phaseId ||
    order.balancePaymentId !== paymentId ||
    order.balanceDeadlineScheduleId !== scheduleId ||
    !(order.qcApprovedAt instanceof Instant) ||
    !order.qcApprovedAt.equals(qcApprovedAt) ||
    order.balancePaymentDays !== paymentDays ||
    order.previousStatus !== "qc_passed" ||
    order.targetStatus !== "awaiting_balance" ||
    order.resultId !== resultId ||
    phase?.id !== phaseId ||
    phase.orderId !== orderId ||
    phase.previousStatus !== "qc_passed" ||
    phase.targetStatus !== "qc_passed" ||
    phase.resultId !== resultId ||
    payment?.id !== paymentId ||
    payment.orderId !== orderId ||
    payment.phaseId !== phaseId ||
    payment.role !== "balance" ||
    payment.status !== "pending" ||
    payment.resultId !== resultId ||
    schedule?.id !== scheduleId ||
    schedule.paymentId !== paymentId ||
    schedule.orderId !== orderId ||
    schedule.phaseId !== phaseId ||
    schedule.status !== "scheduled" ||
    schedule.immutable !== true ||
    schedule.resultId !== resultId ||
    !(scheduleDueAt instanceof Instant) ||
    !scheduleDueAt.equals(balanceDueAt) ||
    deadline?.orderId !== orderId ||
    deadline.phaseId !== phaseId ||
    deadline.paymentId !== paymentId ||
    deadline.scheduleId !== scheduleId ||
    deadline.resultId !== resultId ||
    !(deadlineDueAt instanceof Instant) ||
    !deadlineDueAt.equals(balanceDueAt) ||
    context?.balanceDeadlineSetupCompleted !== true ||
    context?.balanceDeadlineSetupAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "awaiting balance requires one exact atomic Order, phase, Payment, schedule, and deadline result",
    );
  }
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

function requireExactPaymentIntentCreationFailure<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const previousResultId = context?.paymentIntentFailurePreviousPaymentResultId;
  const stateKey = context?.paymentIntentFailureCurrentStateCommandKey;
  const resultId = context?.paymentIntentFailureResultId;
  const attemptKey = context?.paymentIntentFailureAttemptKey;
  const failureId = context?.paymentIntentFailureEvidenceId;
  const provider = context?.paymentIntentFailureProvider;
  const expectedPayment = record(context?.paymentIntentFailureExpectedPayment);
  const failedPayment = record(context?.paymentIntentFailureFailedPayment);
  const failure = record(context?.paymentIntentFailureEvidence);
  const captureCutoffAt = failedPayment?.captureCutoffAt;
  const failedAt = failure?.failedAt;

  if (
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit" && role !== "balance") ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(resultId) ||
    !nonBlank(attemptKey) ||
    !nonBlank(failureId) ||
    !nonBlank(provider) ||
    command.aggregateId !== paymentId ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedPayment?.id !== paymentId ||
    expectedPayment.orderId !== orderId ||
    expectedPayment.phaseId !== phaseId ||
    expectedPayment.role !== role ||
    expectedPayment.provider !== provider ||
    expectedPayment.status !== "created" ||
    expectedPayment.providerIntentId !== null ||
    expectedPayment.resultId !== previousResultId ||
    expectedPayment.currentStateCommandKey !== stateKey ||
    expectedPayment.immutable !== true ||
    failedPayment?.id !== paymentId ||
    failedPayment.orderId !== orderId ||
    failedPayment.phaseId !== phaseId ||
    failedPayment.role !== role ||
    failedPayment.provider !== provider ||
    failedPayment.previousStatus !== "created" ||
    failedPayment.targetStatus !== "failed" ||
    failedPayment.providerIntentId !== null ||
    failedPayment.intentCreationFailureResultId !== failureId ||
    failedPayment.captureAuthorized !== false ||
    !(captureCutoffAt instanceof Instant) ||
    failedPayment.resultId !== resultId ||
    failedPayment.immutable !== true ||
    failure?.id !== failureId ||
    failure.paymentId !== paymentId ||
    failure.provider !== provider ||
    failure.attemptKey !== attemptKey ||
    failure.outcome !== "failed" ||
    failure.providerIntentId !== null ||
    !(failedAt instanceof Instant) ||
    !(captureCutoffAt instanceof Instant && captureCutoffAt.equals(failedAt)) ||
    failure.resultId !== resultId ||
    failure.immutable !== true ||
    context?.paymentIntentFailurePaymentResultId !== resultId ||
    context?.paymentIntentFailureEvidenceResultId !== resultId ||
    context?.paymentIntentFailureCompleted !== true ||
    context?.paymentIntentFailureAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Payment intent creation failure requires the exact created Payment, durable provider attempt failure, and atomic result",
    );
  }
}

function requireExactPendingPaymentFailure<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const providerEventId = context?.paymentFailureProviderEventId;
  const providerTransactionId = context?.providerPaymentTransactionId;
  const previousResultId = context?.paymentFailurePreviousPaymentResultId;
  const resultId = context?.paymentFailureResultId;
  const stateKey = context?.paymentFailureCurrentStateCommandKey;
  const expectedValue = context?.paymentFailureExpectedPayment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const failedValue = context?.paymentFailureFailedPayment;
  const failed =
    typeof failedValue === "object" &&
    failedValue !== null &&
    !Array.isArray(failedValue)
      ? (failedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const eventValue = context?.paymentFailureProviderEvent;
  const event =
    typeof eventValue === "object" &&
    eventValue !== null &&
    !Array.isArray(eventValue)
      ? (eventValue as Readonly<Record<string, unknown>>)
      : undefined;
  const transactionValue = context?.paymentFailureProviderTransaction;
  const transaction =
    typeof transactionValue === "object" &&
    transactionValue !== null &&
    !Array.isArray(transactionValue)
      ? (transactionValue as Readonly<Record<string, unknown>>)
      : undefined;
  const eventOccurredAt = event?.occurredAt;
  const eventVerifiedAt = event?.verifiedAt;
  const captureCutoffAt = failed?.captureCutoffAt;
  if (
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit" && role !== "balance") ||
    !nonBlank(providerEventId) ||
    !nonBlank(providerTransactionId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(resultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== paymentId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    context?.providerEventPaymentId !== paymentId ||
    context?.providerPaymentEventStatus !== "failed" ||
    context?.providerPaymentEventAuthenticated !== true ||
    context?.providerPaymentEventVerified !== true ||
    expected?.id !== paymentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.role !== role ||
    expected.status !== "pending" ||
    typeof expected.provider !== "string" ||
    expected.provider.trim().length === 0 ||
    expected.provider !== event?.provider ||
    expected.providerIntentId !== providerTransactionId ||
    typeof expected.requestedAmountMinor !== "bigint" ||
    expected.requestedAmountMinor <= 0n ||
    typeof expected.currency !== "string" ||
    expected.currency.trim().length === 0 ||
    expected.captureAuthorized !== true ||
    expected.captureCutoffAt !== null ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true ||
    failed?.id !== paymentId ||
    failed.orderId !== orderId ||
    failed.phaseId !== phaseId ||
    failed.role !== role ||
    failed.previousStatus !== "pending" ||
    failed.targetStatus !== "failed" ||
    failed.provider !== expected.provider ||
    failed.providerIntentId !== providerTransactionId ||
    failed.requestedAmountMinor !== expected.requestedAmountMinor ||
    failed.currency !== expected.currency ||
    failed.captureAuthorized !== false ||
    !(captureCutoffAt instanceof Instant) ||
    failed.resultId !== resultId ||
    failed.immutable !== true ||
    event?.id !== providerEventId ||
    event.paymentId !== paymentId ||
    event.provider !== expected.provider ||
    event.transactionId !== providerTransactionId ||
    event.kind !== "PAYMENT_FAILED" ||
    event.amountMinor !== expected.requestedAmountMinor ||
    event.currency !== expected.currency ||
    event.status !== "failed" ||
    event.authenticated !== true ||
    event.verified !== true ||
    !(eventOccurredAt instanceof Instant) ||
    !(eventVerifiedAt instanceof Instant) ||
    !(
      captureCutoffAt instanceof Instant &&
      captureCutoffAt.equals(eventVerifiedAt)
    ) ||
    event.resultId !== resultId ||
    event.immutable !== true ||
    transaction?.id !== providerTransactionId ||
    transaction.paymentId !== paymentId ||
    transaction.eventId !== providerEventId ||
    transaction.status !== "failed" ||
    transaction.resultId !== resultId ||
    transaction.immutable !== true ||
    context?.paymentFailurePaymentResultId !== resultId ||
    context?.paymentFailureProviderEventResultId !== resultId ||
    context?.paymentFailureProviderTransactionResultId !== resultId ||
    context?.paymentFailureCompleted !== true ||
    context?.paymentFailureAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "payment failure requires the exact pending Payment, authenticated provider event, transaction, and atomic result",
    );
  }
}

function requireExactPendingCaptureWindow<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  expectedOutcome: "within_window" | "expired",
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const windowId = context?.paymentCaptureWindowId;
  const windowResultId = context?.paymentCaptureWindowResultId;
  const evaluationResultId = context?.captureEvaluationResultId;
  const previousPaymentResultId =
    context?.captureEvaluationPreviousPaymentResultId;
  const stateKey = context?.captureEvaluationCurrentStateCommandKey;
  const evaluatedAt = context?.captureEvaluatedAt;
  const expectedPaymentValue = context?.captureEvaluationExpectedPayment;
  const expectedPayment =
    typeof expectedPaymentValue === "object" &&
    expectedPaymentValue !== null &&
    !Array.isArray(expectedPaymentValue)
      ? (expectedPaymentValue as Readonly<Record<string, unknown>>)
      : undefined;
  const windowValue = context?.paymentCaptureWindow;
  const window =
    typeof windowValue === "object" &&
    windowValue !== null &&
    !Array.isArray(windowValue)
      ? (windowValue as Readonly<Record<string, unknown>>)
      : undefined;
  const eventValue = context?.captureProviderEvent;
  const event =
    typeof eventValue === "object" &&
    eventValue !== null &&
    !Array.isArray(eventValue)
      ? (eventValue as Readonly<Record<string, unknown>>)
      : undefined;
  const opensAt = window?.opensAt;
  const cutoffAt = window?.cutoffAt;
  const verifiedAt = event?.verifiedAt;
  const providerEventId = context?.captureProviderEventId;
  const providerTransactionId = context?.providerPaymentTransactionId;
  const windowKind = role === "balance" ? "balance_deadline" : "checkout";
  const persistedCutoff =
    role === "balance"
      ? context?.balanceDueAt
      : context?.checkoutCaptureExpiresAt;
  const inWindow =
    opensAt instanceof Instant &&
    cutoffAt instanceof Instant &&
    evaluatedAt instanceof Instant &&
    evaluatedAt.compare(opensAt) >= 0 &&
    evaluatedAt.compare(cutoffAt) < 0;
  const expired =
    cutoffAt instanceof Instant &&
    evaluatedAt instanceof Instant &&
    evaluatedAt.compare(cutoffAt) >= 0;
  if (
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit" && role !== "balance") ||
    !nonBlank(windowId) ||
    !nonBlank(windowResultId) ||
    !nonBlank(evaluationResultId) ||
    !nonBlank(previousPaymentResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(providerEventId) ||
    !nonBlank(providerTransactionId) ||
    !(opensAt instanceof Instant) ||
    !(cutoffAt instanceof Instant) ||
    !(evaluatedAt instanceof Instant) ||
    !(persistedCutoff instanceof Instant) ||
    opensAt.compare(cutoffAt) >= 0 ||
    !cutoffAt.equals(persistedCutoff) ||
    command.aggregateId !== paymentId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousPaymentResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedPayment?.id !== paymentId ||
    expectedPayment.orderId !== orderId ||
    expectedPayment.phaseId !== phaseId ||
    expectedPayment.role !== role ||
    expectedPayment.status !== "pending" ||
    typeof expectedPayment.provider !== "string" ||
    expectedPayment.provider.trim().length === 0 ||
    typeof expectedPayment.requestedAmountMinor !== "bigint" ||
    expectedPayment.requestedAmountMinor <= 0n ||
    typeof expectedPayment.currency !== "string" ||
    expectedPayment.currency.trim().length === 0 ||
    expectedPayment.resultId !== previousPaymentResultId ||
    expectedPayment.currentStateCommandKey !== stateKey ||
    expectedPayment.immutable !== true ||
    window?.id !== windowId ||
    window.paymentId !== paymentId ||
    window.orderId !== orderId ||
    window.phaseId !== phaseId ||
    window.role !== role ||
    window.kind !== windowKind ||
    window.immutable !== true ||
    window.resultId !== windowResultId ||
    context?.captureEvaluationPaymentId !== paymentId ||
    context?.captureEvaluationOrderId !== orderId ||
    context?.captureEvaluationPhaseId !== phaseId ||
    context?.captureEvaluationWindowId !== windowId ||
    context?.captureEvaluationWindowResultId !== windowResultId ||
    context?.captureEvaluationOutcome !== expectedOutcome ||
    event?.id !== providerEventId ||
    event.paymentId !== paymentId ||
    event.provider !== expectedPayment.provider ||
    event.transactionId !== providerTransactionId ||
    event.kind !== "PAYMENT_CAPTURED" ||
    event.amountMinor !== expectedPayment.requestedAmountMinor ||
    event.currency !== expectedPayment.currency ||
    event.status !== "captured" ||
    !(event.occurredAt instanceof Instant) ||
    !(verifiedAt instanceof Instant) ||
    !verifiedAt.equals(evaluatedAt) ||
    event.authenticated !== true ||
    event.verified !== true ||
    event.immutable !== true ||
    event.resultId !== evaluationResultId ||
    context?.captureEvaluationPaymentResultId !== evaluationResultId ||
    context?.captureEvaluationProviderEventResultId !== evaluationResultId ||
    context?.captureEvaluationActivationResultId !== evaluationResultId ||
    context?.captureEvaluationCompleted !== true ||
    context?.captureEvaluationAtomic !== true ||
    (expectedOutcome === "within_window" ? !inWindow : !expired)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      expectedOutcome === "within_window"
        ? "capture must bind the exact immutable Payment window and be verified before its cutoff"
        : "late capture compensation must bind the exact expired Payment window",
    );
  }
  if (role === "balance") {
    requireBalancePaymentDeadlineSetup(lifecycle, command);
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
  const previousResultId =
    command.context?.lateCaptureCompensationPreviousPaymentResultId;
  const stateKey =
    command.context?.lateCaptureCompensationCurrentStateCommandKey;
  const expectedValue = command.context?.lateCaptureCompensationExpectedPayment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const providerTransactionId = command.context?.providerPaymentTransactionId;
  const refundTransactionId = command.context?.refundTransactionId;
  const failureEventValue = command.context?.paymentFailureProviderEvent;
  const failureEvent =
    typeof failureEventValue === "object" &&
    failureEventValue !== null &&
    !Array.isArray(failureEventValue)
      ? (failureEventValue as Readonly<Record<string, unknown>>)
      : undefined;
  const captureCutoffAt = expected?.captureCutoffAt;
  const failureVerifiedAt = failureEvent?.verifiedAt;
  const captureEventValue = command.context?.captureProviderEvent;
  const captureEvent =
    typeof captureEventValue === "object" &&
    captureEventValue !== null &&
    !Array.isArray(captureEventValue)
      ? (captureEventValue as Readonly<Record<string, unknown>>)
      : undefined;
  const captureEventId = command.context?.lateCaptureProviderEventId;
  const captureResultId = command.context?.lateCaptureCompensationResultId;
  const capturedAt = command.context?.lateCaptureCapturedAt;
  const captureOccurredAt = captureEvent?.occurredAt;
  const captureVerifiedAt = captureEvent?.verifiedAt;
  if (
    (command.current === "voided" || command.current === "failed") &&
    command.target === "refund_pending" &&
    (typeof paymentId !== "string" ||
      paymentId.trim().length === 0 ||
      typeof previousResultId !== "string" ||
      previousResultId.trim().length === 0 ||
      typeof stateKey !== "string" ||
      stateKey.trim().length === 0 ||
      command.aggregateId !== paymentId ||
      command.currentStateCommandKey !== stateKey ||
      command.currentStateResultId !== previousResultId ||
      expected?.id !== paymentId ||
      expected.orderId !== command.context?.orderId ||
      expected.phaseId !== command.context?.phaseId ||
      expected.role !== command.context?.paymentRole ||
      expected.status !== command.current ||
      expected.resultId !== previousResultId ||
      expected.currentStateCommandKey !== stateKey ||
      expected.immutable !== true ||
      command.context?.providerEventPaymentId !== paymentId ||
      command.context?.lateCaptureCompensationPaymentId !== paymentId ||
      command.context?.lateCaptureRefundTransactionPaymentId !== paymentId)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "late capture compensation must belong to this exact Payment",
    );
  }
  if (
    (command.current === "voided" || command.current === "failed") &&
    command.target === "refund_pending" &&
    (typeof expected?.provider !== "string" ||
      expected.provider.trim().length === 0 ||
      typeof expected.requestedAmountMinor !== "bigint" ||
      expected.requestedAmountMinor <= 0n ||
      typeof expected.currency !== "string" ||
      expected.currency.trim().length === 0 ||
      expected.captureAuthorized !== false ||
      !(captureCutoffAt instanceof Instant) ||
      typeof captureEventId !== "string" ||
      captureEventId.trim().length === 0 ||
      typeof captureResultId !== "string" ||
      captureResultId.trim().length === 0 ||
      command.context?.captureProviderEventId !== captureEventId ||
      captureEvent?.id !== captureEventId ||
      captureEvent.paymentId !== paymentId ||
      captureEvent.provider !== expected.provider ||
      captureEvent.transactionId !== providerTransactionId ||
      captureEvent.kind !== "PAYMENT_CAPTURED" ||
      captureEvent.amountMinor !== expected.requestedAmountMinor ||
      captureEvent.currency !== expected.currency ||
      captureEvent.status !== "captured" ||
      captureEvent.authenticated !== true ||
      captureEvent.verified !== true ||
      !(captureOccurredAt instanceof Instant) ||
      !(captureVerifiedAt instanceof Instant) ||
      !(capturedAt instanceof Instant) ||
      !captureVerifiedAt.equals(capturedAt) ||
      captureVerifiedAt.compare(captureCutoffAt) < 0 ||
      captureEvent.resultId !== captureResultId ||
      command.context?.lateCaptureProviderEventResultId !== captureResultId ||
      captureEvent.immutable !== true)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "late capture compensation requires the exact provider capture evidence",
    );
  }
  if (
    command.current === "failed" &&
    (typeof expected?.providerIntentId !== "string" ||
      expected.providerIntentId.trim().length === 0 ||
      typeof expected.providerFailureEventId !== "string" ||
      expected.providerFailureEventId.trim().length === 0 ||
      command.context?.paymentFailureProviderEventId !==
        expected.providerFailureEventId ||
      command.context?.paymentFailureResultId !== previousResultId ||
      failureEvent?.id !== expected.providerFailureEventId ||
      failureEvent.paymentId !== paymentId ||
      failureEvent.transactionId !== expected.providerIntentId ||
      failureEvent.provider !== expected.provider ||
      failureEvent.amountMinor !== expected.requestedAmountMinor ||
      failureEvent.currency !== expected.currency ||
      failureEvent.status !== "failed" ||
      failureEvent.authenticated !== true ||
      failureEvent.verified !== true ||
      !(failureVerifiedAt instanceof Instant) ||
      !(captureCutoffAt instanceof Instant) ||
      !failureVerifiedAt.equals(captureCutoffAt) ||
      failureEvent.resultId !== previousResultId ||
      failureEvent.immutable !== true)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "failed-source late capture requires the exact prior provider failure evidence",
    );
  }
  if (
    typeof providerTransactionId !== "string" ||
    providerTransactionId.trim().length === 0 ||
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
    refundTransactionId.trim().length === 0 ||
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
    "a closed payment may be refunded only after verified late capture",
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

function requireExactQuotedCheckoutOrderSource<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  sourceEvidence: Readonly<{
    previousResultId: unknown;
    currentStateCommandKey: unknown;
    expectedOrder: unknown;
  }>,
): void {
  if (lifecycle !== "Order") return;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const orderId = command.context?.orderId;
  const expected =
    typeof sourceEvidence.expectedOrder === "object" &&
    sourceEvidence.expectedOrder !== null &&
    !Array.isArray(sourceEvidence.expectedOrder)
      ? (sourceEvidence.expectedOrder as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    !nonBlank(orderId) ||
    !nonBlank(sourceEvidence.previousResultId) ||
    !nonBlank(sourceEvidence.currentStateCommandKey) ||
    command.aggregateId !== orderId ||
    command.currentStateResultId !== sourceEvidence.previousResultId ||
    command.currentStateCommandKey !== sourceEvidence.currentStateCommandKey ||
    expected?.id !== orderId ||
    expected.status !== "quoted" ||
    expected.resultId !== sourceEvidence.previousResultId ||
    expected.currentStateCommandKey !== sourceEvidence.currentStateCommandKey ||
    expected.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "checkout termination must bind the selected quoted Order command to its immutable source snapshot",
    );
  }
}

function requireExactPendingCapacityCapturePaymentSource<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (
    lifecycle !== "Payment" ||
    command.current !== "pending" ||
    command.target !== "refund_pending"
  ) {
    return;
  }
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.initialPaymentRole;
  const providerTransactionId = context?.providerPaymentTransactionId;
  const captureWindowId = context?.paymentCaptureWindowId;
  const captureWindowResultId = context?.paymentCaptureWindowResultId;
  const previousResultId = context?.capacityCapturePreviousPaymentResultId;
  const stateKey = context?.capacityCapturePaymentCurrentStateCommandKey;
  const expectedValue = context?.capacityCaptureExpectedPayment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const resultId = context?.capacityCaptureResultId;
  if (
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit") ||
    !nonBlank(providerTransactionId) ||
    !nonBlank(captureWindowId) ||
    !nonBlank(captureWindowResultId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(resultId) ||
    command.aggregateId !== paymentId ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    expected?.id !== paymentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.role !== role ||
    expected.status !== "pending" ||
    expected.providerTransactionId !== providerTransactionId ||
    expected.captureWindowId !== captureWindowId ||
    expected.captureWindowResultId !== captureWindowResultId ||
    expected.captureKind !== "initial_checkout_capacity" ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true ||
    context?.capacityCaptureCompensationResultId !== resultId ||
    context?.capacityCaptureRefundTransactionResultId !== resultId ||
    context?.capacityCapturePaymentResultId !== resultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "capacity compensation must bind the command-selected immutable pending Payment and its refund result",
    );
  }
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
  requireExactPendingCapacityCapturePaymentSource(lifecycle, command);
  requireExactQuotedCheckoutOrderSource(lifecycle, command, {
    previousResultId: command.context?.capacityCapturePreviousOrderResultId,
    currentStateCommandKey:
      command.context?.capacityCaptureOrderCurrentStateCommandKey,
    expectedOrder: command.context?.capacityCaptureExpectedOrder,
  });
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

function requireExactPartiallyRefundedPaymentSource<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  if (
    lifecycle !== "Payment" ||
    command.current !== "partially_refunded" ||
    command.target !== "refund_pending"
  ) {
    return;
  }
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const kind = context?.compensationRefundRetryKind;
  const previousResultId =
    context?.compensationRefundRetryPreviousPaymentResultId;
  const stateKey = context?.compensationRefundRetryCurrentStateCommandKey;
  const expectedValue = context?.compensationRefundRetryExpectedPayment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    (kind !== "initial_checkout_capacity" && kind !== "late_capture") ||
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit" && role !== "balance") ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(command.aggregateId) ||
    command.aggregateId !== paymentId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    context?.compensationRefundRetryPaymentId !== paymentId ||
    context?.compensationRefundRetryPreviousStatus !== "partially_refunded" ||
    context?.compensationRefundRetryTargetStatus !== "refund_pending" ||
    expected?.id !== paymentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.role !== role ||
    expected.status !== "partially_refunded" ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "compensation retry must bind the exact immutable partially refunded Payment source",
    );
  }
}

function requireCompensationRefundRetry<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  requireExactPartiallyRefundedPaymentSource(lifecycle, command);
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
  requireExactQuotedCheckoutOrderSource(lifecycle, command, {
    previousResultId: command.context?.initialCaptureClosePreviousOrderResultId,
    currentStateCommandKey:
      command.context?.initialCaptureCloseOrderCurrentStateCommandKey,
    expectedOrder: command.context?.initialCaptureCloseExpectedOrder,
  });
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

function requireAtomicJobFailureSettlement<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const jobId = context?.jobId;
  const reservationId = context?.productionReservationId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const resultId = context?.jobFailureResultId;
  const previousJobResultId = context?.jobFailurePreviousJobResultId;
  const stateKey = context?.jobFailureCurrentStateCommandKey;
  const replacementRequestId = context?.jobFailureReplacementRequestId;
  const expectedJob = record(context?.jobFailureExpectedJob);
  const expectedReservation = record(context?.jobFailureExpectedReservation);
  const expectedReplacement = record(context?.jobFailureExpectedReplacement);
  const expectedReservationStatus =
    command.current === "accepted" || command.current === "gcode_ready"
      ? "scheduled"
      : "printing";
  const expectedStage = isJobFailureStageForCurrent(
    command.current,
    context?.failureStage,
  );
  if (
    lifecycle !== "Job" ||
    !nonBlank(jobId) ||
    !nonBlank(reservationId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(resultId) ||
    !nonBlank(previousJobResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(replacementRequestId) ||
    command.aggregateId !== jobId ||
    command.currentStateCommandKey !== stateKey ||
    command.currentStateResultId !== previousJobResultId ||
    context?.jobFailureJobId !== jobId ||
    context?.jobFailureProductionReservationId !== reservationId ||
    context?.jobFailureOrderId !== orderId ||
    context?.jobFailurePhaseId !== phaseId ||
    context?.jobFailurePreviousStatus !== command.current ||
    context?.jobFailureTargetStatus !== "failed" ||
    context?.jobFailureFailureStage !== context?.failureStage ||
    !expectedStage ||
    typeof context?.failureReason !== "string" ||
    context.failureReason.trim().length === 0 ||
    context?.jobFailureFailureReason !== context.failureReason ||
    expectedJob?.id !== jobId ||
    expectedJob.orderId !== orderId ||
    expectedJob.phaseId !== phaseId ||
    expectedJob.productionReservationId !== reservationId ||
    expectedJob.status !== command.current ||
    expectedJob.resultId !== previousJobResultId ||
    expectedJob.currentStateCommandKey !== stateKey ||
    expectedJob.immutable !== true ||
    expectedReservation?.id !== reservationId ||
    expectedReservation.jobId !== jobId ||
    expectedReservation.orderId !== orderId ||
    expectedReservation.phaseId !== phaseId ||
    expectedReservation.status !== expectedReservationStatus ||
    expectedReservation.resultId !== resultId ||
    expectedReservation.immutable !== true ||
    expectedReplacement?.id !== replacementRequestId ||
    expectedReplacement?.jobId !== jobId ||
    expectedReplacement?.orderId !== orderId ||
    expectedReplacement?.phaseId !== phaseId ||
    expectedReplacement?.resultId !== resultId ||
    expectedReplacement?.immutable !== true ||
    context?.jobFailureJobResultId !== resultId ||
    context?.jobFailureResourceSettlementResultId !== resultId ||
    context?.jobFailureReplacementResultId !== resultId ||
    context?.jobFailureCompleted !== true ||
    context?.jobFailureAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job failure must bind the selected immutable Job, resources, replacement, and atomic result",
    );
  }
}

function requireExactPostAcceptanceJobCancellation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const exactStringSet = (actual: unknown, expected: unknown): boolean => {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    const left = actual.filter(nonBlank);
    const right = expected.filter(nonBlank);
    return (
      left.length === actual.length &&
      right.length === expected.length &&
      new Set(left).size === left.length &&
      new Set(right).size === right.length &&
      left.length === right.length &&
      left.every((id) => right.includes(id))
    );
  };
  const jobId = context?.jobId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const reservationId = context?.productionReservationId;
  const resultId = context?.jobCancellationResultId;
  const previousJobResultId = context?.jobCancellationPreviousJobResultId;
  const previousReservationResultId =
    context?.jobCancellationPreviousReservationResultId;
  const currentStateCommandKey = command.currentStateCommandKey;
  const scopeId = context?.jobCancellationAuthoritativeScopeId;
  const scopeResultId = context?.jobCancellationScopeResultId;
  const expectedJob = record(context?.jobCancellationExpectedJob);
  const expectedReservation = record(
    context?.jobCancellationExpectedReservation,
  );
  const scope = record(context?.jobCancellationAuthoritativeScope);
  if (
    !nonBlank(jobId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(reservationId) ||
    !nonBlank(resultId) ||
    !nonBlank(previousJobResultId) ||
    !nonBlank(previousReservationResultId) ||
    !nonBlank(currentStateCommandKey) ||
    !nonBlank(scopeId) ||
    !nonBlank(scopeResultId) ||
    command.aggregateId !== jobId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousJobResultId ||
    context?.jobCancellationCurrentStateCommandKey !== currentStateCommandKey ||
    context?.jobCancellationJobId !== jobId ||
    context?.jobCancellationOrderId !== orderId ||
    context?.jobCancellationPhaseId !== phaseId ||
    context?.jobCancellationProductionReservationId !== reservationId ||
    context?.jobCancellationPreviousStatus !== command.current ||
    context?.jobCancellationTargetStatus !== "cancelled" ||
    context?.jobCancellationReason !== context?.cancellationReason ||
    expectedJob?.id !== jobId ||
    expectedJob.orderId !== orderId ||
    expectedJob.phaseId !== phaseId ||
    expectedJob.productionReservationId !== reservationId ||
    expectedJob.shipmentScopeId !== scopeId ||
    expectedJob.status !== command.current ||
    expectedJob.resultId !== previousJobResultId ||
    expectedJob.currentStateCommandKey !== currentStateCommandKey ||
    expectedJob.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "post-acceptance cancellation must bind the selected immutable Job and current state",
    );
  }

  const zeroPrePrint =
    command.current === "accepted" || command.current === "gcode_ready";
  const expectedReservationStatus = zeroPrePrint ? "scheduled" : "printing";
  const expectedReservationTarget = zeroPrePrint ? "released" : "settled";
  if (
    context?.jobCancellationReservationId !== reservationId ||
    context?.jobCancellationReservationPreviousStatus !==
      expectedReservationStatus ||
    context?.jobCancellationReservationTargetStatus !==
      expectedReservationTarget ||
    expectedReservation?.id !== reservationId ||
    expectedReservation.jobId !== jobId ||
    expectedReservation.orderId !== orderId ||
    expectedReservation.phaseId !== phaseId ||
    expectedReservation.status !== expectedReservationStatus ||
    expectedReservation.resultId !== previousReservationResultId ||
    expectedReservation.immutable !== true ||
    context?.jobCancellationReservationResultId !== resultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job cancellation must settle its exact immutable ProductionReservation",
    );
  }

  const expectedShipmentIds = context?.jobCancellationExpectedShipmentIds;
  const expectedLabelIds = context?.jobCancellationExpectedCarrierLabelIds;
  const expectedContributorJobIds =
    context?.jobCancellationExpectedContributorJobIds;
  const expectedContributorReservationIds =
    context?.jobCancellationExpectedContributorReservationIds;
  const scopeShipments = scope?.shipments;
  const scopeLabels = scope?.carrierLabels;
  if (
    context?.jobCancellationExpectedScopeId !== scopeId ||
    scope?.id !== scopeId ||
    scope.jobId !== jobId ||
    scope.orderId !== orderId ||
    scope.phaseId !== phaseId ||
    scope.productionReservationId !== reservationId ||
    scope.resultId !== scopeResultId ||
    scope.immutable !== true ||
    !exactStringSet(scope.shipmentIds, expectedShipmentIds) ||
    !exactStringSet(scope.carrierLabelIds, expectedLabelIds) ||
    !exactStringSet(scope.contributorJobIds, expectedContributorJobIds) ||
    !exactStringSet(
      scope.contributorReservationIds,
      expectedContributorReservationIds,
    ) ||
    !Array.isArray(scopeShipments) ||
    scopeShipments.length === 0 ||
    !Array.isArray(scopeLabels) ||
    scopeLabels.length !== (expectedLabelIds as unknown[]).length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job cancellation requires its immutable complete Shipment and carrier-label scope",
    );
  }
  const scopedShipments = new Map<string, Readonly<Record<string, unknown>>>();
  const scopedShipmentLabelIds = new Set<string>();
  const scopedContributors = new Map<string, string>();
  for (const value of scopeShipments) {
    const shipment = record(value);
    const contributorLinks = shipment?.contributorLinks;
    if (
      shipment === undefined ||
      !nonBlank(shipment.id) ||
      scopedShipments.has(shipment.id) ||
      !(expectedShipmentIds as unknown[]).includes(shipment.id) ||
      shipment.orderId !== orderId ||
      shipment.phaseId !== phaseId ||
      shipment.currentLineageLeaf !== true ||
      (shipment.status !== "planned" &&
        shipment.status !== "label_created" &&
        shipment.status !== "cancellation_pending") ||
      shipment.immutable !== true ||
      !Array.isArray(shipment.carrierLabelIds) ||
      !exactStringSet(shipment.carrierLabelIds, shipment.carrierLabelIds) ||
      (shipment.status === "planned"
        ? shipment.carrierLabelIds.length !== 0
        : shipment.carrierLabelIds.length === 0) ||
      !Array.isArray(contributorLinks) ||
      contributorLinks.length === 0
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Job cancellation Shipment scope must contain exact current lineage records",
      );
    }
    let selectedContributorCount = 0;
    const shipmentContributorJobIds = new Set<string>();
    for (const value of contributorLinks) {
      const contributor = record(value);
      if (
        contributor === undefined ||
        !nonBlank(contributor.jobId) ||
        !nonBlank(contributor.productionReservationId) ||
        shipmentContributorJobIds.has(contributor.jobId) ||
        scopedContributors.has(contributor.jobId) ||
        contributor.orderId !== orderId ||
        contributor.phaseId !== phaseId ||
        contributor.currentJobLineageLeaf !== true ||
        contributor.immutable !== true
      ) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          "Job cancellation Shipment scope requires the complete contributor topology",
        );
      }
      shipmentContributorJobIds.add(contributor.jobId);
      if (contributor.jobId === jobId) {
        if (contributor.productionReservationId !== reservationId) {
          throw new TransitionGuardError(
            lifecycle,
            command.current,
            command.target,
            "selected Job cancellation must use its exact contributor reservation",
          );
        }
        selectedContributorCount += 1;
      }
      scopedContributors.set(
        contributor.jobId,
        contributor.productionReservationId,
      );
    }
    if (selectedContributorCount !== 1) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "every scoped Shipment must contain the selected Job exactly once",
      );
    }
    scopedShipments.set(shipment.id, shipment);
    for (const labelId of shipment.carrierLabelIds as string[]) {
      if (scopedShipmentLabelIds.has(labelId)) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          "a carrier label cannot belong to multiple scoped Shipments",
        );
      }
      scopedShipmentLabelIds.add(labelId);
    }
  }
  if (
    scopedShipments.size !== (expectedShipmentIds as unknown[]).length ||
    !exactStringSet([...scopedShipmentLabelIds], expectedLabelIds) ||
    !exactStringSet(
      [...scopedContributors.keys()],
      expectedContributorJobIds,
    ) ||
    !exactStringSet(
      [...scopedContributors.values()],
      expectedContributorReservationIds,
    )
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job cancellation cannot omit a scoped Shipment",
    );
  }
  const scopedLabels = new Map<string, Readonly<Record<string, unknown>>>();
  for (const value of scopeLabels) {
    const label = record(value);
    const shipment =
      label !== undefined && nonBlank(label.shipmentId)
        ? scopedShipments.get(label.shipmentId)
        : undefined;
    if (
      label === undefined ||
      !nonBlank(label.id) ||
      scopedLabels.has(label.id) ||
      !(expectedLabelIds as unknown[]).includes(label.id) ||
      shipment === undefined ||
      label.orderId !== orderId ||
      label.phaseId !== phaseId ||
      label.status !== "usable" ||
      label.immutable !== true ||
      !Array.isArray(shipment.carrierLabelIds) ||
      !shipment.carrierLabelIds.includes(label.id)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Job cancellation carrier-label scope must belong to its exact Shipment",
      );
    }
    scopedLabels.set(label.id, label);
  }

  const shipmentCancellations = context?.jobCancellationShipments;
  const labelCancellations = context?.jobCancellationCarrierLabels;
  if (
    !Array.isArray(shipmentCancellations) ||
    shipmentCancellations.length !== scopedShipments.size ||
    !Array.isArray(labelCancellations) ||
    labelCancellations.length !== scopedLabels.size
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job cancellation must complete the exact Shipment and label scope",
    );
  }
  const cancelledShipmentIds = new Set<string>();
  for (const value of shipmentCancellations) {
    const cancellation = record(value);
    const expected =
      cancellation !== undefined && nonBlank(cancellation.id)
        ? scopedShipments.get(cancellation.id)
        : undefined;
    const contributorLinks = Array.isArray(expected?.contributorLinks)
      ? expected.contributorLinks
      : [];
    const contributorJobIds = contributorLinks.map((value) =>
      String((value as Readonly<Record<string, unknown>>).jobId),
    );
    const contributorReservationIds = contributorLinks.map((value) =>
      String(
        (value as Readonly<Record<string, unknown>>).productionReservationId,
      ),
    );
    const remainingContributorJobIds = contributorJobIds.filter(
      (id) => id !== jobId,
    );
    const remainingContributorReservationIds = contributorLinks
      .filter(
        (value) => (value as Readonly<Record<string, unknown>>).jobId !== jobId,
      )
      .map((value) =>
        String(
          (value as Readonly<Record<string, unknown>>).productionReservationId,
        ),
      );
    const sharedShipment = remainingContributorJobIds.length > 0;
    if (
      cancellation === undefined ||
      expected === undefined ||
      cancelledShipmentIds.has(cancellation.id as string) ||
      cancellation.jobId !== jobId ||
      cancellation.productionReservationId !== reservationId ||
      cancellation.orderId !== orderId ||
      cancellation.phaseId !== phaseId ||
      cancellation.previousStatus !== expected.status ||
      cancellation.targetStatus !==
        (sharedShipment ? expected.status : "cancelled") ||
      cancellation.barrierOutcome !==
        (sharedShipment ? "preserved_for_siblings" : "cancelled") ||
      cancellation.currentLineageLeaf !== true ||
      !exactStringSet(cancellation.contributorJobIds, contributorJobIds) ||
      !exactStringSet(
        cancellation.contributorReservationIds,
        contributorReservationIds,
      ) ||
      !exactStringSet(
        cancellation.remainingContributorJobIds,
        remainingContributorJobIds,
      ) ||
      !exactStringSet(
        cancellation.remainingContributorReservationIds,
        remainingContributorReservationIds,
      ) ||
      !exactStringSet(cancellation.carrierLabelIds, expected.carrierLabelIds) ||
      cancellation.resultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Job cancellation must cancel every exact scoped Shipment",
      );
    }
    cancelledShipmentIds.add(cancellation.id as string);
  }
  const cancelledLabelIds = new Set<string>();
  for (const value of labelCancellations) {
    const cancellation = record(value);
    const expected =
      cancellation !== undefined && nonBlank(cancellation.id)
        ? scopedLabels.get(cancellation.id)
        : undefined;
    const expectedShipment =
      expected !== undefined && nonBlank(expected.shipmentId)
        ? scopedShipments.get(expected.shipmentId)
        : undefined;
    const contributorLinks = Array.isArray(expectedShipment?.contributorLinks)
      ? expectedShipment.contributorLinks
      : [];
    const sharedShipment =
      contributorLinks.filter(
        (value) => (value as Readonly<Record<string, unknown>>).jobId !== jobId,
      ).length > 0;
    const providerOutcomeValid = sharedShipment
      ? cancellation?.barrierOutcome === "preserved_for_siblings" &&
        cancellation.targetStatus === "usable" &&
        cancellation.providerVoidOutboxId === null &&
        cancellation.providerVoidOutboxShipmentId === null &&
        cancellation.providerVoidOutboxLabelId === null &&
        cancellation.providerVoidIdempotencyKey === null &&
        cancellation.providerVoidAction === null &&
        cancellation.providerVoidOutboxPreviousStatus === null &&
        cancellation.providerVoidOutboxTargetStatus === null &&
        cancellation.providerVoidOutboxResultId === null &&
        cancellation.providerEventId === null &&
        cancellation.providerEventOutboxId === null &&
        cancellation.providerEventShipmentId === null &&
        cancellation.providerEventLabelId === null &&
        cancellation.providerEventTransactionId === null &&
        cancellation.providerEventResultId === null &&
        cancellation.providerTransactionId === null &&
        cancellation.providerTransactionShipmentId === null &&
        cancellation.providerTransactionLabelId === null &&
        cancellation.providerTransactionOutboxId === null &&
        cancellation.providerTransactionResultId === null &&
        cancellation.providerEventStatus === null &&
        cancellation.providerTransactionStatus === null &&
        cancellation.providerEventAuthenticated === false &&
        cancellation.providerEventVerified === false &&
        cancellation.providerVoidStatus === "not_required"
      : cancellation?.barrierOutcome === "invalidated" &&
        cancellation.targetStatus === "invalidated" &&
        nonBlank(cancellation.providerVoidOutboxId) &&
        cancellation.providerVoidOutboxShipmentId === expected?.shipmentId &&
        cancellation.providerVoidOutboxLabelId === cancellation.id &&
        cancellation.providerVoidIdempotencyKey ===
          `void_carrier_label:${String(expected?.shipmentId)}:${String(cancellation.id)}` &&
        cancellation.providerVoidAction === "void_carrier_label" &&
        cancellation.providerVoidOutboxPreviousStatus === "pending" &&
        cancellation.providerVoidOutboxTargetStatus === "succeeded" &&
        cancellation.providerVoidOutboxResultId === cancellation.resultId &&
        nonBlank(cancellation.providerEventId) &&
        cancellation.providerEventOutboxId ===
          cancellation.providerVoidOutboxId &&
        cancellation.providerEventShipmentId === expected?.shipmentId &&
        cancellation.providerEventLabelId === cancellation.id &&
        nonBlank(cancellation.providerTransactionId) &&
        cancellation.providerEventTransactionId ===
          cancellation.providerTransactionId &&
        cancellation.providerEventResultId === cancellation.resultId &&
        cancellation.providerTransactionShipmentId === expected?.shipmentId &&
        cancellation.providerTransactionLabelId === cancellation.id &&
        cancellation.providerTransactionOutboxId ===
          cancellation.providerVoidOutboxId &&
        cancellation.providerTransactionResultId === cancellation.resultId &&
        cancellation.providerEventStatus === "succeeded" &&
        cancellation.providerTransactionStatus === "succeeded" &&
        cancellation.providerEventAuthenticated === true &&
        cancellation.providerEventVerified === true &&
        cancellation.providerVoidStatus === "succeeded";
    if (
      cancellation === undefined ||
      expected === undefined ||
      expectedShipment === undefined ||
      cancelledLabelIds.has(cancellation.id as string) ||
      cancellation.shipmentId !== expected.shipmentId ||
      cancellation.jobId !== jobId ||
      cancellation.productionReservationId !== reservationId ||
      cancellation.orderId !== orderId ||
      cancellation.phaseId !== phaseId ||
      cancellation.previousStatus !== "usable" ||
      !providerOutcomeValid ||
      cancellation.resultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Job cancellation must invalidate every exact carrier label",
      );
    }
    cancelledLabelIds.add(cancellation.id as string);
  }
  if (
    cancelledShipmentIds.size !== scopedShipments.size ||
    cancelledLabelIds.size !== scopedLabels.size ||
    context?.jobCancellationJobResultId !== resultId ||
    context?.jobCancellationResourceSettlementResultId !== resultId ||
    context?.jobCancellationShipmentResultId !== resultId ||
    context?.jobCancellationCarrierLabelResultId !== resultId ||
    context?.jobCancellationBarrierResultId !== resultId ||
    context?.jobCancellationCompleted !== true ||
    context?.jobCancellationAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job cancellation requires one complete atomic result",
    );
  }
}

function requirePrintingReservationCommit<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const jobId = context?.jobId;
  const productionReservationId = context?.productionReservationId;
  const orderItemId = context?.orderItemId;
  const phaseId = context?.phaseId;
  const previousJobResultId = context?.printingPreviousJobResultId;
  const previousReservationResultId =
    context?.printingPreviousReservationResultId;
  const stateKey = context?.printingCurrentStateCommandKey;
  const resultId = context?.printingResultId;
  const expectedJob = record(context?.printingExpectedJob);
  const expectedReservation = record(context?.printingExpectedReservation);
  if (
    !nonBlank(jobId) ||
    !nonBlank(productionReservationId) ||
    !nonBlank(orderItemId) ||
    !nonBlank(phaseId) ||
    !nonBlank(previousJobResultId) ||
    !nonBlank(previousReservationResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(resultId) ||
    command.aggregateId !== jobId ||
    command.currentStateCommandKey !== stateKey ||
    context?.productionReservationJobId !== jobId ||
    context?.printingReservationJobId !== jobId ||
    context?.printingJobId !== jobId ||
    context?.printingReservationId !== productionReservationId ||
    context?.printingJobPreviousStatus !== "gcode_ready" ||
    context?.printingJobTargetStatus !== "printing" ||
    expectedJob?.id !== jobId ||
    expectedJob.productionReservationId !== productionReservationId ||
    expectedJob.orderItemId !== orderItemId ||
    expectedJob.phaseId !== phaseId ||
    expectedJob.status !== "gcode_ready" ||
    expectedJob.resultId !== previousJobResultId ||
    expectedJob.currentStateCommandKey !== stateKey ||
    expectedJob.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "printing reservation commit must belong to this exact Job",
    );
  }
  if (
    context?.printingReservationProductionReservationId !==
      productionReservationId ||
    context?.printingReservationPreviousStatus !== "scheduled" ||
    context?.printingReservationTargetStatus !== "printing" ||
    expectedReservation?.id !== productionReservationId ||
    expectedReservation.jobId !== jobId ||
    expectedReservation.orderItemId !== orderItemId ||
    expectedReservation.phaseId !== phaseId ||
    expectedReservation.status !== "scheduled" ||
    expectedReservation.resultId !== previousReservationResultId ||
    expectedReservation.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "printing must commit this Job's exact ProductionReservation",
    );
  }
  if (
    context?.printingReservationState !== "printing" ||
    context?.materialConsumptionMode !== "actual_recorded" ||
    context?.printingJobResultId !== resultId ||
    context?.printingReservationResultId !== resultId ||
    context?.printingCompleted !== true ||
    context?.printingAtomic !== true
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
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const jobId = command.context?.jobId;
  const productionReservationId = command.context?.productionReservationId;
  const orderItemId = command.context?.orderItemId;
  const phaseId = command.context?.phaseId;
  const artifactVersionId = command.context?.reproductionArtifactVersionId;
  const previousResultId = command.context?.acceptancePreviousJobResultId;
  const stateKey = command.context?.acceptanceCurrentStateCommandKey;
  const expectedValue = command.context?.acceptanceExpectedJob;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    !nonBlank(jobId) ||
    command.aggregateId !== jobId ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    command.context?.productionReservationJobId !== jobId ||
    command.context?.acceptanceReservationJobId !== jobId ||
    command.context?.reproductionArtifactVersionJobId !== jobId ||
    expected?.id !== jobId ||
    expected.productionReservationId !== productionReservationId ||
    expected.orderItemId !== orderItemId ||
    expected.phaseId !== phaseId ||
    expected.status !== "created" ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "acceptance ownership must belong to this exact Job",
    );
  }
  if (
    !nonBlank(productionReservationId) ||
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
    !nonBlank(artifactVersionId) ||
    command.context?.acceptanceArtifactVersionId !== artifactVersionId ||
    command.context?.reproductionArtifactVersionStatus !== "draft" ||
    !nonBlank(orderItemId) ||
    command.context?.reproductionArtifactVersionOrderItemId !== orderItemId ||
    !nonBlank(phaseId) ||
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
      !nonBlank(reservationSnapshotId) ||
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

function requireCreatedJobCancellationOwnership<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const exactSet = (actual: unknown, expected: unknown): boolean => {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    const left = actual.filter(nonBlank);
    const right = expected.filter(nonBlank);
    return (
      left.length === actual.length &&
      right.length === expected.length &&
      left.length === right.length &&
      new Set(left).size === left.length &&
      new Set(right).size === right.length &&
      left.every((id) => right.includes(id))
    );
  };
  const jobId = context?.jobId;
  const orderId = context?.orderId;
  const orderItemId = context?.orderItemId;
  const phaseId = context?.phaseId;
  const reservationId = context?.productionReservationId;
  const resultId = context?.createdCancellationResultId;
  const previousJobResultId = context?.createdCancellationPreviousJobResultId;
  const previousReservationResultId =
    context?.createdCancellationPreviousReservationResultId;
  const stateKey = context?.createdCancellationCurrentStateCommandKey;
  const expectedJob = record(context?.createdCancellationExpectedJob);
  const expectedReservation = record(
    context?.createdCancellationExpectedReservation,
  );
  const offerSet = record(context?.createdCancellationOfferSet);
  const expectedOfferIds = context?.createdCancellationExpectedOfferIds;
  const offers = context?.createdCancellationOffers;
  if (
    !nonBlank(jobId) ||
    !nonBlank(orderId) ||
    !nonBlank(orderItemId) ||
    !nonBlank(phaseId) ||
    !nonBlank(reservationId) ||
    !nonBlank(resultId) ||
    !nonBlank(previousJobResultId) ||
    !nonBlank(previousReservationResultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== jobId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousJobResultId ||
    command.currentStateCommandKey !== stateKey ||
    context?.createdCancellationJobId !== jobId ||
    context?.createdCancellationOrderId !== orderId ||
    context?.createdCancellationPhaseId !== phaseId ||
    context?.createdCancellationReservationId !== reservationId ||
    context?.createdCancellationPreviousStatus !== "created" ||
    context?.createdCancellationTargetStatus !== "cancelled" ||
    expectedJob?.id !== jobId ||
    expectedJob.orderId !== orderId ||
    expectedJob.orderItemId !== orderItemId ||
    expectedJob.phaseId !== phaseId ||
    expectedJob.productionReservationId !== reservationId ||
    expectedJob.status !== "created" ||
    expectedJob.resultId !== previousJobResultId ||
    expectedJob.currentStateCommandKey !== stateKey ||
    expectedJob.immutable !== true ||
    context?.createdCancellationOfferSetId !== offerSet?.id ||
    !nonBlank(context?.createdCancellationOfferSetId) ||
    !nonBlank(context?.createdCancellationOfferSetResultId) ||
    offerSet?.id !== context?.createdCancellationOfferSetId ||
    offerSet.jobId !== jobId ||
    offerSet.orderId !== orderId ||
    offerSet.orderItemId !== orderItemId ||
    offerSet.phaseId !== phaseId ||
    offerSet.productionReservationId !== reservationId ||
    offerSet.resultId !== context?.createdCancellationOfferSetResultId ||
    offerSet.immutable !== true ||
    !exactSet(offerSet.offerIds, expectedOfferIds) ||
    !Array.isArray(offers) ||
    offers.length !== (expectedOfferIds as unknown[]).length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "created Job cancellation must bind the exact Job and immutable offer set",
    );
  }
  if (
    !nonBlank(context?.createdCancellationJobResultId) ||
    !nonBlank(context?.createdCancellationReservationResultId) ||
    context?.createdCancellationJobResultId !== resultId ||
    context?.createdCancellationReservationResultId !== resultId ||
    context?.createdCancellationOffersResultId !== resultId ||
    context?.createdCancellationCompleted !== true ||
    context?.createdCancellationAtomic !== true ||
    context?.offersClosed !== true ||
    context?.productionReservationReleased !== true ||
    context?.createdCancellationReservationPreviousStatus !== "held" ||
    context?.createdCancellationReservationTargetStatus !== "released" ||
    expectedReservation?.id !== reservationId ||
    expectedReservation.jobId !== jobId ||
    expectedReservation.orderId !== orderId ||
    expectedReservation.orderItemId !== orderItemId ||
    expectedReservation.phaseId !== phaseId ||
    expectedReservation.status !== "held" ||
    expectedReservation.resultId !== previousReservationResultId ||
    expectedReservation.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "created Job cancellation must release its exact reservation atomically",
    );
  }
  const offerIds = new Set<string>();
  for (const value of offers) {
    const offer = record(value);
    if (
      offer === undefined ||
      !nonBlank(offer.id) ||
      offerIds.has(offer.id) ||
      !(expectedOfferIds as unknown[]).includes(offer.id) ||
      offer.jobId !== jobId ||
      offer.productionReservationId !== reservationId ||
      offer.orderItemId !== orderItemId ||
      offer.orderId !== orderId ||
      offer.phaseId !== phaseId ||
      offer.previousStatus !== "open" ||
      offer.targetStatus !== "closed" ||
      offer.resultId !== resultId ||
      offer.immutable !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "created Job cancellation must close every exact routing offer",
      );
    }
    offerIds.add(offer.id as string);
  }
  if (!exactSet([...offerIds], expectedOfferIds)) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "created Job cancellation cannot omit or duplicate routing offers",
    );
  }
}

function requireAtomicGcodeReadyProduction<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const jobId = context?.jobId;
  const reservationId = context?.productionReservationId;
  const artifactVersionId = context?.reproductionArtifactVersionId;
  const orderItemId = context?.orderItemId;
  const phaseId = context?.phaseId;
  const resultId = context?.gcodeReadyResultId;
  const productionSliceId = context?.productionSliceId;
  const outputDigest = context?.productionSliceOutputDigest;
  const acceptedResultId = context?.gcodeReadyAcceptedJobResultId;
  const currentStateCommandKey = command.currentStateCommandKey;
  const expectedJob = record(context?.gcodeReadyExpectedJob);
  const expectedReservation = record(
    context?.gcodeReadyExpectedReservationSnapshot,
  );
  const expectedArtifact = record(context?.gcodeReadyExpectedArtifactVersion);
  const productionSlice = record(context?.gcodeReadyProductionSlice);
  if (
    !nonBlank(jobId) ||
    !nonBlank(reservationId) ||
    !nonBlank(artifactVersionId) ||
    !nonBlank(orderItemId) ||
    !nonBlank(phaseId) ||
    !nonBlank(resultId) ||
    !nonBlank(productionSliceId) ||
    !nonBlank(outputDigest) ||
    !nonBlank(acceptedResultId) ||
    !nonBlank(currentStateCommandKey) ||
    command.aggregateId !== jobId ||
    context?.gcodeReadyAcceptedStateCommandKey !== currentStateCommandKey ||
    context?.gcodeReadyJobId !== jobId ||
    context?.gcodeReadyReservationId !== reservationId ||
    context?.gcodeReadyArtifactVersionId !== artifactVersionId ||
    context?.gcodeReadyOrderItemId !== orderItemId ||
    context?.gcodeReadyPhaseId !== phaseId ||
    context?.gcodeReadyJobPreviousStatus !== "accepted" ||
    context?.gcodeReadyJobTargetStatus !== "gcode_ready" ||
    expectedJob?.id !== jobId ||
    expectedJob.productionReservationId !== reservationId ||
    expectedJob.reproductionArtifactVersionId !== artifactVersionId ||
    expectedJob.orderItemId !== orderItemId ||
    expectedJob.phaseId !== phaseId ||
    expectedJob.status !== "accepted" ||
    expectedJob.resultId !== acceptedResultId ||
    expectedJob.currentStateCommandKey !== currentStateCommandKey ||
    expectedJob.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "G-code readiness must bind the exact immutable accepted Job",
    );
  }

  const candidateResourceEstimateId =
    context?.productionReservationCandidateResourceEstimateId;
  const machineProfileId = context?.productionReservationMachineProfileId;
  const machineCalibrationId =
    context?.productionReservationMachineCalibrationId;
  const printConfigRevisionId =
    context?.productionReservationPrintConfigRevisionId;
  if (
    !nonBlank(candidateResourceEstimateId) ||
    !nonBlank(machineProfileId) ||
    !nonBlank(machineCalibrationId) ||
    !nonBlank(printConfigRevisionId) ||
    expectedReservation?.id !== reservationId ||
    expectedReservation.jobId !== jobId ||
    expectedReservation.orderItemId !== orderItemId ||
    expectedReservation.phaseId !== phaseId ||
    expectedReservation.status !== "scheduled" ||
    expectedReservation.candidateResourceEstimateId !==
      candidateResourceEstimateId ||
    expectedReservation.machineProfileId !== machineProfileId ||
    expectedReservation.machineCalibrationId !== machineCalibrationId ||
    expectedReservation.printConfigRevisionId !== printConfigRevisionId ||
    expectedReservation.resultId !== acceptedResultId ||
    expectedReservation.immutable !== true ||
    expectedArtifact?.id !== artifactVersionId ||
    expectedArtifact.jobId !== jobId ||
    expectedArtifact.productionReservationId !== reservationId ||
    expectedArtifact.orderItemId !== orderItemId ||
    expectedArtifact.phaseId !== phaseId ||
    expectedArtifact.status !== "draft" ||
    expectedArtifact.candidateResourceEstimateId !==
      candidateResourceEstimateId ||
    expectedArtifact.machineProfileId !== machineProfileId ||
    expectedArtifact.machineCalibrationId !== machineCalibrationId ||
    expectedArtifact.printConfigRevisionId !== printConfigRevisionId ||
    expectedArtifact.resultId !== acceptedResultId ||
    expectedArtifact.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "G-code readiness must use the exact accepted artifact and reservation snapshot",
    );
  }
  if (
    productionSlice?.id !== productionSliceId ||
    productionSlice.jobId !== jobId ||
    productionSlice.productionReservationId !== reservationId ||
    productionSlice.reproductionArtifactVersionId !== artifactVersionId ||
    productionSlice.orderItemId !== orderItemId ||
    productionSlice.phaseId !== phaseId ||
    productionSlice.previousStatus !== "pending" ||
    productionSlice.targetStatus !== "completed" ||
    productionSlice.candidateResourceEstimateId !==
      candidateResourceEstimateId ||
    productionSlice.machineProfileId !== machineProfileId ||
    productionSlice.machineCalibrationId !== machineCalibrationId ||
    productionSlice.printConfigRevisionId !== printConfigRevisionId ||
    productionSlice.outputDigest !== outputDigest ||
    productionSlice.resultId !== resultId ||
    productionSlice.sourceStateCommandKey !== currentStateCommandKey ||
    productionSlice.immutable !== true ||
    context?.gcodeReadyArtifactPreviousStatus !== "draft" ||
    context?.gcodeReadyArtifactTargetStatus !== "sealed" ||
    context?.gcodeReadyArtifactOutputDigest !== outputDigest ||
    context?.gcodeReadyJobResultId !== resultId ||
    context?.gcodeReadyReservationResultId !== resultId ||
    context?.gcodeReadyArtifactResultId !== resultId ||
    context?.gcodeReadyProductionSliceResultId !== resultId ||
    context?.gcodeReadyCompleted !== true ||
    context?.gcodeReadyAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "G-code readiness requires the exact sealed production slice and one atomic result",
    );
  }
}

function requireAtomicQcPhotoSubmission<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const jobId = context?.jobId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const reservationId = context?.productionReservationId;
  const photoAssetId = context?.qcPhotoAssetId;
  const resultId = context?.qcPhotoSubmissionResultId;
  const printedResultId = context?.qcPhotoSubmissionPrintedJobResultId;
  const retentionDeadlineAt = context?.qcPhotoRetentionDeadlineAt;
  const currentStateCommandKey = command.currentStateCommandKey;
  const expectedJob = record(context?.qcPhotoSubmissionExpectedJob);
  const photoAsset = record(context?.qcPhotoSubmissionPhotoAsset);
  if (
    !nonBlank(jobId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(reservationId) ||
    !nonBlank(photoAssetId) ||
    !nonBlank(resultId) ||
    !nonBlank(printedResultId) ||
    !(retentionDeadlineAt instanceof Instant) ||
    !nonBlank(currentStateCommandKey) ||
    command.aggregateId !== jobId ||
    context?.qcPhotoSubmissionPrintedStateCommandKey !==
      currentStateCommandKey ||
    context?.qcPhotoSubmissionJobId !== jobId ||
    context?.qcPhotoSubmissionOrderId !== orderId ||
    context?.qcPhotoSubmissionPhaseId !== phaseId ||
    context?.qcPhotoSubmissionReservationId !== reservationId ||
    context?.qcPhotoSubmissionPhotoAssetId !== photoAssetId ||
    context?.qcPhotoSubmissionJobPreviousStatus !== "printed" ||
    context?.qcPhotoSubmissionJobTargetStatus !== "photo_submitted" ||
    expectedJob?.id !== jobId ||
    expectedJob.orderId !== orderId ||
    expectedJob.phaseId !== phaseId ||
    expectedJob.productionReservationId !== reservationId ||
    expectedJob.status !== "printed" ||
    expectedJob.resultId !== printedResultId ||
    expectedJob.currentStateCommandKey !== currentStateCommandKey ||
    expectedJob.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "photo submission must bind the exact immutable printed Job",
    );
  }
  if (
    photoAsset?.id !== photoAssetId ||
    photoAsset.jobId !== jobId ||
    photoAsset.orderId !== orderId ||
    photoAsset.phaseId !== phaseId ||
    photoAsset.previousStatus !== "pending" ||
    photoAsset.targetStatus !== "stored" ||
    !(photoAsset.retentionDeadlineAt instanceof Instant) ||
    !photoAsset.retentionDeadlineAt.equals(retentionDeadlineAt) ||
    photoAsset.resultId !== resultId ||
    photoAsset.submissionResultId !== resultId ||
    photoAsset.immutable !== true ||
    context?.qcPhotoSubmissionJobResultId !== resultId ||
    context?.qcPhotoSubmissionPhotoAssetResultId !== resultId ||
    context?.qcPhotoSubmissionRetentionResultId !== resultId ||
    context?.qcPhotoSubmissionCompleted !== true ||
    context?.qcPhotoSubmissionAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "photo submission requires the exact retained PhotoAsset and one atomic result",
    );
  }
}

function requireExactQcDecision<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  outcome: "approved" | "rejected",
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const jobId = context?.jobId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const reservationId = context?.productionReservationId;
  const photoAssetId = context?.qcPhotoAssetId;
  const reviewerId = context?.qcDecisionReviewerId;
  const decisionId = context?.qcDecisionId;
  const resultId = context?.qcDecisionResultId;
  const submittedResultId = context?.qcDecisionSubmittedJobResultId;
  const currentStateCommandKey = command.currentStateCommandKey;
  const currentStateResultId = command.currentStateResultId;
  const targetStatus = outcome === "approved" ? "qc_approved" : "qc_rejected";
  const expectedJob = record(context?.qcDecisionExpectedJob);
  const photoAsset = record(context?.qcDecisionPhotoAsset);
  const reviewer = record(context?.qcDecisionReviewer);
  const decision = record(context?.qcDecision);
  if (
    !nonBlank(jobId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(reservationId) ||
    !nonBlank(photoAssetId) ||
    !nonBlank(reviewerId) ||
    !nonBlank(decisionId) ||
    !nonBlank(resultId) ||
    !nonBlank(submittedResultId) ||
    !nonBlank(currentStateCommandKey) ||
    !nonBlank(currentStateResultId) ||
    command.aggregateId !== jobId ||
    currentStateResultId !== submittedResultId ||
    context?.qcDecisionSubmittedStateCommandKey !== currentStateCommandKey ||
    context?.qcDecisionJobId !== jobId ||
    context?.qcDecisionOrderId !== orderId ||
    context?.qcDecisionPhaseId !== phaseId ||
    context?.qcDecisionReservationId !== reservationId ||
    context?.qcDecisionPhotoAssetId !== photoAssetId ||
    context?.qcDecisionPreviousJobStatus !== "photo_submitted" ||
    context?.qcDecisionTargetJobStatus !== targetStatus ||
    expectedJob?.id !== jobId ||
    expectedJob.orderId !== orderId ||
    expectedJob.phaseId !== phaseId ||
    expectedJob.productionReservationId !== reservationId ||
    expectedJob.photoAssetId !== photoAssetId ||
    expectedJob.status !== "photo_submitted" ||
    expectedJob.resultId !== submittedResultId ||
    expectedJob.currentStateCommandKey !== currentStateCommandKey ||
    expectedJob.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC decision must bind the exact immutable photo-submitted Job",
    );
  }
  if (
    photoAsset?.id !== photoAssetId ||
    photoAsset.jobId !== jobId ||
    photoAsset.orderId !== orderId ||
    photoAsset.phaseId !== phaseId ||
    photoAsset.status !== "stored" ||
    !(photoAsset.retentionDeadlineAt instanceof Instant) ||
    photoAsset.submissionResultId !== submittedResultId ||
    photoAsset.resultId !== submittedResultId ||
    photoAsset.immutable !== true ||
    reviewer?.id !== reviewerId ||
    reviewer.active !== true ||
    reviewer.authorized !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC decision requires the exact retained PhotoAsset and authorized reviewer",
    );
  }
  if (
    decision?.id !== decisionId ||
    decision.jobId !== jobId ||
    decision.orderId !== orderId ||
    decision.phaseId !== phaseId ||
    decision.productionReservationId !== reservationId ||
    decision.photoAssetId !== photoAssetId ||
    decision.reviewerId !== reviewerId ||
    decision.outcome !== outcome ||
    decision.previousJobStatus !== "photo_submitted" ||
    decision.targetJobStatus !== targetStatus ||
    decision.resultId !== resultId ||
    decision.sourceStateCommandKey !== currentStateCommandKey ||
    (outcome === "rejected" &&
      decision.replacementRequestId !==
        context?.qcRejectionReplacementRequestId) ||
    decision.immutable !== true ||
    context?.qcDecisionJobResultId !== resultId ||
    context?.qcDecisionPhotoAssetResultId !== submittedResultId ||
    context?.qcDecisionReviewerResultId !== resultId ||
    context?.qcDecisionRecordResultId !== resultId ||
    context?.qcDecisionCompleted !== true ||
    context?.qcDecisionAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC decision requires one exact immutable decision and atomic result",
    );
  }
}

function requireExactQcRejectionReplacement<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const value = context?.qcRejectionReplacementRequest;
  const request =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const jobId = context?.jobId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const reservationId = context?.productionReservationId;
  const decisionId = context?.qcDecisionId;
  const resultId = context?.qcDecisionResultId;
  const requestId = context?.qcRejectionReplacementRequestId;
  const sourceResultId = context?.qcDecisionSubmittedJobResultId;
  const sourceStateCommandKey = command.currentStateCommandKey;
  const createdAt = context?.qcRejectionReplacementCreatedAt;
  const deadlineAt = context?.qcRejectionReplacementDeadlineAt;
  if (
    command.current !== "photo_submitted" ||
    command.target !== "qc_rejected" ||
    !nonBlank(jobId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(reservationId) ||
    !nonBlank(decisionId) ||
    !nonBlank(resultId) ||
    !nonBlank(requestId) ||
    !nonBlank(sourceResultId) ||
    !nonBlank(sourceStateCommandKey) ||
    !(createdAt instanceof Instant) ||
    !(deadlineAt instanceof Instant) ||
    deadlineAt.compare(createdAt) <= 0 ||
    request?.id !== requestId ||
    request.jobId !== jobId ||
    request.orderId !== orderId ||
    request.phaseId !== phaseId ||
    request.productionReservationId !== reservationId ||
    request.qcDecisionId !== decisionId ||
    request.previousJobStatus !== "photo_submitted" ||
    request.targetJobStatus !== "qc_rejected" ||
    request.status !== "open" ||
    !(request.createdAt instanceof Instant) ||
    !request.createdAt.equals(createdAt) ||
    !(request.deadlineAt instanceof Instant) ||
    !request.deadlineAt.equals(deadlineAt) ||
    request.sourceJobResultId !== sourceResultId ||
    request.sourceStateCommandKey !== sourceStateCommandKey ||
    request.resultId !== resultId ||
    request.immutable !== true ||
    context?.qcRejectionReplacementJobResultId !== resultId ||
    context?.qcRejectionResourceSettlementResultId !== resultId ||
    context?.qcRejectionLabelBarrierResultId !== resultId ||
    context?.qcRejectionReplacementRequestResultId !== resultId ||
    context?.qcRejectionReplacementDeadlineResultId !== resultId ||
    context?.qcRejectionReplacementCompleted !== true ||
    context?.qcRejectionReplacementAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "QC rejection must create the exact Job replacement request and deadline in the decision result",
    );
  }
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
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const jobId = command.context?.jobId;
  const phaseId = command.context?.phaseId;
  const phaseKind = command.context?.phaseKind;
  const orderId = command.context?.orderId;
  const orderPreviousResultId =
    command.context?.postQcFailureOrderPreviousResultId;
  const orderStateKey =
    command.context?.postQcFailureOrderCurrentStateCommandKey;
  const expectedOrderValue = command.context?.postQcFailureExpectedOrder;
  const expectedOrder =
    typeof expectedOrderValue === "object" &&
    expectedOrderValue !== null &&
    !Array.isArray(expectedOrderValue)
      ? (expectedOrderValue as Readonly<Record<string, unknown>>)
      : undefined;
  const phasePreviousResultId =
    command.context?.postQcFailurePhasePreviousResultId;
  const phaseStateKey =
    command.context?.postQcFailurePhaseCurrentStateCommandKey;
  const expectedPhaseValue = command.context?.postQcFailureExpectedPhase;
  const expectedPhase =
    typeof expectedPhaseValue === "object" &&
    expectedPhaseValue !== null &&
    !Array.isArray(expectedPhaseValue)
      ? (expectedPhaseValue as Readonly<Record<string, unknown>>)
      : undefined;
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
    (lifecycle === "Order" &&
      (!nonBlank(orderPreviousResultId) ||
        !nonBlank(orderStateKey) ||
        command.aggregateId !== orderId ||
        command.currentStateResultId !== orderPreviousResultId ||
        command.currentStateCommandKey !== orderStateKey ||
        expectedOrder?.id !== orderId ||
        expectedOrder.phaseId !== phaseId ||
        expectedOrder.status !== command.current ||
        expectedOrder.resultId !== orderPreviousResultId ||
        expectedOrder.currentStateCommandKey !== orderStateKey ||
        expectedOrder.immutable !== true)) ||
    (lifecycle === "OrderPhase(single)" &&
      (!nonBlank(phasePreviousResultId) ||
        !nonBlank(phaseStateKey) ||
        command.aggregateId !== phaseId ||
        command.currentStateResultId !== phasePreviousResultId ||
        command.currentStateCommandKey !== phaseStateKey ||
        expectedPhase?.id !== phaseId ||
        expectedPhase.orderId !== orderId ||
        expectedPhase.status !== command.current ||
        expectedPhase.resultId !== phasePreviousResultId ||
        expectedPhase.currentStateCommandKey !== phaseStateKey ||
        expectedPhase.immutable !== true)) ||
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
  if (
    command.current === "photo_submitted" &&
    command.target === "qc_rejected"
  ) {
    requireExactQcRejectionReplacement(lifecycle, command);
  }
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
  const previousShipmentResultId =
    context?.plannedShipmentCancellationPreviousShipmentResultId;
  const stateKey = context?.plannedShipmentCancellationCurrentStateCommandKey;
  const shipmentValue = context?.plannedShipmentCancellationShipment;
  const shipment =
    typeof shipmentValue === "object" &&
    shipmentValue !== null &&
    !Array.isArray(shipmentValue)
      ? (shipmentValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedShipmentValue =
    context?.plannedShipmentCancellationExpectedShipment;
  const expectedShipment =
    typeof expectedShipmentValue === "object" &&
    expectedShipmentValue !== null &&
    !Array.isArray(expectedShipmentValue)
      ? (expectedShipmentValue as Readonly<Record<string, unknown>>)
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
    command.aggregateId !== shipmentId ||
    !nonBlank(command.currentStateCommandKey) ||
    command.currentStateCommandKey !== stateKey ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousShipmentResultId ||
    context?.plannedShipmentCancellationExpectedShipmentId !== shipmentId ||
    context?.plannedShipmentCancellationExpectedOrderId !== orderId ||
    context?.plannedShipmentCancellationExpectedPhaseId !== phaseId ||
    shipment?.id !== shipmentId ||
    shipment.orderId !== orderId ||
    shipment.phaseId !== phaseId ||
    shipment.previousStatus !== "planned" ||
    shipment.targetStatus !== "cancelled" ||
    shipment.resultId !== resultId ||
    expectedShipment?.id !== shipmentId ||
    expectedShipment.orderId !== orderId ||
    expectedShipment.phaseId !== phaseId ||
    expectedShipment.status !== "planned" ||
    expectedShipment.resultId !== previousShipmentResultId ||
    expectedShipment.currentStateCommandKey !== stateKey ||
    expectedShipment.immutable !== true ||
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
  const previousShipmentResultId =
    context?.shipmentCancellationCompletionPreviousShipmentResultId;
  const stateKey =
    context?.shipmentCancellationCompletionCurrentStateCommandKey;
  const expectedShipmentValue =
    context?.shipmentCancellationCompletionExpectedShipment;
  const expectedShipment =
    typeof expectedShipmentValue === "object" &&
    expectedShipmentValue !== null &&
    !Array.isArray(expectedShipmentValue)
      ? (expectedShipmentValue as Readonly<Record<string, unknown>>)
      : undefined;
  const requestValue = context?.shipmentCancellationRequest;
  const request =
    typeof requestValue === "object" &&
    requestValue !== null &&
    !Array.isArray(requestValue)
      ? (requestValue as Readonly<Record<string, unknown>>)
      : undefined;
  const requestId = context?.shipmentCancellationRequestId;
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
    !nonBlank(previousShipmentResultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== shipmentId ||
    command.currentStateResultId !== previousShipmentResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedShipment?.id !== shipmentId ||
    expectedShipment.status !== "cancellation_pending" ||
    expectedShipment.resultId !== previousShipmentResultId ||
    expectedShipment.currentStateCommandKey !== stateKey ||
    expectedShipment.immutable !== true ||
    !nonBlank(requestId) ||
    request?.id !== requestId ||
    request.shipmentId !== shipmentId ||
    request.carrierLabelId !== labelId ||
    request.previousStatus !== "label_created" ||
    request.targetStatus !== "cancellation_pending" ||
    request.resultId !== cancellationResultId ||
    request.immutable !== true ||
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
    context?.providerVoidOutboxCancellationRequestId !== requestId ||
    context?.providerVoidEventShipmentId !== shipmentId ||
    context?.providerVoidEventLabelId !== labelId ||
    context?.providerVoidEventOutboxId !== outboxId ||
    context?.providerVoidEventCancellationRequestId !== requestId ||
    context?.providerVoidTransactionShipmentId !== shipmentId ||
    context?.providerVoidTransactionLabelId !== labelId ||
    context?.providerVoidTransactionOutboxId !== outboxId ||
    context?.providerVoidTransactionCancellationRequestId !== requestId ||
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

function requireExactShipmentProviderOutcome<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const shipmentId = context?.shipmentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const labelId = context?.carrierLabelId;
  const providerEventId = context?.providerEventId;
  const providerTransactionId = context?.shipmentProviderTransactionId;
  const previousResultId = context?.shipmentProviderOutcomePreviousResultId;
  const resultId = context?.shipmentProviderOutcomeResultId;
  const stateKey = context?.shipmentProviderOutcomeCurrentStateCommandKey;
  const expectedValue = context?.shipmentProviderOutcomeExpectedShipment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const eventValue = context?.shipmentProviderOutcomeEvent;
  const event =
    typeof eventValue === "object" &&
    eventValue !== null &&
    !Array.isArray(eventValue)
      ? (eventValue as Readonly<Record<string, unknown>>)
      : undefined;
  const transactionValue = context?.shipmentProviderOutcomeTransaction;
  const transaction =
    typeof transactionValue === "object" &&
    transactionValue !== null &&
    !Array.isArray(transactionValue)
      ? (transactionValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    !nonBlank(shipmentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(labelId) ||
    !nonBlank(providerEventId) ||
    !nonBlank(providerTransactionId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(resultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== shipmentId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    context?.providerEventShipmentId !== shipmentId ||
    context?.providerEventTransactionId !== providerTransactionId ||
    context?.providerEventStatus !== command.target ||
    context?.providerEventAuthenticated !== true ||
    context?.providerEventVerified !== true ||
    expected?.id !== shipmentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.carrierLabelId !== labelId ||
    expected.status !== command.current ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true ||
    event?.id !== providerEventId ||
    event.shipmentId !== shipmentId ||
    event.carrierLabelId !== labelId ||
    event.transactionId !== providerTransactionId ||
    event.previousStatus !== command.current ||
    event.targetStatus !== command.target ||
    event.status !== command.target ||
    event.authenticated !== true ||
    event.verified !== true ||
    event.resultId !== resultId ||
    event.immutable !== true ||
    transaction?.id !== providerTransactionId ||
    transaction.shipmentId !== shipmentId ||
    transaction.carrierLabelId !== labelId ||
    transaction.eventId !== providerEventId ||
    transaction.status !== "succeeded" ||
    transaction.resultId !== resultId ||
    transaction.immutable !== true ||
    context?.shipmentProviderOutcomeShipmentResultId !== resultId ||
    context?.shipmentProviderOutcomeEventResultId !== resultId ||
    context?.shipmentProviderOutcomeTransactionResultId !== resultId ||
    context?.shipmentProviderOutcomeCompleted !== true ||
    context?.shipmentProviderOutcomeAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "shipment outcome requires the exact Shipment, authenticated provider event, transaction, and atomic result",
    );
  }
}

function requireVerifiedCurrentRemedyDelivery<S extends string>(
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
  const currentLeafId = context?.currentRemedyShipmentLineageLeafId;
  const eventShipmentId = context?.providerEventShipmentId;
  const providerEventId = context?.providerEventId;
  const resultId = context?.remedyDeliveryResultId;
  const previousResolutionResultId =
    context?.remedyDeliveryPreviousResolutionResultId;
  const stateKey = context?.remedyDeliveryCurrentStateCommandKey;
  const expectedResolutionValue = context?.remedyDeliveryExpectedResolution;
  const expectedResolution =
    typeof expectedResolutionValue === "object" &&
    expectedResolutionValue !== null &&
    !Array.isArray(expectedResolutionValue)
      ? (expectedResolutionValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedKind =
    command.current === "reship_shipped" &&
    command.target === "delivered_reship"
      ? "reship"
      : command.current === "replacement_shipped" &&
          command.target === "delivered_reprint"
        ? "reprint"
        : undefined;
  if (
    expectedKind === undefined ||
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(slotId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(currentLeafId) ||
    !nonBlank(providerEventId) ||
    !nonBlank(resultId) ||
    !nonBlank(previousResolutionResultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== resolutionId ||
    command.currentStateResultId !== previousResolutionResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedResolution?.id !== resolutionId ||
    expectedResolution.claimId !== claimId ||
    expectedResolution.slotId !== slotId ||
    expectedResolution.orderId !== orderId ||
    expectedResolution.phaseId !== phaseId ||
    expectedResolution.status !== command.current ||
    expectedResolution.resultId !== previousResolutionResultId ||
    expectedResolution.currentStateCommandKey !== stateKey ||
    expectedResolution.immutable !== true ||
    eventShipmentId !== currentLeafId ||
    context?.remedyDeliveryKind !== expectedKind ||
    context?.remedyDeliveryClaimId !== claimId ||
    context?.remedyDeliveryResolutionId !== resolutionId ||
    context?.remedyDeliverySlotId !== slotId ||
    context?.remedyDeliveryOrderId !== orderId ||
    context?.remedyDeliveryPhaseId !== phaseId ||
    context?.remedyDeliveryResolutionPreviousStatus !== command.current ||
    context?.remedyDeliveryResolutionTargetStatus !== command.target ||
    context?.remedyDeliveryShipmentId !== currentLeafId ||
    context?.remedyDeliveryLineageLeafId !== currentLeafId ||
    context?.remedyDeliveryShipmentClaimId !== claimId ||
    context?.remedyDeliveryShipmentResolutionId !== resolutionId ||
    context?.remedyDeliveryShipmentSlotId !== slotId ||
    context?.remedyDeliveryShipmentOrderId !== orderId ||
    context?.remedyDeliveryShipmentPhaseId !== phaseId ||
    context?.remedyDeliveryCurrentLineageLeaf !== true ||
    context?.remedyDeliveryShipmentPreviousStatus !== "in_transit" ||
    context?.remedyDeliveryShipmentTargetStatus !== "delivered" ||
    context?.remedyDeliveryProviderEventId !== providerEventId ||
    context?.remedyDeliveryProviderEventShipmentId !== currentLeafId ||
    context?.remedyDeliveryClaimResultId !== resultId ||
    context?.remedyDeliveryResolutionResultId !== resultId ||
    context?.remedyDeliveryShipmentResultId !== resultId ||
    context?.remedyDeliveryLineageResultId !== resultId ||
    context?.remedyDeliveryProviderEventResultId !== resultId ||
    context?.remedyDeliveryCompleted !== true ||
    context?.remedyDeliveryAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "delivery must bind the selected Claim child to its exact current Shipment leaf and result",
    );
  }
  if (context?.currentRemedyShipmentLineageLeafStatus !== "delivered") {
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
  if (context?.providerEventStatus !== "delivered") {
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
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const currentLeafId = context?.currentRemedyShipmentLineageLeafId;
  const eventShipmentId = context?.providerEventShipmentId;
  const providerEventId = context?.providerEventId;
  const providerTransactionId = context?.shipmentProviderTransactionId;
  const resultId = context?.remedyIncidentResultId;
  const previousResolutionResultId =
    context?.remedyIncidentPreviousResolutionResultId;
  const stateKey = context?.remedyIncidentCurrentStateCommandKey;
  const expectedResolutionValue = context?.remedyIncidentExpectedResolution;
  const expectedResolution =
    typeof expectedResolutionValue === "object" &&
    expectedResolutionValue !== null &&
    !Array.isArray(expectedResolutionValue)
      ? (expectedResolutionValue as Readonly<Record<string, unknown>>)
      : undefined;
  const eventStatus = context?.providerEventStatus;
  const expectedKind =
    command.current === "reship_shipped" &&
    command.target === "recovery_pending"
      ? "reship"
      : command.current === "replacement_shipped" &&
          command.target === "recovery_pending"
        ? "reprint"
        : undefined;
  if (
    expectedKind === undefined ||
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(slotId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(currentLeafId) ||
    !nonBlank(providerEventId) ||
    !nonBlank(providerTransactionId) ||
    !nonBlank(resultId) ||
    !nonBlank(previousResolutionResultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== resolutionId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResolutionResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedResolution?.id !== resolutionId ||
    expectedResolution.claimId !== claimId ||
    expectedResolution.slotId !== slotId ||
    expectedResolution.orderId !== orderId ||
    expectedResolution.phaseId !== phaseId ||
    expectedResolution.status !== command.current ||
    expectedResolution.resultId !== previousResolutionResultId ||
    expectedResolution.currentStateCommandKey !== stateKey ||
    expectedResolution.immutable !== true ||
    (eventStatus !== "lost" && eventStatus !== "returned") ||
    eventShipmentId !== currentLeafId ||
    context?.providerEventTransactionId !== providerTransactionId ||
    context?.remedyIncidentKind !== expectedKind ||
    context?.remedyIncidentClaimId !== claimId ||
    context?.remedyIncidentResolutionId !== resolutionId ||
    context?.remedyIncidentSlotId !== slotId ||
    context?.remedyIncidentOrderId !== orderId ||
    context?.remedyIncidentPhaseId !== phaseId ||
    context?.remedyIncidentResolutionPreviousStatus !== command.current ||
    context?.remedyIncidentResolutionTargetStatus !== "recovery_pending" ||
    context?.remedyIncidentShipmentId !== currentLeafId ||
    context?.remedyIncidentLineageLeafId !== currentLeafId ||
    context?.remedyIncidentShipmentClaimId !== claimId ||
    context?.remedyIncidentShipmentResolutionId !== resolutionId ||
    context?.remedyIncidentShipmentSlotId !== slotId ||
    context?.remedyIncidentShipmentOrderId !== orderId ||
    context?.remedyIncidentShipmentPhaseId !== phaseId ||
    context?.remedyIncidentCurrentLineageLeaf !== true ||
    context?.remedyIncidentShipmentPreviousStatus !== "in_transit" ||
    context?.remedyIncidentShipmentTargetStatus !== eventStatus ||
    context?.remedyIncidentProviderEventId !== providerEventId ||
    context?.remedyIncidentProviderEventShipmentId !== currentLeafId ||
    context?.remedyIncidentProviderTransactionId !== providerTransactionId ||
    context?.remedyIncidentClaimResultId !== resultId ||
    context?.remedyIncidentResolutionResultId !== resultId ||
    context?.remedyIncidentShipmentResultId !== resultId ||
    context?.remedyIncidentLineageResultId !== resultId ||
    context?.remedyIncidentProviderEventResultId !== resultId ||
    context?.remedyIncidentProviderTransactionResultId !== resultId ||
    context?.remedyIncidentCompleted !== true ||
    context?.remedyIncidentAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "remedy incident must bind the selected Claim child to its exact current Shipment leaf and result",
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
  if (context?.currentRemedyShipmentLineageLeafStatus !== eventStatus) {
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
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const quoteRequestId = context?.quoteRequestId;
  const issuedQuoteId = context?.issuedQuoteId;
  const issuedAt = context?.issuedQuoteIssuedAt;
  const expiresAt = context?.issuedQuoteExpiresAt;
  const resultId = context?.quoteIssuanceResultId;
  const requestPreviousResultId =
    context?.quoteIssuancePreviousQuoteRequestResultId;
  const requestStateKey = context?.quoteIssuanceCurrentStateCommandKey;
  const expectedRequestValue = context?.quoteIssuanceExpectedQuoteRequest;
  const expectedRequest =
    typeof expectedRequestValue === "object" &&
    expectedRequestValue !== null &&
    !Array.isArray(expectedRequestValue)
      ? (expectedRequestValue as Readonly<Record<string, unknown>>)
      : undefined;
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
    (command.current === "in_review" &&
      command.target === "quoted" &&
      (!nonBlank(requestPreviousResultId) ||
        !nonBlank(requestStateKey) ||
        command.aggregateId !== quoteRequestId ||
        !nonBlank(command.currentStateResultId) ||
        command.currentStateResultId !== requestPreviousResultId ||
        command.currentStateCommandKey !== requestStateKey ||
        expectedRequest?.id !== quoteRequestId ||
        expectedRequest.status !== "in_review" ||
        expectedRequest.resultId !== requestPreviousResultId ||
        expectedRequest.currentStateCommandKey !== requestStateKey ||
        expectedRequest.immutable !== true)) ||
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
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const quoteRequestId = context?.quoteRequestId;
  const issuedQuoteId = context?.issuedQuoteId;
  const issuedAt = context?.issuedQuoteIssuedAt;
  const expiresAt = context?.issuedQuoteExpiresAt;
  const evaluatedAt = context?.quoteAcceptanceEvaluatedAt;
  const resultId = context?.quoteAcceptanceResultId;
  const requestPreviousResultId =
    context?.quoteAcceptancePreviousQuoteRequestResultId;
  const requestStateKey = context?.quoteAcceptanceCurrentStateCommandKey;
  const expectedRequestValue = context?.quoteAcceptanceExpectedQuoteRequest;
  const expectedRequest =
    typeof expectedRequestValue === "object" &&
    expectedRequestValue !== null &&
    !Array.isArray(expectedRequestValue)
      ? (expectedRequestValue as Readonly<Record<string, unknown>>)
      : undefined;
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
    !nonBlank(requestPreviousResultId) ||
    !nonBlank(requestStateKey) ||
    command.aggregateId !== quoteRequestId ||
    command.currentStateResultId !== requestPreviousResultId ||
    command.currentStateCommandKey !== requestStateKey ||
    expectedRequest?.id !== quoteRequestId ||
    expectedRequest.status !== "quoted" ||
    expectedRequest.resultId !== requestPreviousResultId ||
    expectedRequest.currentStateCommandKey !== requestStateKey ||
    expectedRequest.immutable !== true ||
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
  requireAtomicIssuedQuoteCreation(lifecycle, command);
  const quoteRequestId = command.context?.quoteRequestId;
  const issuedQuoteId = command.context?.issuedQuoteId;
  const expiresAt = command.context?.issuedQuoteExpiresAt;
  const evaluatedAt = command.context?.quoteExpirationEvaluatedAt;
  const previousResultId =
    command.context?.quoteExpirationPreviousQuoteRequestResultId;
  const stateKey = command.context?.quoteExpirationCurrentStateCommandKey;
  const expectedRequestValue =
    command.context?.quoteExpirationExpectedQuoteRequest;
  const expectedRequest =
    typeof expectedRequestValue === "object" &&
    expectedRequestValue !== null &&
    !Array.isArray(expectedRequestValue)
      ? (expectedRequestValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    typeof quoteRequestId !== "string" ||
    quoteRequestId.trim().length === 0 ||
    command.context?.issuedQuoteRequestId !== quoteRequestId ||
    command.context?.quoteExpirationQuoteRequestId !== quoteRequestId ||
    typeof issuedQuoteId !== "string" ||
    issuedQuoteId.trim().length === 0 ||
    command.context?.quoteExpirationIssuedQuoteId !== issuedQuoteId ||
    typeof previousResultId !== "string" ||
    previousResultId.trim().length === 0 ||
    typeof stateKey !== "string" ||
    stateKey.trim().length === 0 ||
    command.aggregateId !== quoteRequestId ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedRequest?.id !== quoteRequestId ||
    expectedRequest.status !== "quoted" ||
    expectedRequest.resultId !== previousResultId ||
    expectedRequest.currentStateCommandKey !== stateKey ||
    expectedRequest.immutable !== true
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

function requireExactPaymentIntentSetup<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const providerTransactionId =
    context?.paymentIntentSetupProviderTransactionId;
  const authorizationId = context?.paymentIntentSetupAuthorizationId;
  const captureWindowId = context?.paymentIntentSetupCaptureWindowId;
  const previousPaymentResultId =
    context?.paymentIntentSetupPreviousPaymentResultId;
  const stateKey = context?.paymentIntentSetupCurrentStateCommandKey;
  const resultId = context?.paymentIntentSetupResultId;
  const expectedPayment = record(context?.paymentIntentSetupExpectedPayment);
  const activatedPayment = record(context?.paymentIntentSetupActivatedPayment);
  const providerTransaction = record(
    context?.paymentIntentSetupProviderTransaction,
  );
  const authorization = record(context?.paymentIntentSetupAuthorization);
  const captureWindow = record(context?.paymentIntentSetupCaptureWindow);
  const order = record(context?.paymentIntentSetupOrder);
  const phase = record(context?.paymentIntentSetupPhase);
  const captureExpiresAt = context?.paymentIntentSetupCaptureExpiresAt;
  const persistedCaptureExpiresAt =
    role === "balance"
      ? context?.balanceDueAt
      : context?.checkoutCaptureExpiresAt;
  const expectedWindowKind =
    role === "balance" ? "balance_deadline" : "checkout";
  const expectedOrderStatus =
    role === "balance" ? "awaiting_balance" : "quoted";
  const expectedPhaseStatus = role === "balance" ? "qc_passed" : "quoted";

  if (
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit" && role !== "balance") ||
    !nonBlank(providerTransactionId) ||
    !nonBlank(authorizationId) ||
    !nonBlank(captureWindowId) ||
    !nonBlank(previousPaymentResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(resultId) ||
    !(captureExpiresAt instanceof Instant) ||
    !(persistedCaptureExpiresAt instanceof Instant) ||
    !captureExpiresAt.equals(persistedCaptureExpiresAt) ||
    command.aggregateId !== paymentId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousPaymentResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedPayment?.id !== paymentId ||
    expectedPayment.orderId !== orderId ||
    expectedPayment.phaseId !== phaseId ||
    expectedPayment.role !== role ||
    expectedPayment.status !== "created" ||
    expectedPayment.providerTransactionId !== providerTransactionId ||
    expectedPayment.authorizationId !== authorizationId ||
    expectedPayment.captureWindowId !== captureWindowId ||
    !(expectedPayment.captureExpiresAt instanceof Instant) ||
    !expectedPayment.captureExpiresAt.equals(captureExpiresAt) ||
    expectedPayment.resultId !== previousPaymentResultId ||
    expectedPayment.currentStateCommandKey !== stateKey ||
    expectedPayment.immutable !== true ||
    activatedPayment?.id !== paymentId ||
    activatedPayment.orderId !== orderId ||
    activatedPayment.phaseId !== phaseId ||
    activatedPayment.role !== role ||
    activatedPayment.previousStatus !== "created" ||
    activatedPayment.targetStatus !== "pending" ||
    activatedPayment.providerTransactionId !== providerTransactionId ||
    activatedPayment.authorizationId !== authorizationId ||
    activatedPayment.captureWindowId !== captureWindowId ||
    activatedPayment.resultId !== resultId ||
    activatedPayment.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Payment activation must bind the command-selected immutable created Payment",
    );
  }

  if (
    providerTransaction?.id !== providerTransactionId ||
    providerTransaction.paymentId !== paymentId ||
    providerTransaction.orderId !== orderId ||
    providerTransaction.phaseId !== phaseId ||
    providerTransaction.role !== role ||
    providerTransaction.status !== "intent_created" ||
    providerTransaction.authorizationId !== authorizationId ||
    providerTransaction.resultId !== resultId ||
    providerTransaction.immutable !== true ||
    authorization?.id !== authorizationId ||
    authorization.paymentId !== paymentId ||
    authorization.providerTransactionId !== providerTransactionId ||
    authorization.status !== "authorized" ||
    authorization.captureCutoffAt !== null ||
    authorization.resultId !== resultId ||
    authorization.immutable !== true ||
    captureWindow?.id !== captureWindowId ||
    captureWindow.paymentId !== paymentId ||
    captureWindow.orderId !== orderId ||
    captureWindow.phaseId !== phaseId ||
    captureWindow.role !== role ||
    captureWindow.kind !== expectedWindowKind ||
    captureWindow.status !== "open" ||
    captureWindow.authorizationId !== authorizationId ||
    !(captureWindow.cutoffAt instanceof Instant) ||
    !captureWindow.cutoffAt.equals(captureExpiresAt) ||
    captureWindow.resultId !== resultId ||
    captureWindow.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Payment activation requires its exact provider intent, authorization, and immutable capture window",
    );
  }

  if (
    order?.id !== orderId ||
    order.phaseId !== phaseId ||
    order.status !== expectedOrderStatus ||
    order.resultId !== resultId ||
    order.immutable !== true ||
    phase?.id !== phaseId ||
    phase.orderId !== orderId ||
    phase.kind !== "single" ||
    phase.status !== expectedPhaseStatus ||
    phase.resultId !== resultId ||
    phase.immutable !== true ||
    context?.paymentIntentSetupPaymentResultId !== resultId ||
    context?.paymentIntentSetupProviderTransactionResultId !== resultId ||
    context?.paymentIntentSetupAuthorizationResultId !== resultId ||
    context?.paymentIntentSetupCaptureWindowResultId !== resultId ||
    context?.paymentIntentSetupOrderResultId !== resultId ||
    context?.paymentIntentSetupPhaseResultId !== resultId ||
    context?.paymentIntentSetupCompleted !== true ||
    context?.paymentIntentSetupAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Payment activation must atomically commit its exact Payment, intent, window, Order, and phase topology",
    );
  }
}

function requireCreatedPaymentVoidClosure<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const paymentId = context?.paymentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const role = context?.paymentRole;
  const previousPaymentResultId =
    context?.createdPaymentVoidPreviousPaymentResultId;
  const paymentStateKey = context?.createdPaymentVoidCurrentStateCommandKey;
  const previousOrderResultId =
    context?.initialCaptureClosePreviousOrderResultId;
  const orderStateKey = context?.initialCaptureCloseOrderCurrentStateCommandKey;
  const previousPhaseResultId =
    context?.createdPaymentVoidPreviousPhaseResultId;
  const phaseStateKey = context?.createdPaymentVoidPhaseCurrentStateCommandKey;
  const resultId = context?.createdPaymentVoidResultId;
  const reservationSetId = context?.phaseReservationSetId;
  const orderTarget = context?.initialCaptureCloseOrderTargetStatus;
  const expectedReason =
    orderTarget === "expired" ? "checkout_expired" : "checkout_cancelled";
  const expectedPayment = record(context?.createdPaymentVoidExpectedPayment);
  const voidedPayment = record(context?.createdPaymentVoidVoidedPayment);
  const expectedOrder = record(context?.initialCaptureCloseExpectedOrder);
  const expectedPhase = record(context?.createdPaymentVoidExpectedPhase);

  if (
    !nonBlank(paymentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    (role !== "full" && role !== "deposit") ||
    !nonBlank(previousPaymentResultId) ||
    !nonBlank(paymentStateKey) ||
    !nonBlank(previousOrderResultId) ||
    !nonBlank(orderStateKey) ||
    !nonBlank(previousPhaseResultId) ||
    !nonBlank(phaseStateKey) ||
    !nonBlank(resultId) ||
    !nonBlank(reservationSetId) ||
    command.aggregateId !== paymentId ||
    command.currentStateResultId !== previousPaymentResultId ||
    command.currentStateCommandKey !== paymentStateKey ||
    expectedPayment?.id !== paymentId ||
    expectedPayment.orderId !== orderId ||
    expectedPayment.phaseId !== phaseId ||
    expectedPayment.role !== role ||
    expectedPayment.status !== "created" ||
    expectedPayment.providerIntentId !== null ||
    expectedPayment.resultId !== previousPaymentResultId ||
    expectedPayment.currentStateCommandKey !== paymentStateKey ||
    expectedPayment.immutable !== true ||
    voidedPayment?.id !== paymentId ||
    voidedPayment.orderId !== orderId ||
    voidedPayment.phaseId !== phaseId ||
    voidedPayment.role !== role ||
    voidedPayment.previousStatus !== "created" ||
    voidedPayment.targetStatus !== "voided" ||
    voidedPayment.providerIntentId !== null ||
    voidedPayment.captureAuthorized !== false ||
    !(voidedPayment.captureCutoffAt instanceof Instant) ||
    voidedPayment.resultId !== resultId ||
    voidedPayment.immutable !== true ||
    expectedOrder?.id !== orderId ||
    expectedOrder.status !== "quoted" ||
    expectedOrder.resultId !== previousOrderResultId ||
    expectedOrder.currentStateCommandKey !== orderStateKey ||
    expectedOrder.immutable !== true ||
    expectedPhase?.id !== phaseId ||
    expectedPhase.orderId !== orderId ||
    expectedPhase.kind !== "single" ||
    expectedPhase.status !== "quoted" ||
    expectedPhase.resultId !== previousPhaseResultId ||
    expectedPhase.currentStateCommandKey !== phaseStateKey ||
    expectedPhase.immutable !== true ||
    context?.createdPaymentVoidProviderIntentAbsent !== true ||
    context?.createdPaymentVoidProviderTransactionAbsent !== true ||
    context?.createdPaymentVoidProviderVoidOutboxAbsent !== true ||
    context?.initialPaymentRole !== role ||
    context?.initialPaymentId !== paymentId ||
    context?.initialPaymentOrderId !== orderId ||
    context?.initialPaymentStatus !== "voided" ||
    context?.initialCaptureClosePaymentId !== paymentId ||
    context?.initialCaptureCloseOrderId !== orderId ||
    context?.initialCaptureClosePhaseId !== phaseId ||
    context?.initialCaptureClosePhaseOrderId !== orderId ||
    context?.phaseKind !== "single" ||
    context?.initialCaptureCloseReservationSetId !== reservationSetId ||
    context?.initialCaptureCloseReservationSetOrderId !== orderId ||
    context?.initialCaptureCloseReservationSetPhaseId !== phaseId ||
    context?.initialCaptureCloseOrderPreviousStatus !== "quoted" ||
    (orderTarget !== "expired" && orderTarget !== "cancelled") ||
    context?.initialCaptureClosePhasePreviousStatus !== "quoted" ||
    context?.initialCaptureClosePhaseTargetStatus !== "cancelled" ||
    context?.initialCaptureCloseReason !== expectedReason ||
    context?.createdPaymentVoidPaymentResultId !== resultId ||
    context?.createdPaymentVoidOrderResultId !== resultId ||
    context?.createdPaymentVoidPhaseResultId !== resultId ||
    context?.createdPaymentVoidReservationResultId !== resultId ||
    context?.createdPaymentVoidCompleted !== true ||
    context?.createdPaymentVoidAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "created Payment voiding requires its exact no-intent Payment, quoted checkout, cancellation result, and atomic evidence",
    );
  }

  for (const [flag, reason] of [
    [
      "captureAuthorizationDisabled",
      "created Payment voiding requires capture authorization to be disabled",
    ],
    [
      "captureWindowClosed",
      "created Payment voiding requires its capture window to be closed",
    ],
    [
      "captureCutoffSet",
      "created Payment voiding requires its capture cutoff to be recorded",
    ],
    [
      "initialCaptureWindowClosed",
      "created Payment voiding requires its initial capture window closure",
    ],
    [
      "initialCaptureCutoffSet",
      "created Payment voiding requires its immutable initial cutoff",
    ],
    [
      "preCapturePhaseCancelled",
      "created Payment voiding requires phase cancellation",
    ],
    [
      "preCaptureFulfilmentSlotsCancelled",
      "created Payment voiding requires slot cancellation",
    ],
    [
      "preCaptureReservationsReleased",
      "created Payment voiding requires reservation release",
    ],
    [
      "initialCaptureCloseAtomic",
      "created Payment voiding requires atomic checkout closure",
    ],
  ] as const) {
    requireFlag(lifecycle, command, flag, reason);
  }
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
  const previousResultId = command.context?.paymentVoidPreviousPaymentResultId;
  const stateKey = command.context?.paymentVoidCurrentStateCommandKey;
  const expectedValue = command.context?.paymentVoidExpectedPayment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    typeof paymentId !== "string" ||
    paymentId.trim().length === 0 ||
    command.aggregateId !== paymentId ||
    typeof previousResultId !== "string" ||
    previousResultId.trim().length === 0 ||
    typeof stateKey !== "string" ||
    stateKey.trim().length === 0 ||
    typeof command.currentStateResultId !== "string" ||
    command.currentStateResultId.trim().length === 0 ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
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
    command.context?.paymentVoidTargetStatus !== "voided" ||
    expected?.id !== paymentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.role !== paymentRole ||
    expected.status !== "pending" ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true
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
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const paymentId = command.context?.paymentId;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const paymentRole = command.context?.paymentRole;
  const providerTransactionId = command.context?.providerPaymentTransactionId;
  const priceAdjustmentId = command.context?.priceAdjustmentId;
  const refundTransactionId = command.context?.refundTransactionId;
  const amountMinor = command.context?.ordinaryRefundAmountMinor;
  const previousResultId =
    command.context?.ordinaryRefundPreviousPaymentResultId;
  const stateKey = command.context?.ordinaryRefundCurrentStateCommandKey;
  const expectedValue = command.context?.ordinaryRefundExpectedPayment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    typeof paymentId !== "string" ||
    paymentId.trim().length === 0 ||
    command.aggregateId !== paymentId ||
    typeof previousResultId !== "string" ||
    previousResultId.trim().length === 0 ||
    typeof stateKey !== "string" ||
    stateKey.trim().length === 0 ||
    command.currentStateCommandKey !== stateKey ||
    command.context?.ordinaryRefundPaymentId !== paymentId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    command.context?.ordinaryRefundOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    (paymentRole !== "full" &&
      paymentRole !== "deposit" &&
      paymentRole !== "balance") ||
    (command.current !== "captured" &&
      command.current !== "partially_refunded") ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    expected?.id !== paymentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.role !== paymentRole ||
    expected.status !== command.current ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true ||
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
  terminal: ["refunded"],
  contextualTerminal: (state, context) =>
    hasExactNoIntentPaymentTerminalSnapshot(state, context),
  transitions: {
    created: ["pending", "failed", "voided"],
    pending: ["captured", "failed", "voided", "refund_pending"],
    failed: ["refund_pending"],
    captured: ["refund_pending"],
    partially_refunded: ["refund_pending"],
    voided: ["refund_pending"],
    refund_pending: ["captured", "partially_refunded", "refunded"],
  },
  guard: (command) => {
    if (command.current === "created" && command.target === "pending") {
      requireExactPaymentIntentSetup("Payment", command);
    }
    if (command.current === "created" && command.target === "failed") {
      requireExactPaymentIntentCreationFailure("Payment", command);
    }
    if (command.current === "created" && command.target === "voided") {
      requireCreatedPaymentVoidClosure("Payment", command);
    }
    if (command.current === "pending" && command.target === "captured") {
      if (command.context?.paymentCaptureKind !== "settlement") {
        throw new TransitionGuardError(
          "Payment",
          command.current,
          command.target,
          "ordinary capture requires a settlement Payment",
        );
      }
      requireExactPendingCaptureWindow("Payment", command, "within_window");
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
      if (command.context?.paymentCaptureKind === "late_capture") {
        requireExactPendingCaptureWindow("Payment", command, "expired");
        requireVerifiedLateCaptureCompensation("Payment", command);
      } else {
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
    }
    if (command.current === "voided" && command.target === "refund_pending") {
      requireVerifiedLateCaptureCompensation("Payment", command);
    }
    if (command.current === "failed" && command.target === "refund_pending") {
      requireVerifiedLateCaptureCompensation("Payment", command);
    }
    if (command.current === "pending" && command.target === "failed") {
      requireVerifiedMatchingProviderPaymentEvent("Payment", command);
      requireExactPendingPaymentFailure("Payment", command);
    }
    if (command.current === "pending" && command.target === "voided") {
      requireRoleSpecificPaymentVoidClosure("Payment", command);
    }
    if (command.current === "captured" && command.target === "refund_pending") {
      if (command.context?.paymentCaptureKind === "late_refund_success") {
        requireExactLateRefundSuccessReconciliation(
          "Payment",
          command,
          "start",
        );
      } else if (command.context?.paymentCaptureKind !== "settlement") {
        throw new TransitionGuardError(
          "Payment",
          command.current,
          command.target,
          "ordinary refund requires a settlement Payment",
        );
      } else {
        requireExactOrdinaryRefundSetup("Payment", command);
      }
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
      } else if (captureKind === "late_refund_success") {
        requireExactLateRefundSuccessReconciliation(
          "Payment",
          command,
          "start",
        );
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
      command.target === "partially_refunded" &&
      command.context?.paymentCaptureKind === "refund_failure_rollback"
    ) {
      requireExactRefundFailureRollback("Payment", command);
    } else if (
      command.current === "refund_pending" &&
      (command.target === "partially_refunded" || command.target === "refunded")
    ) {
      requireExactPaymentRefundCompletion("Payment", command);
    }
    if (command.current === "refund_pending" && command.target === "captured") {
      requireExactRefundFailureRollback("Payment", command);
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
    "cancelled_settled",
    "expired",
  ],
  contextualTerminal: (state, context) =>
    (state === "refunded" &&
      !hasExactRefundedCancellationRecoveryMarker(context)) ||
    (state === "cancelled" && context?.paymentStatus === "unpaid"),
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
    cancelled: ["shipped", "refunded", "cancelled_settled"],
    refunded: ["shipped"],
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
      requireBalancePaymentDeadlineSetup("Order", command, true);
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
    if (command.current === "cancelled" && command.target === "shipped") {
      requireVerifiedMatchingCancellationRaceScan("Order", command);
      requireExactCancellationRaceHandoffResult("Order", command);
    }
    if (command.current === "refunded" && command.target === "shipped") {
      requireVerifiedMatchingCancellationRaceScan("Order", command);
      requireExactCancellationRaceHandoffResult("Order", command);
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
    terminal: ["completed", "cancelled_settled", "partially_fulfilled"],
    contextualTerminal: (state, context) =>
      (state === "cancelled_refunded" &&
        !hasExactRefundedCancellationRecoveryMarker(context)) ||
      (state === "cancelled" && context?.paymentStatus === "unpaid"),
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
      cancelled: ["shipped", "cancelled_refunded", "cancelled_settled"],
      cancelled_refunded: ["shipped"],
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
      if (command.current === "cancelled" && command.target === "shipped") {
        requireVerifiedMatchingCancellationRaceScan(
          "OrderPhase(single)",
          command,
        );
        requireExactCancellationRaceHandoffResult(
          "OrderPhase(single)",
          command,
        );
      }
      if (
        command.current === "cancelled_refunded" &&
        command.target === "shipped"
      ) {
        requireVerifiedMatchingCancellationRaceScan(
          "OrderPhase(single)",
          command,
        );
        requireExactCancellationRaceHandoffResult(
          "OrderPhase(single)",
          command,
        );
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
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const jobId = command.context?.jobId;
  const shipmentId = command.context?.shipmentId;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const lineageLeafId = command.context?.currentJobShipmentLineageLeafId;
  const evaluatedAt = command.context?.jobSettlementEvaluatedAt;
  const previousResultId = command.context?.jobSettlementPreviousJobResultId;
  const resultId = command.context?.jobSettlementResultId;
  const stateKey = command.context?.jobSettlementCurrentStateCommandKey;
  const expectedValue = command.context?.jobSettlementExpectedJob;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const slotSetId = command.context?.jobSettlementAuthoritativeSlotSetId;
  const slotSetResultId =
    command.context?.jobSettlementAuthoritativeSlotSetResultId;
  const slotSetValue = command.context?.jobSettlementAuthoritativeSlotSet;
  const slotSet =
    typeof slotSetValue === "object" &&
    slotSetValue !== null &&
    !Array.isArray(slotSetValue)
      ? (slotSetValue as Readonly<Record<string, unknown>>)
      : undefined;
  const authoritativeSlotIdsValue = slotSet?.slotIds;
  const authoritativeSlotIds = Array.isArray(authoritativeSlotIdsValue)
    ? [...authoritativeSlotIdsValue]
    : undefined;
  const authoritativeSlotsValue = slotSet?.slotSnapshots;
  const authoritativeSlots = Array.isArray(authoritativeSlotsValue)
    ? [...authoritativeSlotsValue]
    : undefined;
  const expectedSlotIdsValue = command.context?.expectedJobSettlementSlotIds;
  const slotsValue = command.context?.jobSettlementSlots;
  const expectedSlotIds = Array.isArray(expectedSlotIdsValue)
    ? [...expectedSlotIdsValue]
    : undefined;
  const slots = Array.isArray(slotsValue) ? [...slotsValue] : undefined;
  if (
    !nonBlank(jobId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(resultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== jobId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    command.context?.jobSettlementJobId !== jobId ||
    command.context?.jobSettlementPreviousStatus !== "handed_over" ||
    command.context?.jobSettlementTargetStatus !== "settled" ||
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
    expected?.id !== jobId ||
    expected.shipmentId !== shipmentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.status !== "handed_over" ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.currentLineageLeaf !== true ||
    expected.immutable !== true ||
    !nonBlank(slotSetId) ||
    !nonBlank(slotSetResultId) ||
    command.ownershipSnapshotId !== slotSetId ||
    command.ownershipSnapshotResultId !== slotSetResultId ||
    command.context?.jobSettlementExpectedSlotSetId !== slotSetId ||
    expected.slotSetId !== slotSetId ||
    expected.slotSetResultId !== slotSetResultId ||
    slotSet?.id !== slotSetId ||
    slotSet.jobId !== jobId ||
    slotSet.shipmentId !== shipmentId ||
    slotSet.orderId !== orderId ||
    slotSet.phaseId !== phaseId ||
    slotSet.previousJobResultId !== previousResultId ||
    slotSet.currentStateCommandKey !== stateKey ||
    slotSet.resultId !== slotSetResultId ||
    slotSet.immutable !== true ||
    authoritativeSlotIds === undefined ||
    authoritativeSlots === undefined ||
    authoritativeSlots.length !== authoritativeSlotIds.length ||
    command.context?.jobSettlementJobResultId !== resultId ||
    command.context?.jobSettlementShipmentResultId !== resultId ||
    command.context?.jobSettlementLineageResultId !== resultId ||
    command.context?.jobSettlementSlotSetResultId !== resultId ||
    !(evaluatedAt instanceof Instant) ||
    expectedSlotIds === undefined ||
    !hasSameNonEmptyStringSet(expectedSlotIds, authoritativeSlotIds) ||
    slots === undefined ||
    slots.length !== authoritativeSlotIds.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job settlement requires its exact delivered Shipment lineage and complete slot set",
    );
  }
  const authoritativeSlotIdList = authoritativeSlotIds as string[];
  const authoritativeSlotById = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const value of authoritativeSlots) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Job settlement requires immutable per-slot source snapshots",
      );
    }
    const slot = value as Readonly<Record<string, unknown>>;
    const id = slot.id;
    if (
      !nonBlank(id) ||
      !authoritativeSlotIdList.includes(id) ||
      authoritativeSlotById.has(id) ||
      slot.slotSetId !== slotSetId ||
      slot.jobId !== jobId ||
      slot.shipmentId !== shipmentId ||
      slot.orderId !== orderId ||
      slot.phaseId !== phaseId ||
      slot.status !== "delivered" ||
      !nonBlank(slot.resultId) ||
      !nonBlank(slot.currentStateCommandKey) ||
      !(slot.claimUntil instanceof Instant) ||
      slot.immutable !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Job settlement requires an exact immutable authoritative slot set",
      );
    }
    authoritativeSlotById.set(id, slot);
  }
  if (authoritativeSlotById.size !== authoritativeSlotIdList.length) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job settlement authoritative slot set must be a complete bijection",
    );
  }
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
    const source =
      typeof id === "string" ? authoritativeSlotById.get(id) : undefined;
    const sourceClaimUntil = source?.claimUntil;
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
      source === undefined ||
      slot.jobId !== jobId ||
      slot.shipmentId !== shipmentId ||
      slot.orderId !== orderId ||
      slot.phaseId !== phaseId ||
      slot.slotSetId !== slotSetId ||
      slot.status !== source.status ||
      slot.resultId !== resultId ||
      slot.currentStateCommandKey !== source.currentStateCommandKey ||
      slot.immutable !== true ||
      !(claimUntil instanceof Instant) ||
      !(sourceClaimUntil instanceof Instant) ||
      claimUntil.compare(sourceClaimUntil) !== 0 ||
      slot.sourceResultId !== source.resultId ||
      slot.sourceCurrentStateCommandKey !== source.currentStateCommandKey ||
      slot.settlementResultId !== resultId ||
      slot.resolvedClaimId !== source.resolvedClaimId ||
      slot.resolvedClaimStatus !== source.resolvedClaimStatus ||
      slot.resolvedClaimSlotId !== source.resolvedClaimSlotId ||
      slot.resolvedClaimShipmentId !== source.resolvedClaimShipmentId ||
      slot.resolvedClaimOrderId !== source.resolvedClaimOrderId ||
      slot.resolvedClaimPhaseId !== source.resolvedClaimPhaseId ||
      slot.resolvedClaimPreviousActiveClaimId !==
        source.resolvedClaimPreviousActiveClaimId ||
      slot.resolvedClaimTargetActiveClaimId !==
        source.resolvedClaimTargetActiveClaimId ||
      slot.activeClaimId !== source.activeClaimId ||
      slot.claimRetentionHoldReleased !== source.claimRetentionHoldReleased ||
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
  if (authoritativeSlotIdList.some((id) => !projectedSlotIds.has(id))) {
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

function requireExactJobHandoff<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const kind = context?.jobHandoffKind;
  const jobId = context?.jobId;
  const cancelledSourceRecovery =
    context?.cancellationRaceCommittedCancellation === true ||
    context?.cancellationRaceRefundedAggregate === true;
  const expectedJobStatus = cancelledSourceRecovery ? "cancelled" : "packed";
  const expectedValue = context?.jobHandoffExpectedJob;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedShipmentValue = context?.cancellationRaceExpectedShipment;
  const expectedShipment =
    typeof expectedShipmentValue === "object" &&
    expectedShipmentValue !== null &&
    !Array.isArray(expectedShipmentValue)
      ? (expectedShipmentValue as Readonly<Record<string, unknown>>)
      : undefined;
  const jobCancelledAt = expected?.cancelledAt;
  const shipmentCancelledAt = expectedShipment?.cancelledAt;
  if (
    !nonBlank(jobId) ||
    command.current !== expectedJobStatus ||
    expected?.id !== jobId ||
    expected.kind !== kind ||
    expected.status !== expectedJobStatus ||
    (cancelledSourceRecovery &&
      (!(jobCancelledAt instanceof Instant) ||
        expected.cancellationReason !== "order_cancelled" ||
        !(shipmentCancelledAt instanceof Instant) ||
        jobCancelledAt.compare(shipmentCancelledAt) < 0)) ||
    expected.currentLineageLeaf !== true ||
    expected.immutable !== true ||
    context?.jobHandoffJobId !== jobId ||
    context?.jobHandoffPreviousStatus !== expectedJobStatus ||
    context?.jobHandoffTargetStatus !== "handed_over" ||
    context?.jobHandoffCompleted !== true ||
    context?.jobHandoffAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Job handoff must bind the exact current Job and result",
    );
  }
  if (kind === "ordinary") {
    const raceKind = context?.cancellationRaceHandoffKind;
    if (raceKind !== undefined) {
      const raceResultId = context?.cancellationRaceHandoffResultId;
      const stateKey = context?.jobHandoffCurrentStateCommandKey;
      const previousResultId = context?.jobHandoffPreviousResultId;
      if (
        (raceKind !== "ordinary" &&
          raceKind !== "unauthorized_reconciliation") ||
        !nonBlank(raceResultId) ||
        !nonBlank(stateKey) ||
        !nonBlank(previousResultId) ||
        command.aggregateId !== jobId ||
        command.currentStateResultId !== previousResultId ||
        command.currentStateCommandKey !== stateKey ||
        expected.currentStateCommandKey !== stateKey ||
        expected.resultId !== previousResultId ||
        expected.shipmentId !== context?.shipmentId ||
        expected.claimId !== null ||
        expected.resolutionId !== null ||
        expected.replacementSetId !== null ||
        context?.jobHandoffShipmentId !== context?.shipmentId ||
        context?.jobHandoffClaimId !== null ||
        context?.jobHandoffResolutionId !== null ||
        context?.jobHandoffReplacementSetId !== null ||
        context?.jobHandoffResultId !== raceResultId ||
        context?.jobHandoffJobResultId !== raceResultId
      ) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          "Job cancellation-race handoff must bind the command-selected source Job to the exact race result",
        );
      }
      requireVerifiedMatchingCancellationRaceScan(lifecycle, command);
      requireExactCancellationRaceHandoffResult(lifecycle, command);
      return;
    }
    if (
      expected.shipmentId !== context?.shipmentId ||
      expected.claimId !== null ||
      expected.resolutionId !== null ||
      expected.replacementSetId !== null ||
      context?.jobHandoffClaimId !== null ||
      context?.jobHandoffResolutionId !== null ||
      context?.jobHandoffReplacementSetId !== null ||
      context?.jobHandoffResultId !== context?.handoffResultId ||
      context?.jobHandoffJobResultId !== context?.handoffResultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "ordinary Job handoff cannot carry Claim-replacement provenance",
      );
    }
    const stateKey = context?.jobHandoffCurrentStateCommandKey;
    const previousResultId = context?.jobHandoffPreviousResultId;
    if (
      !nonBlank(stateKey) ||
      !nonBlank(previousResultId) ||
      command.aggregateId !== jobId ||
      command.currentStateCommandKey !== stateKey ||
      command.currentStateResultId !== previousResultId ||
      expected?.orderId !== context?.orderId ||
      expected?.phaseId !== context?.phaseId ||
      expected?.resultId !== previousResultId ||
      expected?.currentStateCommandKey !== stateKey
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "ordinary Job handoff must bind the command-selected immutable packed Job",
      );
    }
    requireAtomicOrdinaryHandoff(lifecycle, command, {
      shipmentPrevious: "label_created",
      orderPrevious: "ready_to_ship",
      phasePrevious: "qc_passed",
      allowLaterParcel: true,
    });
    return;
  }
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const replacementSetId = context?.replacementSetId;
  const shipmentId = context?.jobHandoffShipmentId;
  const resultId = context?.replacementHandoffResultId;
  const stateKey = context?.jobHandoffCurrentStateCommandKey;
  const previousResultId = context?.jobHandoffPreviousResultId;
  if (
    kind !== "replacement" ||
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(replacementSetId) ||
    !nonBlank(shipmentId) ||
    !nonBlank(resultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(previousResultId) ||
    command.aggregateId !== jobId ||
    command.currentStateCommandKey !== stateKey ||
    command.currentStateResultId !== previousResultId ||
    expected.orderId !== context?.orderId ||
    expected.phaseId !== context?.phaseId ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    context?.jobHandoffClaimId !== claimId ||
    context?.jobHandoffResolutionId !== resolutionId ||
    context?.jobHandoffReplacementSetId !== replacementSetId ||
    context?.jobHandoffResultId !== resultId ||
    context?.jobHandoffJobResultId !== resultId ||
    expected.shipmentId !== shipmentId ||
    expected.claimId !== claimId ||
    expected.resolutionId !== resolutionId ||
    expected.replacementSetId !== replacementSetId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement Job handoff must select its exact Claim child, replacement set, Shipment, and result",
    );
  }
  requireAtomicCompleteReplacementHandoff(lifecycle, command);
  const independentTopology = Array.isArray(
    context?.replacementRequiredRequests,
  );
  const authoritativeJobs = independentTopology
    ? Array.isArray(context?.replacementHandoffJobs)
      ? context.replacementHandoffJobs
      : []
    : Array.isArray(context?.replacementHandoffResourceGroups)
      ? context.replacementHandoffResourceGroups
      : [];
  const selected = authoritativeJobs.filter((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return false;
    const record = value as Readonly<Record<string, unknown>>;
    return record.currentReplacementJobId === jobId || record.id === jobId;
  });
  if (selected.length !== 1) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement Job handoff must contain the selected Job exactly once",
    );
  }
  const record = selected[0] as Readonly<Record<string, unknown>>;
  const groupedRecord = record.currentReplacementJobId === jobId;
  if (
    (groupedRecord
      ? record.currentReplacementJobClaimId !== claimId ||
        record.currentReplacementJobResolutionId !== resolutionId ||
        record.currentReplacementJobSetId !== replacementSetId ||
        record.currentReplacementJobShipmentId !== shipmentId ||
        record.currentReplacementJobPreviousStatus !== "packed" ||
        record.currentReplacementJobTargetStatus !== "handed_over" ||
        record.currentReplacementJobResultId !== resultId
      : record.claimId !== claimId ||
        record.resolutionId !== resolutionId ||
        record.replacementSetId !== replacementSetId ||
        !Array.isArray(record.replacementShipmentIds) ||
        !record.replacementShipmentIds.includes(shipmentId) ||
        record.previousStatus !== "packed" ||
        record.targetStatus !== "handed_over" ||
        record.resultId !== resultId) ||
    record.currentReplacementJobLineageLeaf !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "selected replacement Job must preserve its exact Shipment backlinks and shared handoff result",
    );
  }
}

export const jobPolicy: TransitionPolicy<JobStatus> = {
  name: "Job",
  initial: ["created"],
  terminal: ["settled", "qc_rejected", "failed"],
  contextualTerminal: (state, context) =>
    state === "cancelled" &&
    context?.cancellationRaceCommittedCancellation !== true &&
    !hasExactRefundedCancellationRecoveryMarker(context),
  transitions: {
    created: ["accepted", "cancelled"],
    accepted: ["gcode_ready", "failed", "cancelled"],
    gcode_ready: ["printing", "failed", "cancelled"],
    printing: ["printed", "failed", "cancelled"],
    printed: ["photo_submitted", "failed", "cancelled"],
    photo_submitted: ["qc_approved", "qc_rejected", "failed", "cancelled"],
    qc_approved: ["packed", "failed", "cancelled"],
    packed: ["handed_over", "failed", "cancelled"],
    cancelled: ["handed_over"],
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
        requireCreatedJobCancellationOwnership("Job", command);
      } else {
        requireJobResourceSettlement("Job", command);
        requireFlag(
          "Job",
          command,
          "labelCancellationBarrierCompleted",
          "cancellation requires every carrier label cancellation barrier to complete",
        );
        requireExactPostAcceptanceJobCancellation("Job", command);
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
      requireAtomicGcodeReadyProduction("Job", command);
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
      requireAtomicQcPhotoSubmission("Job", command);
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
      requireExactQcDecision("Job", command, "approved");
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
      requireExactQcDecision("Job", command, "rejected");
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
      requireAtomicJobFailureSettlement("Job", command);
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
    if (
      (command.current === "packed" || command.current === "cancelled") &&
      command.target === "handed_over"
    ) {
      requireExactJobHandoff("Job", command);
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

function requireAtomicShipmentLabelCreation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const shipmentId = context?.shipmentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const planId = context?.shipmentPlanId;
  const labelId = context?.carrierLabelId;
  const resultId = context?.shipmentLabelCreationResultId;
  const shipmentPreviousResultId =
    context?.shipmentLabelCreationPreviousShipmentResultId;
  const shipmentStateKey = context?.shipmentLabelCreationCurrentStateCommandKey;
  const providerEventId = context?.shipmentLabelCreationProviderEventId;
  const providerTransactionId =
    context?.shipmentLabelCreationProviderTransactionId;
  const expectedValue = context?.shipmentLabelCreationExpectedShipment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const labelValue = context?.shipmentLabelCreationCarrierLabel;
  const label =
    typeof labelValue === "object" &&
    labelValue !== null &&
    !Array.isArray(labelValue)
      ? (labelValue as Readonly<Record<string, unknown>>)
      : undefined;
  const outboxValue = context?.shipmentLabelCreationOutbox;
  const outbox =
    typeof outboxValue === "object" &&
    outboxValue !== null &&
    !Array.isArray(outboxValue)
      ? (outboxValue as Readonly<Record<string, unknown>>)
      : undefined;
  const eventValue = context?.shipmentLabelCreationProviderEvent;
  const event =
    typeof eventValue === "object" &&
    eventValue !== null &&
    !Array.isArray(eventValue)
      ? (eventValue as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedKey =
    nonBlank(shipmentId) && nonBlank(planId)
      ? `create_carrier_label:${shipmentId}:${planId}`
      : undefined;
  if (
    !nonBlank(shipmentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(planId) ||
    !nonBlank(labelId) ||
    !nonBlank(resultId) ||
    !nonBlank(shipmentPreviousResultId) ||
    !nonBlank(shipmentStateKey) ||
    !nonBlank(providerEventId) ||
    !nonBlank(providerTransactionId) ||
    command.aggregateId !== shipmentId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== shipmentPreviousResultId ||
    command.currentStateCommandKey !== shipmentStateKey ||
    expected?.id !== shipmentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.planId !== planId ||
    expected.status !== "planned" ||
    expected.resultId !== shipmentPreviousResultId ||
    expected.currentStateCommandKey !== shipmentStateKey ||
    expected.immutable !== true ||
    context?.shipmentLabelCreationShipmentId !== shipmentId ||
    context?.shipmentLabelCreationOrderId !== orderId ||
    context?.shipmentLabelCreationPhaseId !== phaseId ||
    context?.shipmentLabelCreationPlanId !== planId ||
    context?.shipmentLabelCreationPreviousStatus !== "planned" ||
    context?.shipmentLabelCreationTargetStatus !== "label_created" ||
    context?.shipmentLabelCreationCarrierLabelId !== labelId ||
    label?.id !== labelId ||
    label.shipmentId !== shipmentId ||
    label.orderId !== orderId ||
    label.phaseId !== phaseId ||
    label.planId !== planId ||
    !nonBlank(label.carrierId) ||
    label.status !== "usable" ||
    label.immutable !== true ||
    label.resultId !== resultId ||
    !nonBlank(outbox?.id) ||
    outbox.shipmentId !== shipmentId ||
    outbox.planId !== planId ||
    outbox.carrierLabelId !== labelId ||
    outbox.idempotencyKey !== expectedKey ||
    outbox.action !== "create_carrier_label" ||
    outbox.previousStatus !== "pending" ||
    outbox.targetStatus !== "succeeded" ||
    outbox.resultId !== resultId ||
    event?.id !== providerEventId ||
    event.outboxId !== outbox.id ||
    event.shipmentId !== shipmentId ||
    event.carrierLabelId !== labelId ||
    event.transactionId !== providerTransactionId ||
    event.status !== "succeeded" ||
    event.authenticated !== true ||
    event.verified !== true ||
    event.resultId !== resultId ||
    context?.shipmentLabelCreationShipmentResultId !== resultId ||
    context?.shipmentLabelCreationLabelResultId !== resultId ||
    context?.shipmentLabelCreationOutboxResultId !== resultId ||
    context?.shipmentLabelCreationProviderEventResultId !== resultId ||
    context?.shipmentLabelCreationCompleted !== true ||
    context?.shipmentLabelCreationAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "label creation must atomically bind the exact planned Shipment, usable carrier label, outbox, and verified provider result",
    );
  }
}

function requireAtomicShipmentIncidentRouting<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const shipmentId = command.context?.shipmentId;
  const orderId = command.context?.orderId;
  const phaseId = command.context?.phaseId;
  const previousResultId =
    command.context?.shipmentProviderOutcomePreviousResultId;
  const stateKey =
    command.context?.shipmentProviderOutcomeCurrentStateCommandKey;
  const resultId = command.context?.shipmentIncidentRoutingResultId;
  const expectedValue =
    command.context?.shipmentProviderOutcomeExpectedShipment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const slotSetId = command.context?.shipmentIncidentAuthoritativeSlotSetId;
  const slotSetResultId =
    command.context?.shipmentIncidentAuthoritativeSlotSetResultId;
  const slotSetValue = command.context?.shipmentIncidentAuthoritativeSlotSet;
  const slotSet =
    typeof slotSetValue === "object" &&
    slotSetValue !== null &&
    !Array.isArray(slotSetValue)
      ? (slotSetValue as Readonly<Record<string, unknown>>)
      : undefined;
  const authoritativeSlotIdsValue = slotSet?.slotIds;
  const authoritativeSlotIds = Array.isArray(authoritativeSlotIdsValue)
    ? [...authoritativeSlotIdsValue]
    : undefined;
  const ownershipSourcesValue = slotSet?.slotOwnershipSources;
  const ownershipSources = Array.isArray(ownershipSourcesValue)
    ? [...ownershipSourcesValue]
    : undefined;
  const originClaimIdValue = command.context?.shipmentOriginClaimId;
  if (
    !nonBlank(shipmentId) ||
    command.context?.incidentShipmentId !== shipmentId ||
    !nonBlank(orderId) ||
    command.context?.incidentOrderId !== orderId ||
    !nonBlank(phaseId) ||
    command.context?.incidentPhaseId !== phaseId ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(resultId) ||
    resultId !== command.context?.shipmentProviderOutcomeResultId ||
    !nonBlank(slotSetId) ||
    !nonBlank(slotSetResultId) ||
    command.ownershipSnapshotId !== slotSetId ||
    command.ownershipSnapshotResultId !== slotSetResultId ||
    command.context?.shipmentIncidentExpectedSlotSetId !== slotSetId ||
    expected?.incidentSlotSetId !== slotSetId ||
    expected.incidentSlotSetResultId !== slotSetResultId ||
    expected.incidentOriginClaimId !== originClaimIdValue ||
    slotSet?.id !== slotSetId ||
    slotSet.shipmentId !== shipmentId ||
    slotSet.orderId !== orderId ||
    slotSet.phaseId !== phaseId ||
    slotSet.status !== command.current ||
    slotSet.targetStatus !== command.target ||
    slotSet.previousShipmentResultId !== previousResultId ||
    slotSet.currentStateCommandKey !== stateKey ||
    slotSet.resultId !== slotSetResultId ||
    slotSet.routingResultId !== resultId ||
    slotSet.originClaimId !== originClaimIdValue ||
    slotSet.immutable !== true ||
    authoritativeSlotIds === undefined ||
    ownershipSources === undefined ||
    ownershipSources.length !== authoritativeSlotIds.length
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
  const authoritativeSlotIdList = authoritativeSlotIds as string[];
  if (
    !hasSameNonEmptyStringSet(shipmentSlotIds, authoritativeSlotIdList) ||
    !hasSameNonEmptyStringSet(affectedSlotIds, authoritativeSlotIdList)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "shipment incident affected slots must exactly match the authoritative Shipment snapshot",
    );
  }
  const authoritativeOwnershipBySlotId = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const value of ownershipSources) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "shipment incident requires immutable per-slot ownership sources",
      );
    }
    const source = value as Readonly<Record<string, unknown>>;
    const slotId = source.slotId;
    const activeClaimId = source.activeClaimId;
    if (
      !nonBlank(slotId) ||
      !authoritativeSlotIdList.includes(slotId) ||
      authoritativeOwnershipBySlotId.has(slotId) ||
      source.slotSetId !== slotSetId ||
      source.shipmentId !== shipmentId ||
      source.orderId !== orderId ||
      source.phaseId !== phaseId ||
      source.status !== command.current ||
      !nonBlank(source.resultId) ||
      !nonBlank(source.currentStateCommandKey) ||
      source.immutable !== true ||
      (activeClaimId !== null && !nonBlank(activeClaimId))
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "shipment incident authoritative ownership must be a complete slot bijection",
      );
    }
    authoritativeOwnershipBySlotId.set(slotId, source);
  }
  if (authoritativeOwnershipBySlotId.size !== authoritativeSlotIdList.length) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "shipment incident authoritative ownership cannot omit a Shipment slot",
    );
  }
  const affectedIds = affectedSlotIds as string[];
  if (
    authoritativeSlotIdList.some((id) => !affectedIds.includes(id)) ||
    affectedIds.some((id) => !authoritativeSlotIdList.includes(id))
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
    const source =
      typeof slotId === "string"
        ? authoritativeOwnershipBySlotId.get(slotId)
        : undefined;
    if (
      typeof slotId !== "string" ||
      !affectedIds.includes(slotId) ||
      activeClaimBySlotId.has(slotId) ||
      source === undefined ||
      ownership.slotSetId !== slotSetId ||
      ownership.shipmentId !== shipmentId ||
      ownership.orderId !== orderId ||
      ownership.phaseId !== phaseId ||
      ownership.sourceResultId !== source.resultId ||
      ownership.sourceCurrentStateCommandKey !==
        source.currentStateCommandKey ||
      activeClaimId !== source.activeClaimId ||
      ownership.immutable !== true ||
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
      route.claimRetentionHoldActive !== true ||
      route.slotSetId !== slotSetId ||
      route.sourceResultId !==
        authoritativeOwnershipBySlotId.get(slotId as string)?.resultId ||
      route.sourceCurrentStateCommandKey !==
        authoritativeOwnershipBySlotId.get(slotId as string)
          ?.currentStateCommandKey ||
      route.incidentRecordResultId !== resultId ||
      route.childResolutionResultId !== resultId ||
      route.resultId !== resultId
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
    newClaim.retentionHoldActive !== true ||
    newClaim.resultId !== resultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "unowned slots require one exact active incident-backed Claim",
    );
  }
  if (
    command.context?.shipmentIncidentShipmentResultId !== resultId ||
    command.context?.shipmentIncidentRouteResultId !== resultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Shipment incident routing must share the provider outcome result",
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
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const shipmentId = command.context?.shipmentId;
  const providerTransactionId = command.context?.shipmentProviderTransactionId;
  const providerEventId = command.context?.providerEventId;
  const expectedShipment = record(
    command.context?.cancellationRaceExpectedShipment,
  );
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

  if (
    expectedShipment?.status === "cancelled" &&
    !hasExactRecoverableProviderVoidCancellationRace(command.context)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "post-void cancellation-race handoff requires an exact pre-void acceptance receipt and selected void snapshot",
    );
  }
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
  const previousShipmentResultId =
    context?.shipmentCancellationRequestPreviousShipmentResultId;
  const stateKey = context?.shipmentCancellationRequestCurrentStateCommandKey;
  const expectedShipmentValue =
    context?.shipmentCancellationRequestExpectedShipment;
  const expectedShipment =
    typeof expectedShipmentValue === "object" &&
    expectedShipmentValue !== null &&
    !Array.isArray(expectedShipmentValue)
      ? (expectedShipmentValue as Readonly<Record<string, unknown>>)
      : undefined;
  const requestValue = context?.shipmentCancellationRequest;
  const request =
    typeof requestValue === "object" &&
    requestValue !== null &&
    !Array.isArray(requestValue)
      ? (requestValue as Readonly<Record<string, unknown>>)
      : undefined;
  const requestId = context?.shipmentCancellationRequestId;
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
    !nonBlank(previousShipmentResultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== shipmentId ||
    command.currentStateResultId !== previousShipmentResultId ||
    command.currentStateCommandKey !== stateKey ||
    expectedShipment?.id !== shipmentId ||
    expectedShipment.status !== "label_created" ||
    expectedShipment.resultId !== previousShipmentResultId ||
    expectedShipment.currentStateCommandKey !== stateKey ||
    expectedShipment.immutable !== true ||
    !nonBlank(requestId) ||
    request?.id !== requestId ||
    request.shipmentId !== shipmentId ||
    request.carrierLabelId !== carrierLabelId ||
    request.previousStatus !== "label_created" ||
    request.targetStatus !== "cancellation_pending" ||
    request.resultId !== cancellationResultId ||
    request.immutable !== true ||
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
    context?.providerVoidOutboxCancellationRequestId !== requestId ||
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
    shipmentPrevious: "label_created" | "cancellation_pending" | "cancelled";
    orderPrevious:
      | "ready_to_ship"
      | "awaiting_balance"
      | "shipped"
      | "cancelled"
      | "refunded";
    phasePrevious: "qc_passed" | "shipped" | "cancelled" | "cancelled_refunded";
    jobPrevious?: "packed" | "cancelled";
    slotPrevious?: "cancelled" | "cancelled_refunded";
    orderTarget?: "shipped" | "partially_fulfilled";
    phaseTarget?: "shipped" | "partially_fulfilled";
    allowLaterParcel?: boolean;
    resultProof?: "ordinary" | "cancellation_race";
  }> = {
    shipmentPrevious: "label_created",
    orderPrevious: "ready_to_ship",
    phasePrevious: "qc_passed",
  },
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const shipmentId = context?.shipmentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const expectedSlotIdsValue = context?.handoffSlotIds;
  const slotsValue = context?.handoffSlots;
  const expectedJobIdsValue = context?.handoffJobIds;
  const jobsValue = context?.handoffJobs;
  const expectedSlotIds = Array.isArray(expectedSlotIdsValue)
    ? [...expectedSlotIdsValue]
    : undefined;
  const slots = Array.isArray(slotsValue) ? [...slotsValue] : undefined;
  const expectedJobIds = Array.isArray(expectedJobIdsValue)
    ? [...expectedJobIdsValue]
    : undefined;
  const jobs = Array.isArray(jobsValue) ? [...jobsValue] : undefined;
  const jobPrevious = expectedStatuses.jobPrevious ?? "packed";
  const slotPrevious =
    expectedStatuses.slotPrevious ??
    (jobPrevious === "cancelled" ? "cancelled" : undefined);
  const orderTarget = expectedStatuses.orderTarget ?? "shipped";
  const phaseTarget = expectedStatuses.phaseTarget ?? "shipped";
  const firstParcelStatusesMatch =
    context?.handoffOrderPreviousStatus === expectedStatuses.orderPrevious &&
    context?.handoffOrderTargetStatus === orderTarget &&
    context?.handoffPhasePreviousStatus === expectedStatuses.phasePrevious &&
    context?.handoffPhaseTargetStatus === phaseTarget;
  const laterParcelStatusesMatch =
    expectedStatuses.allowLaterParcel === true &&
    context?.handoffOrderPreviousStatus === "shipped" &&
    context?.handoffOrderTargetStatus === "shipped" &&
    context?.handoffPhasePreviousStatus === "shipped" &&
    context?.handoffPhaseTargetStatus === "shipped";
  const orderPrevious = laterParcelStatusesMatch
    ? "shipped"
    : expectedStatuses.orderPrevious;
  const phasePrevious = laterParcelStatusesMatch
    ? "shipped"
    : expectedStatuses.phasePrevious;
  if (
    typeof shipmentId !== "string" ||
    shipmentId.trim().length === 0 ||
    context?.handoffShipmentId !== shipmentId ||
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    context?.handoffOrderId !== orderId ||
    context?.handoffPhaseOrderId !== orderId ||
    typeof phaseId !== "string" ||
    phaseId.trim().length === 0 ||
    context?.handoffPhaseId !== phaseId ||
    context?.phaseKind !== "single" ||
    (!firstParcelStatusesMatch && !laterParcelStatusesMatch) ||
    context?.handoffShipmentPreviousStatus !==
      expectedStatuses.shipmentPrevious ||
    context?.handoffShipmentTargetStatus !== "handed_over" ||
    context?.handoffJobPreviousStatus !== jobPrevious ||
    context?.handoffJobTargetStatus !== "handed_over" ||
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

  if (expectedStatuses.resultProof !== "cancellation_race") {
    const selectedAggregate =
      lifecycle === "Order"
        ? {
            id: orderId,
            previousResultId: context?.handoffOrderPreviousResultId,
            stateKey: context?.handoffOrderCurrentStateCommandKey,
            expected: record(context?.handoffExpectedOrder),
            previousStatus: orderPrevious,
          }
        : lifecycle === "OrderPhase(single)"
          ? {
              id: phaseId,
              previousResultId: context?.handoffPhasePreviousResultId,
              stateKey: context?.handoffPhaseCurrentStateCommandKey,
              expected: record(context?.handoffExpectedPhase),
              previousStatus: phasePrevious,
            }
          : lifecycle === "Shipment"
            ? {
                id: shipmentId,
                previousResultId: context?.handoffShipmentPreviousResultId,
                stateKey: context?.handoffShipmentCurrentStateCommandKey,
                expected: record(context?.handoffExpectedShipment),
                previousStatus: expectedStatuses.shipmentPrevious,
              }
            : undefined;
    if (
      selectedAggregate !== undefined &&
      (!nonBlank(selectedAggregate.id) ||
        !nonBlank(selectedAggregate.previousResultId) ||
        !nonBlank(selectedAggregate.stateKey) ||
        command.aggregateId !== selectedAggregate.id ||
        command.currentStateResultId !== selectedAggregate.previousResultId ||
        command.currentStateCommandKey !== selectedAggregate.stateKey ||
        selectedAggregate.expected?.id !== selectedAggregate.id ||
        selectedAggregate.expected.status !==
          selectedAggregate.previousStatus ||
        selectedAggregate.expected.resultId !==
          selectedAggregate.previousResultId ||
        selectedAggregate.expected.currentStateCommandKey !==
          selectedAggregate.stateKey ||
        selectedAggregate.expected.immutable !== true ||
        (lifecycle === "Order" &&
          selectedAggregate.expected.phaseId !== phaseId) ||
        (lifecycle === "OrderPhase(single)" &&
          selectedAggregate.expected.orderId !== orderId) ||
        (lifecycle === "Shipment" &&
          (selectedAggregate.expected.orderId !== orderId ||
            selectedAggregate.expected.phaseId !== phaseId)))
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "ordinary handoff must bind the selected aggregate and immutable source snapshot",
      );
    }
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
      !authoritativeJobIds.includes(slotJobId) ||
      (slotPrevious !== undefined &&
        (slot.previousOutcome !== slotPrevious ||
          slot.targetOutcome !== "pending"))
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
      job.previousStatus !== jobPrevious ||
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

type CancellationRaceShipmentSourceStatus =
  "cancellation_pending" | "cancelled";

function requireExactHandoffShipmentOrigin<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  expectedKind: "ordinary" | "replacement" | "reship",
): void {
  const context = command.context;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  if (
    context?.labelledHandoffShipmentKind !== expectedKind ||
    (expectedKind === "ordinary"
      ? context?.labelledHandoffShipmentOriginClaimId !== null ||
        context?.labelledHandoffShipmentOriginResolutionId !== null
      : typeof claimId !== "string" ||
        claimId.trim().length === 0 ||
        typeof resolutionId !== "string" ||
        resolutionId.trim().length === 0 ||
        context?.labelledHandoffShipmentOriginClaimId !== claimId ||
        context?.labelledHandoffShipmentOriginResolutionId !== resolutionId)
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Shipment handoff kind must match its immutable ordinary or Claim-remedy origin",
    );
  }
}

function requireExactSelectedLabelledShipmentAggregate<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  kind: "replacement" | "reship",
): void {
  if (lifecycle !== "Shipment") return;
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const shipmentId = context?.shipmentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const previousResultId =
    kind === "replacement"
      ? context?.replacementHandoffShipmentPreviousResultId
      : context?.reshipmentHandoffShipmentPreviousResultId;
  const stateKey =
    kind === "replacement"
      ? context?.replacementHandoffShipmentCurrentStateCommandKey
      : context?.reshipmentHandoffShipmentCurrentStateCommandKey;
  const expectedValue =
    kind === "replacement"
      ? context?.replacementHandoffExpectedShipment
      : context?.reshipmentHandoffExpectedShipment;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    !nonBlank(shipmentId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(slotId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== shipmentId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    expected?.id !== shipmentId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.claimId !== claimId ||
    expected.resolutionId !== resolutionId ||
    expected.slotId !== slotId ||
    expected.originClaimId !== claimId ||
    expected.originResolutionId !== resolutionId ||
    expected.originKind !== kind ||
    expected.status !== "label_created" ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim-remedy Shipment handoff must bind the selected Shipment aggregate and immutable source snapshot",
    );
  }
}

function requireExactRefundedHandoffFinancialProof<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const reconciliation = record(context?.handoffRefundedReconciliation);
  const settlement = record(context?.handoffRefundedSettlement);
  const payment = record(context?.handoffRefundedPayment);
  const refund = record(context?.handoffRefundedRefund);
  const refundEvent = record(context?.handoffRefundedProviderEvent);
  const priorReconciliation = record(
    context?.handoffRefundedPriorReconciliation,
  );
  const laterRefundedParcel =
    context?.cancellationRaceLaterRefundedParcel === true;
  const payments = Array.isArray(context?.handoffSettlementOrderPayments)
    ? context.handoffSettlementOrderPayments.map(record)
    : [];
  const refunds = Array.isArray(context?.handoffSettlementOrderRefunds)
    ? context.handoffSettlementOrderRefunds.map(record)
    : [];
  const authoritativePaymentIds = Array.isArray(
    context?.handoffSettlementPaymentIds,
  )
    ? context.handoffSettlementPaymentIds
    : [];
  const authoritativeRefundIds = Array.isArray(
    context?.handoffSettlementRefundIds,
  )
    ? context.handoffSettlementRefundIds
    : [];
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const shipmentId = context?.shipmentId;
  const resultId = context?.cancellationRaceHandoffResultId;
  const reconciliationId = context?.handoffReconciliationId;
  const settlementId = context?.handoffSettlementId;
  const paymentId = payment?.id;
  const refundId = refund?.id;
  const refundEventId = refundEvent?.id;
  const currency = settlement?.currency;
  const settlementResultId = settlement?.resultId;
  const contractTotal = settlement?.contractTotalMinor;
  const capturedTotal = settlement?.capturedTotalMinor;
  const refundAmount = settlement?.refundAmountMinor;
  const cutoffAt = settlement?.cutoffAt;
  const settledAt = settlement?.settledAt;
  const capturedAt = payment?.capturedAt;
  const refundCompletedAt = refund?.completedAt;
  const refundVerifiedAt = refundEvent?.verifiedAt;
  const exactPaymentCount = payments.filter(
    (candidate) => candidate?.id === paymentId,
  ).length;
  const exactRefundCount = refunds.filter(
    (candidate) => candidate?.id === refundId,
  ).length;
  const omittedCapturedPayment = payments.some((candidate) => {
    const amount = candidate?.capturedAmountMinor;
    const at = candidate?.capturedAt;
    return (
      candidate?.id !== paymentId &&
      typeof amount === "bigint" &&
      amount > 0n &&
      at instanceof Instant &&
      cutoffAt instanceof Instant &&
      at.compare(cutoffAt) < 0
    );
  });
  const pendingRefund = refunds.some(
    (candidate) => candidate?.status === "pending",
  );
  const invalidPaymentRow = payments.some((candidate) => {
    const amount = candidate?.capturedAmountMinor;
    return (
      candidate === undefined ||
      !nonBlank(candidate.id) ||
      candidate.orderId !== orderId ||
      typeof amount !== "bigint" ||
      amount < 0n ||
      (amount > 0n && !(candidate.capturedAt instanceof Instant)) ||
      candidate.immutable !== true
    );
  });
  const invalidRefundRow = refunds.some(
    (candidate) =>
      candidate === undefined ||
      !nonBlank(candidate.id) ||
      !nonBlank(candidate.paymentId) ||
      !authoritativePaymentIds.includes(candidate.paymentId) ||
      (candidate.status !== "pending" &&
        candidate.status !== "succeeded" &&
        candidate.status !== "failed") ||
      typeof candidate.amountMinor !== "bigint" ||
      candidate.amountMinor < 0n ||
      candidate.immutable !== true,
  );

  if (
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(shipmentId) ||
    !nonBlank(resultId) ||
    !nonBlank(reconciliationId) ||
    !nonBlank(settlementId) ||
    !nonBlank(paymentId) ||
    !nonBlank(refundId) ||
    !nonBlank(refundEventId) ||
    reconciliation?.id !== reconciliationId ||
    reconciliation.orderId !== orderId ||
    reconciliation.phaseId !== phaseId ||
    reconciliation.shipmentId !== shipmentId ||
    reconciliation.providerEventId !== context?.providerEventId ||
    reconciliation.providerTransactionId !==
      context?.shipmentProviderTransactionId ||
    reconciliation.orderSettlementId !== settlementId ||
    reconciliation.paymentId !== paymentId ||
    reconciliation.refundTransactionId !== refundId ||
    reconciliation.refundProviderEventId !== refundEventId ||
    reconciliation.status !== "completed" ||
    reconciliation.resultId !== resultId ||
    reconciliation.immutable !== true ||
    (laterRefundedParcel &&
      (!nonBlank(priorReconciliation?.id) ||
        priorReconciliation.id === reconciliationId ||
        priorReconciliation.orderId !== orderId ||
        priorReconciliation.phaseId !== phaseId ||
        !nonBlank(priorReconciliation.shipmentId) ||
        priorReconciliation.shipmentId === shipmentId ||
        priorReconciliation.orderSettlementId !== settlementId ||
        !nonBlank(priorReconciliation.resultId) ||
        priorReconciliation.resultId !== settlementResultId ||
        priorReconciliation.status !== "completed" ||
        priorReconciliation.immutable !== true)) ||
    settlement?.id !== settlementId ||
    settlement.orderId !== orderId ||
    settlement.phaseId !== phaseId ||
    !nonBlank(settlement.orderPriceBindingId) ||
    !nonBlank(settlement.priceSnapshotId) ||
    settlement.paymentId !== paymentId ||
    settlement.refundTransactionId !== refundId ||
    settlement.kind !== "unauthorized_handoff" ||
    !nonBlank(currency) ||
    typeof contractTotal !== "bigint" ||
    contractTotal <= 0n ||
    typeof capturedTotal !== "bigint" ||
    capturedTotal <= 0n ||
    capturedTotal !== contractTotal ||
    settlement.earnedAmountMinor !== 0n ||
    settlement.retainedAmountMinor !== 0n ||
    refundAmount !== capturedTotal ||
    settlement.writtenOffAmountMinor !== 0n ||
    settlement.unearnedCancelledAmountMinor !== contractTotal ||
    settlement.amountDueMinor !== 0n ||
    settlement.refundableBalanceMinor !== 0n ||
    !(cutoffAt instanceof Instant) ||
    !(settledAt instanceof Instant) ||
    cutoffAt.compare(settledAt) !== 0 ||
    !nonBlank(settlementResultId) ||
    (laterRefundedParcel
      ? settlementResultId === resultId
      : settlementResultId !== resultId) ||
    settlement.immutable !== true ||
    payment?.orderId !== orderId ||
    payment.orderPriceBindingId !== settlement.orderPriceBindingId ||
    payment.priceSnapshotId !== settlement.priceSnapshotId ||
    payment.status !== "refunded" ||
    payment.currency !== currency ||
    payment.capturedAmountMinor !== capturedTotal ||
    payment.captureAuthorized !== false ||
    !(capturedAt instanceof Instant) ||
    capturedAt.compare(cutoffAt) >= 0 ||
    !(payment.captureCutoffAt instanceof Instant) ||
    payment.captureCutoffAt.compare(cutoffAt) !== 0 ||
    payment.immutable !== true ||
    refund?.paymentId !== paymentId ||
    refund.reason !== "customer_cancellation" ||
    refund.status !== "succeeded" ||
    refund.amountMinor !== refundAmount ||
    !nonBlank(refund.provider) ||
    !nonBlank(refund.providerRefundId) ||
    !(refundCompletedAt instanceof Instant) ||
    refundCompletedAt.compare(settledAt) > 0 ||
    refund.immutable !== true ||
    refundEvent?.paymentId !== paymentId ||
    refundEvent.refundTransactionId !== refundId ||
    refundEvent.kind !== "refund_succeeded" ||
    refundEvent.provider !== refund.provider ||
    refundEvent.providerTransactionId !== refund.providerRefundId ||
    refundEvent.amountMinor !== refundAmount ||
    refundEvent.currency !== currency ||
    !(refundVerifiedAt instanceof Instant) ||
    refundVerifiedAt.compare(refundCompletedAt) !== 0 ||
    refundEvent.immutable !== true ||
    context?.handoffSettlementPaymentSetComplete !== true ||
    context?.handoffSettlementRefundSetComplete !== true ||
    authoritativePaymentIds.length === 0 ||
    authoritativeRefundIds.length === 0 ||
    authoritativePaymentIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    authoritativeRefundIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    ) ||
    new Set(authoritativePaymentIds).size !== authoritativePaymentIds.length ||
    new Set(authoritativeRefundIds).size !== authoritativeRefundIds.length ||
    invalidPaymentRow ||
    invalidRefundRow ||
    !hasSameNonEmptyStringSet(
      authoritativePaymentIds,
      payments.map((candidate) => candidate?.id),
    ) ||
    !hasSameNonEmptyStringSet(
      authoritativeRefundIds,
      refunds.map((candidate) => candidate?.id),
    ) ||
    exactPaymentCount !== 1 ||
    exactRefundCount !== 1 ||
    omittedCapturedPayment ||
    pendingRefund
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "refunded handoff recovery requires exact immutable order-level payment, refund, receipt, and settlement proof",
    );
  }
}

function requireExactCancellationRaceHandoffResult<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const kind = context?.cancellationRaceHandoffKind;
  const expectedShipmentOriginKind =
    kind === "replacement" || kind === "reship" ? kind : "ordinary";
  const resultId = context?.cancellationRaceHandoffResultId;
  const shipmentId = context?.shipmentId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const providerEventId = context?.providerEventId;
  const providerTransactionId = context?.shipmentProviderTransactionId;
  const previousShipmentResultId =
    context?.cancellationRacePreviousShipmentResultId;
  const stateKey = context?.cancellationRaceCurrentStateCommandKey;
  const expectedShipment = record(context?.cancellationRaceExpectedShipment);
  const previousOrderResultId = context?.cancellationRacePreviousOrderResultId;
  const orderStateKey = context?.cancellationRaceCurrentOrderStateCommandKey;
  const expectedOrder = record(context?.cancellationRaceExpectedOrder);
  const previousPhaseResultId = context?.handoffPhasePreviousResultId;
  const phaseStateKey = context?.handoffPhaseCurrentStateCommandKey;
  const expectedPhase = record(context?.handoffExpectedPhase);
  const cancellationRequestId = context?.shipmentCancellationRequestId;
  const cancellationRequest = record(context?.shipmentCancellationRequest);
  const carrierLabelId = context?.carrierLabelId;
  const sourceStatusValue = expectedShipment?.status;
  const sourceStatus =
    sourceStatusValue === "cancelled" ||
    sourceStatusValue === "cancellation_pending"
      ? sourceStatusValue
      : undefined;
  const committedCancellation =
    context?.cancellationRaceCommittedCancellation === true;
  const refundedAggregate = context?.cancellationRaceRefundedAggregate === true;
  const laterRefundedParcel =
    context?.cancellationRaceLaterRefundedParcel === true;
  const expectedOrderStatus =
    kind === "unauthorized_reconciliation"
      ? refundedAggregate
        ? laterRefundedParcel
          ? "shipped"
          : "refunded"
        : "awaiting_balance"
      : committedCancellation
        ? "cancelled"
        : "ready_to_ship";
  const expectedPhaseStatus = refundedAggregate
    ? laterRefundedParcel
      ? "shipped"
      : "cancelled_refunded"
    : committedCancellation
      ? "cancelled"
      : "qc_passed";
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
    !nonBlank(carrierLabelId) ||
    sourceStatus === undefined ||
    (committedCancellation &&
      (sourceStatus !== "cancelled" || kind !== "ordinary")) ||
    (refundedAggregate &&
      (sourceStatus !== "cancelled" ||
        kind !== "unauthorized_reconciliation")) ||
    (laterRefundedParcel &&
      (!refundedAggregate ||
        (lifecycle !== "Shipment" && lifecycle !== "Job"))) ||
    !nonBlank(previousShipmentResultId) ||
    !nonBlank(stateKey) ||
    expectedShipment?.id !== shipmentId ||
    expectedShipment.orderId !== orderId ||
    expectedShipment.phaseId !== phaseId ||
    expectedShipment.status !== sourceStatus ||
    expectedShipment.originKind !== expectedShipmentOriginKind ||
    expectedShipment.resultId !== previousShipmentResultId ||
    expectedShipment.currentStateCommandKey !== stateKey ||
    expectedShipment.immutable !== true ||
    !nonBlank(cancellationRequestId) ||
    cancellationRequest?.id !== cancellationRequestId ||
    cancellationRequest.shipmentId !== shipmentId ||
    cancellationRequest.carrierLabelId !== carrierLabelId ||
    cancellationRequest.previousStatus !== "label_created" ||
    cancellationRequest.targetStatus !== "cancellation_pending" ||
    !nonBlank(cancellationRequest.resultId) ||
    cancellationRequest.immutable !== true ||
    context?.cancellationRaceCancellationRequestId !== cancellationRequestId ||
    context?.cancellationRaceCancellationRequestShipmentId !== shipmentId ||
    context?.cancellationRaceCancellationRequestResultId !==
      cancellationRequest.resultId ||
    context?.shipmentProviderScanCancellationRequestId !==
      cancellationRequestId ||
    (lifecycle === "Shipment" &&
      (command.aggregateId !== shipmentId ||
        command.currentStateResultId !== previousShipmentResultId ||
        command.currentStateCommandKey !== stateKey)) ||
    (lifecycle === "Order" &&
      (!nonBlank(previousOrderResultId) ||
        !nonBlank(orderStateKey) ||
        command.current !== expectedOrderStatus ||
        command.aggregateId !== orderId ||
        command.currentStateResultId !== previousOrderResultId ||
        command.currentStateCommandKey !== orderStateKey ||
        expectedOrder?.id !== orderId ||
        expectedOrder.phaseId !== phaseId ||
        expectedOrder.status !== command.current ||
        expectedOrder.resultId !== previousOrderResultId ||
        expectedOrder.currentStateCommandKey !== orderStateKey ||
        expectedOrder.immutable !== true)) ||
    (lifecycle === "OrderPhase(single)" &&
      (!nonBlank(previousPhaseResultId) ||
        !nonBlank(phaseStateKey) ||
        command.current !== expectedPhaseStatus ||
        command.aggregateId !== phaseId ||
        command.currentStateResultId !== previousPhaseResultId ||
        command.currentStateCommandKey !== phaseStateKey ||
        expectedPhase?.id !== phaseId ||
        expectedPhase.orderId !== orderId ||
        expectedPhase.status !== command.current ||
        expectedPhase.resultId !== previousPhaseResultId ||
        expectedPhase.currentStateCommandKey !== phaseStateKey ||
        expectedPhase.immutable !== true)) ||
    context?.cancellationRaceResultKind !== kind ||
    context?.cancellationRaceResultShipmentId !== shipmentId ||
    context?.cancellationRaceResultOrderId !== orderId ||
    context?.cancellationRaceResultPhaseId !== phaseId ||
    context?.cancellationRaceResultProviderEventId !== providerEventId ||
    context?.cancellationRaceResultProviderTransactionId !==
      providerTransactionId ||
    context?.cancellationRaceResultShipmentPreviousStatus !== sourceStatus ||
    context?.cancellationRaceResultShipmentTargetStatus !== "handed_over" ||
    context?.cancellationRaceAggregateResultId !== resultId ||
    context?.cancellationRaceShipmentResultId !== resultId ||
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
  requireExactHandoffShipmentOrigin(
    lifecycle,
    command,
    kind === "replacement" || kind === "reship" ? kind : "ordinary",
  );
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
      shipmentPrevious: sourceStatus,
      orderPrevious: refundedAggregate
        ? "refunded"
        : committedCancellation
          ? "cancelled"
          : "ready_to_ship",
      phasePrevious: refundedAggregate
        ? "cancelled_refunded"
        : committedCancellation
          ? "cancelled"
          : "qc_passed",
      jobPrevious:
        committedCancellation || refundedAggregate ? "cancelled" : "packed",
      orderTarget: "shipped",
      phaseTarget: "shipped",
      resultProof: "cancellation_race",
    });
    return;
  }

  if (kind === "unauthorized_reconciliation") {
    const reconciliationId = context?.handoffReconciliationId;
    const settlementId = context?.handoffSettlementId;
    const refundedSettlement = record(context?.handoffRefundedSettlement);
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
      (!refundedAggregate &&
        context?.handoffSettlementShipmentId !== shipmentId) ||
      context?.handoffSettlementOrderId !== orderId ||
      context?.handoffSettlementPhaseId !== phaseId ||
      context?.handoffSettlementKind !== "handoff_reconciliation" ||
      context?.handoffSettlementImmutable !== true ||
      context?.handoffSettlementResultId !==
        (refundedAggregate ? refundedSettlement?.resultId : resultId)
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
    if (refundedAggregate) {
      requireExactRefundedHandoffFinancialProof(lifecycle, command);
    }
    requireZeroAmountDue(lifecycle, command);
    requireReconciliationRefundAllocation(lifecycle, command);
    requireAtomicOrdinaryHandoff(lifecycle, command, {
      shipmentPrevious: sourceStatus,
      orderPrevious: refundedAggregate ? "refunded" : "awaiting_balance",
      phasePrevious: refundedAggregate ? "cancelled_refunded" : "qc_passed",
      jobPrevious: refundedAggregate ? "cancelled" : "packed",
      ...(refundedAggregate
        ? { slotPrevious: "cancelled_refunded" as const }
        : {}),
      allowLaterParcel: laterRefundedParcel,
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
    requireAtomicCompleteReplacementHandoff(
      lifecycle,
      command,
      shipmentId,
      true,
      sourceStatus,
    );
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
  requireExactReshipmentHandoff(
    lifecycle,
    command,
    shipmentId,
    true,
    sourceStatus,
  );
}

function requireExactLabelledShipmentHandoff<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const kind = context?.labelledHandoffKind;
  const shipmentId = context?.shipmentId;
  const resultId = context?.labelledHandoffResultId;
  const expectedResultId =
    kind === "ordinary"
      ? context?.handoffResultId
      : kind === "replacement"
        ? context?.replacementHandoffResultId
        : kind === "reship"
          ? context?.reshipmentHandoffResultId
          : undefined;
  if (
    (kind !== "ordinary" && kind !== "replacement" && kind !== "reship") ||
    typeof shipmentId !== "string" ||
    shipmentId.trim().length === 0 ||
    typeof resultId !== "string" ||
    resultId.trim().length === 0 ||
    resultId !== expectedResultId ||
    context?.labelledHandoffResultKind !== kind ||
    context?.labelledHandoffShipmentId !== shipmentId ||
    context?.labelledHandoffShipmentKind !== kind ||
    context?.labelledHandoffShipmentResultId !== resultId ||
    context?.labelledHandoffShipmentPreviousStatus !== "label_created" ||
    context?.labelledHandoffShipmentTargetStatus !== "handed_over" ||
    context?.labelledHandoffCompleted !== true ||
    context?.labelledHandoffAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "labelled Shipment handoff must select one exact ordinary or Claim-remedy result",
    );
  }
  requireExactHandoffShipmentOrigin(lifecycle, command, kind);
  if (kind === "replacement" || kind === "reship") {
    requireExactSelectedLabelledShipmentAggregate(lifecycle, command, kind);
  }

  if (kind === "ordinary") {
    requireAtomicOrdinaryHandoff(lifecycle, command, {
      shipmentPrevious: "label_created",
      orderPrevious: "ready_to_ship",
      phasePrevious: "qc_passed",
      allowLaterParcel: true,
    });
    return;
  }
  if (kind === "replacement") {
    requireFlag(
      lifecycle,
      command,
      "replacementFulfilmentAuthorizationConsumed",
      "replacement handoff requires one-shot consumption of its fulfilment authorization",
    );
    requireFlag(
      lifecycle,
      command,
      "replacementFulfilmentHandoffCompleted",
      "replacement handoff requires the complete authorization-backed handoff result",
    );
    requireAtomicCompleteReplacementHandoff(lifecycle, command, shipmentId);
    return;
  }
  requireFlag(
    lifecycle,
    command,
    "reshipmentAuthorizationConsumed",
    "reship handoff requires consumption of its custody-backed authorization",
  );
  requireFlag(
    lifecycle,
    command,
    "reshipmentHandoffCompleted",
    "reship handoff requires the complete authorization-backed handoff result",
  );
  requireExactReshipmentHandoff(lifecycle, command, shipmentId);
}

export const shipmentPolicy: TransitionPolicy<ShipmentStatus> = {
  name: "Shipment",
  initial: ["planned"],
  terminal: ["delivered", "returned", "recovered"],
  contextualTerminal: (state, context) =>
    state === "cancelled" &&
    !hasExactRecoverableProviderVoidCancellationRace(context),
  transitions: {
    planned: ["label_created", "cancelled"],
    label_created: ["handed_over", "cancellation_pending"],
    cancellation_pending: ["cancelled", "handed_over"],
    cancelled: ["handed_over"],
    handed_over: ["in_transit", "delivered"],
    in_transit: ["delivered", "lost", "returned"],
    lost: ["recovered"],
  },
  guard: (command) => {
    if (command.current === "planned" && command.target === "label_created") {
      requireAtomicShipmentLabelCreation("Shipment", command);
    }
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
      requireExactLabelledShipmentHandoff("Shipment", command);
    }
    if (
      (command.current === "cancellation_pending" ||
        command.current === "cancelled") &&
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
    if (
      command.current === "handed_over" &&
      (command.target === "in_transit" || command.target === "delivered")
    ) {
      requireVerifiedMatchingProviderShipmentEvent("Shipment", command);
      requireExactShipmentProviderOutcome("Shipment", command);
    }
    if (
      command.current === "in_transit" &&
      (command.target === "delivered" ||
        command.target === "lost" ||
        command.target === "returned")
    ) {
      requireVerifiedMatchingProviderShipmentEvent("Shipment", command);
      requireExactShipmentProviderOutcome("Shipment", command);
      if (command.target === "lost" || command.target === "returned") {
        requireAtomicShipmentIncidentRouting("Shipment", command);
      }
    }
    if (command.current === "lost" && command.target === "recovered") {
      requireVerifiedMatchingProviderShipmentEvent("Shipment", command);
      requireExactShipmentProviderOutcome("Shipment", command);
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
  const ownershipSetId = command.context?.claimResolutionOwnershipSetId;
  const ownershipSetResultId =
    command.context?.claimResolutionOwnershipSetResultId;
  const ownershipSetValue = command.context?.claimResolutionOwnershipSet;
  const ownershipSet =
    typeof ownershipSetValue === "object" &&
    ownershipSetValue !== null &&
    !Array.isArray(ownershipSetValue)
      ? (ownershipSetValue as Readonly<Record<string, unknown>>)
      : undefined;
  const ownershipSnapshotId =
    command.context?.claimResolutionOwnershipSnapshotId;
  const ownershipPreviousClaimResultId =
    command.context?.claimResolutionOwnershipPreviousClaimResultId;
  const ownershipSnapshotResultId =
    command.context?.claimResolutionOwnershipSnapshotResultId;
  const ownershipSnapshotValue =
    command.context?.claimResolutionOwnershipSnapshot;
  const ownershipSnapshot =
    typeof ownershipSnapshotValue === "object" &&
    ownershipSnapshotValue !== null &&
    !Array.isArray(ownershipSnapshotValue)
      ? (ownershipSnapshotValue as Readonly<Record<string, unknown>>)
      : undefined;
  const isExactIdArray = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((id) => typeof id === "string" && id.trim().length > 0) &&
    new Set(value).size === value.length;
  const bindingKeys = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const keys: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return undefined;
      }
      const binding = entry as Readonly<Record<string, unknown>>;
      if (
        typeof binding.resolutionId !== "string" ||
        binding.resolutionId.trim().length === 0 ||
        typeof binding.slotId !== "string" ||
        binding.slotId.trim().length === 0
      ) {
        return undefined;
      }
      keys.push(`${binding.resolutionId}\u0000${binding.slotId}`);
    }
    return new Set(keys).size === keys.length ? keys.sort() : undefined;
  };
  const sameIdSet = (left: unknown, right: unknown): boolean => {
    if (!isExactIdArray(left) || !isExactIdArray(right)) return false;
    return (
      left.length === right.length && left.every((id) => right.includes(id))
    );
  };
  const sameBindingSet = (left: unknown, right: unknown): boolean => {
    const leftKeys = bindingKeys(left);
    const rightKeys = bindingKeys(right);
    return (
      leftKeys !== undefined &&
      rightKeys !== undefined &&
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index])
    );
  };
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
  const expectedClaimStatus =
    lifecycle === "Claim"
      ? command.current
      : (command.context?.claimWithdrawalParentPreviousStatus ??
        command.context?.claimRejectionParentPreviousStatus ??
        "active");
  if (
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    (lifecycle === "Claim" && command.aggregateId !== claimId) ||
    typeof ownershipSetId !== "string" ||
    ownershipSetId.trim().length === 0 ||
    typeof ownershipSetResultId !== "string" ||
    ownershipSetResultId.trim().length === 0 ||
    ownershipSet?.id !== ownershipSetId ||
    ownershipSet.claimId !== claimId ||
    ownershipSet.resultId !== ownershipSetResultId ||
    ownershipSet.immutable !== true ||
    !isExactIdArray(ownershipSet.resolutionIds) ||
    !isExactIdArray(ownershipSet.slotIds) ||
    !sameIdSet(expectedIdsValue, ownershipSet.resolutionIds) ||
    !sameIdSet(expectedSlotIdsValue, ownershipSet.slotIds) ||
    !sameBindingSet(
      expectedBindingsValue,
      ownershipSet.resolutionSlotBindings,
    ) ||
    typeof ownershipSnapshotId !== "string" ||
    ownershipSnapshotId.trim().length === 0 ||
    typeof ownershipPreviousClaimResultId !== "string" ||
    ownershipPreviousClaimResultId.trim().length === 0 ||
    typeof ownershipSnapshotResultId !== "string" ||
    ownershipSnapshotResultId.trim().length === 0 ||
    ownershipSnapshot?.id !== ownershipSnapshotId ||
    ownershipSnapshot.claimId !== claimId ||
    ownershipSnapshot.aggregateId !== claimId ||
    ownershipSnapshot.status !== expectedClaimStatus ||
    ownershipSnapshot.previousResultId !== ownershipPreviousClaimResultId ||
    ownershipSnapshot.resultId !== ownershipSnapshotResultId ||
    ownershipSnapshot.ownershipSetId !== ownershipSetId ||
    ownershipSnapshot.ownershipSetResultId !== ownershipSetResultId ||
    ownershipSnapshot.immutable !== true ||
    !sameIdSet(ownershipSnapshot.resolutionIds, ownershipSet.resolutionIds) ||
    !sameIdSet(ownershipSnapshot.slotIds, ownershipSet.slotIds) ||
    !sameBindingSet(
      ownershipSnapshot.resolutionSlotBindings,
      ownershipSet.resolutionSlotBindings,
    ) ||
    (lifecycle === "Claim"
      ? typeof command.currentStateCommandKey !== "string" ||
        command.currentStateCommandKey.trim().length === 0 ||
        command.currentStateResultId !== ownershipPreviousClaimResultId ||
        command.ownershipSnapshotId !== ownershipSnapshotId ||
        command.ownershipSnapshotResultId !== ownershipSnapshotResultId ||
        ownershipSnapshot.currentStateCommandKey !==
          command.currentStateCommandKey
      : command.parentAggregateId !== claimId ||
        typeof command.parentCurrentStateCommandKey !== "string" ||
        command.parentCurrentStateCommandKey.trim().length === 0 ||
        command.parentCurrentStateCommandKey !==
          ownershipSnapshot.currentStateCommandKey ||
        command.parentCurrentStateResultId !== ownershipPreviousClaimResultId ||
        command.ownershipSnapshotId !== ownershipSnapshotId ||
        command.ownershipSnapshotResultId !== ownershipSnapshotResultId) ||
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
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const resultId = context?.claimRejectionResultId;
  const resolutionPreviousResultId =
    context?.claimRejectionPreviousResolutionResultId;
  const resolutionStateKey = context?.claimRejectionCurrentStateCommandKey;
  const expectedResolutionValue = context?.claimRejectionExpectedResolution;
  const expectedResolution =
    typeof expectedResolutionValue === "object" &&
    expectedResolutionValue !== null &&
    !Array.isArray(expectedResolutionValue)
      ? (expectedResolutionValue as Readonly<Record<string, unknown>>)
      : undefined;
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
    (lifecycle === "ClaimSlotResolution" &&
      (!nonBlank(resolutionPreviousResultId) ||
        !nonBlank(resolutionStateKey) ||
        command.aggregateId !== resolutionId ||
        command.currentStateCommandKey !== resolutionStateKey ||
        command.currentStateResultId !== resolutionPreviousResultId ||
        expectedResolution?.id !== resolutionId ||
        expectedResolution.claimId !== claimId ||
        expectedResolution.slotId !== slotId ||
        expectedResolution.status !== "pending" ||
        expectedResolution.activeClaimId !== claimId ||
        expectedResolution.resultId !== resolutionPreviousResultId ||
        expectedResolution.currentStateCommandKey !== resolutionStateKey ||
        expectedResolution.ownershipSetId !==
          context?.claimResolutionOwnershipSetId ||
        expectedResolution.ownershipSetResultId !==
          context?.claimResolutionOwnershipSetResultId ||
        expectedResolution.ownershipSnapshotId !==
          context?.claimResolutionOwnershipSnapshotId ||
        expectedResolution.ownershipSnapshotResultId !==
          context?.claimResolutionOwnershipSnapshotResultId ||
        expectedResolution.claimPreviousResultId !==
          context?.claimResolutionOwnershipPreviousClaimResultId ||
        expectedResolution.immutable !== true)) ||
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
  const isSelectedChildTransition = lifecycle === "ClaimSlotResolution";
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const resultId = context?.claimWithdrawalResultId;
  const resolutionPreviousResultId =
    context?.claimWithdrawalPreviousResolutionResultId;
  const resolutionStateKey = context?.claimWithdrawalCurrentStateCommandKey;
  const expectedResolutionValue = context?.claimWithdrawalExpectedResolution;
  const expectedResolution =
    typeof expectedResolutionValue === "object" &&
    expectedResolutionValue !== null &&
    !Array.isArray(expectedResolutionValue)
      ? (expectedResolutionValue as Readonly<Record<string, unknown>>)
      : undefined;
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
    (isSelectedChildTransition &&
      (!nonBlank(resolutionPreviousResultId) ||
        !nonBlank(resolutionStateKey) ||
        command.aggregateId !== resolutionId ||
        command.currentStateCommandKey !== resolutionStateKey ||
        command.currentStateResultId !== resolutionPreviousResultId ||
        expectedResolution?.id !== resolutionId ||
        expectedResolution.claimId !== claimId ||
        expectedResolution.slotId !== slotId ||
        expectedResolution.status !== command.current ||
        expectedResolution.activeClaimId !== claimId ||
        expectedResolution.resultId !== resolutionPreviousResultId ||
        expectedResolution.currentStateCommandKey !== resolutionStateKey ||
        expectedResolution.ownershipSetId !==
          context?.claimResolutionOwnershipSetId ||
        expectedResolution.ownershipSetResultId !==
          context?.claimResolutionOwnershipSetResultId ||
        expectedResolution.ownershipSnapshotId !==
          context?.claimResolutionOwnershipSnapshotId ||
        expectedResolution.ownershipSnapshotResultId !==
          context?.claimResolutionOwnershipSnapshotResultId ||
        expectedResolution.claimPreviousResultId !==
          context?.claimResolutionOwnershipPreviousClaimResultId ||
        expectedResolution.immutable !== true)) ||
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

function requireExactClaimInvestigationSource<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const expectedValue = context?.claimInvestigationExpectedClaim;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const claimId = context?.claimId;
  const resultId = context?.claimInvestigationResultId;
  const previousResultId = context?.claimInvestigationPreviousClaimResultId;
  const stateKey = context?.claimInvestigationCurrentStateCommandKey;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (
    !nonBlank(claimId) ||
    !nonBlank(resultId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== claimId ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    expected?.id !== claimId ||
    expected.status !== "opened" ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true ||
    context?.claimInvestigationClaimResultId !== resultId ||
    context?.claimInvestigationCompleted !== true ||
    context?.claimInvestigationAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim investigation must bind the command-selected immutable opened Claim source",
    );
  }
}

function requireAtomicClaimActivation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  const claimId = context?.claimId;
  const previousResultId = context?.claimActivationPreviousClaimResultId;
  const stateKey = context?.claimActivationCurrentStateCommandKey;
  const expectedClaim = record(context?.claimActivationExpectedClaim);
  const ownershipSetId = context?.claimActivationOwnershipSetId;
  const ownershipSetResultId = context?.claimActivationOwnershipSetResultId;
  const ownershipSet = record(context?.claimActivationOwnershipSet);
  const expectedIds = context?.claimActivationExpectedResolutionIds;
  const expectedSlots = context?.claimActivationExpectedSlotIds;
  const expectedBindings = context?.claimActivationExpectedResolutionSlots;
  const childrenValue = context?.claimActivationExpectedChildren;
  const selectionsValue = context?.claimActivationSelections;
  const children = Array.isArray(childrenValue) ? childrenValue : undefined;
  const selections = Array.isArray(selectionsValue)
    ? selectionsValue
    : undefined;
  const resultId = context?.claimActivationResultId;
  const validRemedies = new Set([
    "reprint_pending",
    "reship_pending",
    "refund_pending",
  ]);
  const exactIds = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(nonBlank) &&
    new Set(value).size === value.length;
  const sameSet = (left: unknown, right: unknown): boolean =>
    exactIds(left) &&
    exactIds(right) &&
    left.length === right.length &&
    left.every((id) => right.includes(id));
  if (
    !nonBlank(claimId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(stateKey) ||
    !nonBlank(ownershipSetId) ||
    !nonBlank(ownershipSetResultId) ||
    !nonBlank(resultId) ||
    command.aggregateId !== claimId ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    command.ownershipSnapshotId !== ownershipSetId ||
    command.ownershipSnapshotResultId !== ownershipSetResultId ||
    expectedClaim?.id !== claimId ||
    expectedClaim.status !== "investigating" ||
    expectedClaim.resultId !== previousResultId ||
    expectedClaim.currentStateCommandKey !== stateKey ||
    expectedClaim.ownershipSetId !== ownershipSetId ||
    expectedClaim.ownershipSetResultId !== ownershipSetResultId ||
    expectedClaim.immutable !== true ||
    ownershipSet?.id !== ownershipSetId ||
    ownershipSet.claimId !== claimId ||
    ownershipSet.resultId !== ownershipSetResultId ||
    ownershipSet.immutable !== true ||
    !sameSet(expectedIds, ownershipSet.resolutionIds) ||
    !sameSet(expectedSlots, ownershipSet.slotIds) ||
    (expectedIds as unknown[])?.length !==
      (expectedSlots as unknown[])?.length ||
    !Array.isArray(expectedBindings) ||
    !Array.isArray(ownershipSet.resolutionSlotBindings) ||
    expectedBindings.length !== (expectedIds as unknown[])?.length ||
    children === undefined ||
    children.length !== (expectedIds as unknown[])?.length ||
    selections === undefined ||
    selections.length === 0 ||
    context?.claimActivationClaimResultId !== resultId ||
    context?.claimActivationOwnershipResultId !== resultId ||
    context?.claimActivationChildResultId !== resultId ||
    context?.claimActivationCompleted !== true ||
    context?.claimActivationAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim activation requires its command-selected immutable ownership and remedy-selection result",
    );
  }
  const expectedSlotByResolution = new Map<string, string>();
  for (const value of expectedBindings as unknown[]) {
    const binding = record(value);
    const resolutionId = binding?.resolutionId;
    const slotId = binding?.slotId;
    if (
      !nonBlank(resolutionId) ||
      !nonBlank(slotId) ||
      expectedSlotByResolution.has(resolutionId) ||
      !(expectedIds as string[]).includes(resolutionId) ||
      !(expectedSlots as string[]).includes(slotId)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim activation requires an exact authoritative resolution-to-slot ownership bijection",
      );
    }
    expectedSlotByResolution.set(resolutionId, slotId);
  }
  const ownershipBindingKeys = new Set<string>();
  for (const value of ownershipSet.resolutionSlotBindings as unknown[]) {
    const binding = record(value);
    const resolutionId = binding?.resolutionId;
    const slotId = binding?.slotId;
    if (
      !nonBlank(resolutionId) ||
      !nonBlank(slotId) ||
      ownershipBindingKeys.has(resolutionId) ||
      expectedSlotByResolution.get(resolutionId) !== slotId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim activation ownership bindings must exactly match the immutable child set",
      );
    }
    ownershipBindingKeys.add(resolutionId);
  }
  if (ownershipBindingKeys.size !== expectedSlotByResolution.size) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim activation ownership bindings cannot omit a child",
    );
  }
  const childById = new Map<string, Readonly<Record<string, unknown>>>();
  const sourceChildrenValue = ownershipSet.sourceChildren;
  const sourceChildren = Array.isArray(sourceChildrenValue)
    ? sourceChildrenValue
    : undefined;
  if (
    sourceChildren === undefined ||
    sourceChildren.length !== expectedSlotByResolution.size
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "Claim activation ownership must contain every immutable child source record",
    );
  }
  const sourceById = new Map<string, Readonly<Record<string, unknown>>>();
  for (const value of sourceChildren) {
    const source = record(value);
    if (source === undefined) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim activation ownership child sources must be records",
      );
    }
    const id = source?.id;
    const slotId = source?.slotId;
    if (
      !nonBlank(id) ||
      !nonBlank(slotId) ||
      sourceById.has(id) ||
      expectedSlotByResolution.get(id) !== slotId ||
      source.claimId !== claimId ||
      source.activeClaimId !== claimId ||
      source.status !== "pending" ||
      !nonBlank(source.resultId) ||
      !nonBlank(source.currentStateCommandKey) ||
      source.immutable !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim activation ownership child sources must exactly match the immutable pending child set",
      );
    }
    sourceById.set(id, source);
  }
  const slots = new Set<string>();
  for (const value of children) {
    const child = record(value);
    const id = child?.id;
    const slotId = child?.slotId;
    if (
      !nonBlank(id) ||
      !nonBlank(slotId) ||
      childById.has(id) ||
      slots.has(slotId) ||
      !(expectedIds as string[]).includes(id) ||
      expectedSlotByResolution.get(id) !== slotId ||
      child?.claimId !== claimId ||
      child.status !== "pending" ||
      child.activeClaimId !== claimId ||
      child.resultId !== sourceById.get(id)?.resultId ||
      child.currentStateCommandKey !==
        sourceById.get(id)?.currentStateCommandKey ||
      !nonBlank(child.resultId) ||
      !nonBlank(child.currentStateCommandKey) ||
      child.ownershipSetId !== ownershipSetId ||
      child.ownershipSetResultId !== ownershipSetResultId ||
      child.immutable !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim activation requires every immutable owned pending child exactly once",
      );
    }
    childById.set(id, child);
    slots.add(slotId);
  }
  const selectedIds = new Set<string>();
  for (const value of selections) {
    const selection = record(value);
    const id = selection?.resolutionId;
    const slotId = selection?.slotId;
    const child = nonBlank(id) ? childById.get(id) : undefined;
    if (
      selection === undefined ||
      !nonBlank(id) ||
      !nonBlank(slotId) ||
      selectedIds.has(id) ||
      child === undefined ||
      child.slotId !== slotId ||
      selection.claimId !== claimId ||
      selection.activeClaimId !== claimId ||
      selection.previousStatus !== "pending" ||
      selection.previousResultId !== child.resultId ||
      selection.currentStateCommandKey !== child.currentStateCommandKey ||
      selection.ownershipSetId !== ownershipSetId ||
      selection.ownershipSetResultId !== ownershipSetResultId ||
      !validRemedies.has(selection.targetStatus as string) ||
      selection.resultId !== resultId ||
      selection.immutable !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "Claim activation selections must be exact owned pending children with a remedy result",
      );
    }
    selectedIds.add(id);
  }
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
    if (command.current === "opened" && command.target === "investigating") {
      requireExactClaimInvestigationSource("Claim", command);
    }
    if (command.current === "investigating" && command.target === "active") {
      requireAtomicClaimActivation("Claim", command);
    }
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

const replacementRecoveryJobStatuses = [
  "created",
  "accepted",
  "gcode_ready",
  "printing",
  "printed",
  "photo_submitted",
  "qc_approved",
  "packed",
  "failed",
] as const satisfies readonly JobStatus[];

const cancellableReplacementJobStatuses = new Set<string>(
  replacementRecoveryJobStatuses,
);

function requireExactReplacementResolutionSource<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  sourceStatus: "reprint_pending" | "replacement_in_production",
  sourceEvidence?: Readonly<{
    previousResultId?: unknown;
    currentStateCommandKey?: unknown;
    expectedResolution?: unknown;
  }>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const snapshotValue =
    sourceEvidence === undefined
      ? context?.replacementLifecycleExpectedResolution
      : sourceEvidence.expectedResolution;
  const snapshot =
    typeof snapshotValue === "object" &&
    snapshotValue !== null &&
    !Array.isArray(snapshotValue)
      ? (snapshotValue as Readonly<Record<string, unknown>>)
      : undefined;
  const resolutionId = context?.claimSlotResolutionId;
  const claimId = context?.claimId;
  const slotId = context?.claimSlotId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const previousResultId =
    sourceEvidence === undefined
      ? context?.replacementLifecyclePreviousResolutionResultId
      : sourceEvidence.previousResultId;
  const currentStateCommandKey =
    sourceEvidence === undefined
      ? context?.replacementLifecycleCurrentStateCommandKey
      : sourceEvidence.currentStateCommandKey;
  if (
    !nonBlank(resolutionId) ||
    !nonBlank(claimId) ||
    !nonBlank(slotId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(currentStateCommandKey) ||
    command.aggregateId !== resolutionId ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== currentStateCommandKey ||
    snapshot?.id !== resolutionId ||
    snapshot.claimId !== claimId ||
    snapshot.slotId !== slotId ||
    snapshot.orderId !== orderId ||
    snapshot.phaseId !== phaseId ||
    snapshot.status !== sourceStatus ||
    snapshot.resultId !== previousResultId ||
    snapshot.currentStateCommandKey !== currentStateCommandKey ||
    snapshot.immutable !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement lifecycle must bind the selected Claim child command to its immutable source snapshot",
    );
  }
}

function requireCompleteReplacementRequiredSlotSet<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  allowCurrentPreHandoffJobStatus = false,
): void {
  if (Array.isArray(command.context?.replacementRequiredRequests)) {
    requireIndependentReplacementResourceSet(
      lifecycle,
      command,
      allowCurrentPreHandoffJobStatus,
    );
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
      (allowCurrentPreHandoffJobStatus
        ? !cancellableReplacementJobStatuses.has(
            group.currentReplacementJobStatus as string,
          )
        : group.currentReplacementJobStatus !== "created")
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
  allowCurrentPreHandoffJobStatus = false,
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
            (allowCurrentPreHandoffJobStatus
              ? !cancellableReplacementJobStatuses.has(
                  record.currentReplacementJobStatus as string,
                )
              : record.currentReplacementJobStatus !== "created")))
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
  selectedShipmentId?: string,
  cancellationRace = false,
  cancellationRaceShipmentSourceStatus: CancellationRaceShipmentSourceStatus = "cancellation_pending",
): void {
  if (lifecycle === "ClaimSlotResolution") {
    requireExactReplacementResolutionSource(
      lifecycle,
      command,
      "replacement_in_production",
      {
        previousResultId:
          command.context?.replacementHandoffPreviousResolutionResultId,
        currentStateCommandKey:
          command.context?.replacementHandoffCurrentStateCommandKey,
        expectedResolution:
          command.context?.replacementHandoffExpectedResolution,
      },
    );
  }
  const resultId = command.context?.replacementHandoffResultId;
  const claimId = command.context?.claimId;
  const resolutionId = command.context?.claimSlotResolutionId;
  if (
    typeof resultId !== "string" ||
    resultId.trim().length === 0 ||
    typeof claimId !== "string" ||
    claimId.trim().length === 0 ||
    typeof resolutionId !== "string" ||
    resolutionId.trim().length === 0 ||
    command.context?.replacementHandoffClaimId !== claimId ||
    command.context?.replacementHandoffResolutionId !== resolutionId ||
    command.context?.replacementHandoffResolutionPreviousStatus !==
      "replacement_in_production" ||
    command.context?.replacementHandoffResolutionTargetStatus !==
      "replacement_shipped" ||
    command.context?.replacementHandoffClaimResultId !== resultId ||
    command.context?.replacementHandoffResolutionResultId !== resultId ||
    command.context?.replacementHandoffAuthorizationResultId !== resultId ||
    command.context?.replacementHandoffShipmentSetResultId !== resultId ||
    command.context?.replacementHandoffJobSetResultId !== resultId ||
    (selectedShipmentId !== undefined &&
      (command.context?.replacementHandoffShipmentId !== selectedShipmentId ||
        command.context?.replacementHandoffSelectedShipmentResultId !==
          resultId))
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement handoff must bind its Claim child, authorization, Shipment set, and Job set to one result",
    );
  }
  if (Array.isArray(command.context?.replacementRequiredRequests)) {
    requireIndependentReplacementHandoff(
      lifecycle,
      command,
      selectedShipmentId,
      cancellationRace,
      cancellationRaceShipmentSourceStatus,
    );
    return;
  }
  requireCompleteReplacementRequiredSlotSet(lifecycle, command, true);
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
      cancellationRace && selectedShipmentId === shipmentId
        ? cancellationRaceShipmentSourceStatus
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
      group.replacementHandoffResultId !== resultId ||
      group.replacementShipmentResultId !== resultId ||
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
      group.currentReplacementJobResultId !== resultId ||
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
    (selectedShipmentId !== undefined &&
      !handoffShipmentIds.has(selectedShipmentId))
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

function requireExactReplacementRecoveryCancellation<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  requireExactReplacementResolutionSource(
    lifecycle,
    command,
    "replacement_in_production",
  );
  requireCompleteReplacementRequiredSlotSet(lifecycle, command, true);
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const exact = (
    expected: readonly string[],
    value: unknown,
  ): value is string[] =>
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((id) => nonBlank(id) && expected.includes(id)) &&
    new Set(value).size === value.length;
  const claimId = context?.claimId;
  const resolutionId = context?.claimSlotResolutionId;
  const slotId = context?.claimSlotId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const replacementSetId = context?.replacementSetId;
  const resultId = context?.replacementRecoveryCancellationResultId;
  const snapshotId = context?.replacementRecoveryCancellationExpectedSnapshotId;
  const snapshotValue =
    context?.replacementRecoveryCancellationExpectedSnapshot;
  const snapshot =
    typeof snapshotValue === "object" &&
    snapshotValue !== null &&
    !Array.isArray(snapshotValue)
      ? (snapshotValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    !nonBlank(claimId) ||
    !nonBlank(resolutionId) ||
    !nonBlank(slotId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(replacementSetId) ||
    !nonBlank(resultId) ||
    !nonBlank(snapshotId) ||
    snapshot?.id !== snapshotId ||
    snapshot.immutable !== true ||
    snapshot.claimId !== claimId ||
    snapshot.resolutionId !== resolutionId ||
    snapshot.slotId !== slotId ||
    snapshot.orderId !== orderId ||
    snapshot.phaseId !== phaseId ||
    snapshot.replacementSetId !== replacementSetId ||
    snapshot.resolutionPreviousStatus !== "replacement_in_production" ||
    snapshot.resolutionTargetStatus !== "recovery_pending" ||
    context?.replacementRecoveryCancellationClaimId !== claimId ||
    context?.replacementRecoveryCancellationResolutionId !== resolutionId ||
    context?.replacementRecoveryCancellationSlotId !== slotId ||
    context?.replacementRecoveryCancellationOrderId !== orderId ||
    context?.replacementRecoveryCancellationPhaseId !== phaseId ||
    context?.replacementRecoveryCancellationSetId !== replacementSetId ||
    context?.replacementRecoveryCancellationResolutionPreviousStatus !==
      "replacement_in_production" ||
    context?.replacementRecoveryCancellationResolutionTargetStatus !==
      "recovery_pending" ||
    context?.replacementRecoveryCancellationClaimResultId !== resultId ||
    context?.replacementRecoveryCancellationResolutionResultId !== resultId ||
    context?.replacementRecoveryCancellationRequestSetResultId !== resultId ||
    context?.replacementRecoveryCancellationReservationSetResultId !==
      resultId ||
    context?.replacementRecoveryCancellationShipmentSetResultId !== resultId ||
    context?.replacementRecoveryCancellationJobSetResultId !== resultId ||
    context?.replacementRecoveryCancellationAuthorizationResultId !==
      resultId ||
    context?.replacementRecoveryCancellationLabelSetResultId !== resultId
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement recovery cancellation must bind its exact Claim child and replacement set to one result",
    );
  }

  const legacyGroups = Array.isArray(context?.replacementRequiredResourceGroups)
    ? context.replacementRequiredResourceGroups
    : [];
  const legacyRecords = (
    kind: "Request" | "Reservation" | "Shipment" | "Job",
  ) =>
    legacyGroups.map((value) => {
      const group = value as Readonly<Record<string, unknown>>;
      if (kind === "Request") {
        return {
          id: group.replacementRequestId,
          slotIds: group.replacementRequestSlotIds,
        };
      }
      if (kind === "Reservation") {
        return {
          id: group.replacementReservationId,
          slotIds: group.replacementReservationSlotIds,
        };
      }
      if (kind === "Shipment") {
        return {
          id: group.replacementShipmentId,
          slotIds: group.replacementShipmentSlotIds,
        };
      }
      return {
        id: group.currentReplacementJobId,
        slotIds: group.currentReplacementJobSlotIds,
        currentReplacementJobStatus: group.currentReplacementJobStatus,
      };
    });
  const setupRecords = (
    independent: unknown,
    kind: Parameters<typeof legacyRecords>[0],
  ) => (Array.isArray(independent) ? independent : legacyRecords(kind));
  const requests = setupRecords(
    context?.replacementRequiredRequests,
    "Request",
  );
  const reservations = setupRecords(
    context?.replacementRequiredReservations,
    "Reservation",
  );
  const shipments = setupRecords(
    context?.replacementRequiredShipments,
    "Shipment",
  );
  const jobs = setupRecords(context?.replacementRequiredJobs, "Job");
  const snapshotRequests = snapshot.requests;
  const snapshotReservations = snapshot.reservations;
  const snapshotShipments = snapshot.shipments;
  const snapshotJobs = snapshot.jobs;

  const verify = (
    setup: readonly unknown[],
    expectedSnapshot: unknown,
    cancellations: unknown,
    expectedIds: unknown,
    allowedPreviousStatuses: readonly string[],
    targetStatus: string,
    label: string,
    requireCurrentLeaf = false,
    unchangedStatuses: readonly string[] = [],
  ): Readonly<Record<string, unknown>>[] => {
    const setupById = new Map<string, Readonly<Record<string, unknown>>>();
    for (const value of setup) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement recovery requires authoritative ${label} setup records`,
        );
      }
      const record = value as Readonly<Record<string, unknown>>;
      if (!nonBlank(record.id) || setupById.has(record.id)) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement recovery requires an exact ${label} setup set`,
        );
      }
      setupById.set(record.id, record);
    }
    const ids = [...setupById.keys()];
    if (
      ids.length === 0 ||
      !Array.isArray(expectedSnapshot) ||
      expectedSnapshot.length !== ids.length
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        `replacement recovery must cancel the complete exact ${label} set`,
      );
    }
    const snapshotById = new Map<string, Readonly<Record<string, unknown>>>();
    for (const value of expectedSnapshot) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement recovery requires identity-bearing expected ${label} records`,
        );
      }
      const record = value as Readonly<Record<string, unknown>>;
      const persisted = nonBlank(record.id)
        ? setupById.get(record.id)
        : undefined;
      if (
        !nonBlank(record.id) ||
        snapshotById.has(record.id) ||
        persisted === undefined ||
        !Array.isArray(persisted.slotIds) ||
        !exact(persisted.slotIds as string[], record.slotIds) ||
        record.claimId !== claimId ||
        record.resolutionId !== resolutionId ||
        record.replacementSetId !== replacementSetId ||
        !allowedPreviousStatuses.includes(record.status as string) ||
        (requireCurrentLeaf &&
          (record.currentReplacementJobLineageLeaf !== true ||
            record.status !== persisted.currentReplacementJobStatus))
      ) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement recovery expected ${label} snapshot must match its authoritative setup identity and current state`,
        );
      }
      snapshotById.set(record.id, record);
    }
    const transitionIds = ids.filter(
      (id) =>
        !unchangedStatuses.includes(snapshotById.get(id)?.status as string),
    );
    if (
      !exact(transitionIds, expectedIds) ||
      !Array.isArray(cancellations) ||
      cancellations.length !== transitionIds.length
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        `replacement recovery must account for the complete exact ${label} set`,
      );
    }
    const transitionIdSet = new Set(transitionIds);
    const seen = new Set<string>();
    const verified: Readonly<Record<string, unknown>>[] = [];
    for (const value of cancellations) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement recovery requires identity-bearing ${label} cancellation records`,
        );
      }
      const record = value as Readonly<Record<string, unknown>>;
      const id = record.id;
      const persisted = nonBlank(id) ? snapshotById.get(id) : undefined;
      if (
        !nonBlank(id) ||
        seen.has(id) ||
        !transitionIdSet.has(id) ||
        persisted === undefined ||
        !Array.isArray(persisted.slotIds) ||
        !exact(persisted.slotIds as string[], record.slotIds) ||
        record.claimId !== claimId ||
        record.resolutionId !== resolutionId ||
        record.replacementSetId !== replacementSetId ||
        record.previousStatus !== persisted.status ||
        record.targetStatus !== targetStatus ||
        record.resultId !== resultId ||
        (requireCurrentLeaf && record.currentReplacementJobLineageLeaf !== true)
      ) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          `replacement recovery must bind every ${label} cancellation to its exact setup identity and result`,
        );
      }
      seen.add(id);
      verified.push(record);
    }
    return verified;
  };

  verify(
    requests,
    snapshotRequests,
    context?.replacementRecoveryCancellationRequests,
    context?.replacementRecoveryCancellationRequestIds,
    ["open", "queued", "in_progress"],
    "cancelled",
    "request",
  );
  verify(
    reservations,
    snapshotReservations,
    context?.replacementRecoveryCancellationReservations,
    context?.replacementRecoveryCancellationReservationIds,
    ["active", "consumed"],
    "released",
    "ProductionReservation",
  );
  const cancelledShipments = verify(
    shipments,
    snapshotShipments,
    context?.replacementRecoveryCancellationShipments,
    context?.replacementRecoveryCancellationShipmentIds,
    ["planned", "label_created", "cancellation_pending"],
    "cancelled",
    "Shipment",
  );
  verify(
    jobs,
    snapshotJobs,
    context?.replacementRecoveryCancellationJobs,
    context?.replacementRecoveryCancellationJobIds,
    replacementRecoveryJobStatuses,
    "cancelled",
    "Job",
    true,
    ["failed"],
  );

  const snapshotAuthorizations = snapshot.authorizations;
  const authorizationIds =
    context?.replacementRecoveryCancellationAuthorizationIds;
  const authorizations = context?.replacementRecoveryCancellationAuthorizations;
  if (
    !Array.isArray(snapshotAuthorizations) ||
    snapshotAuthorizations.length === 0 ||
    !Array.isArray(authorizations) ||
    authorizations.length !== snapshotAuthorizations.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement recovery must invalidate its complete expected authorization set",
    );
  }
  const expectedAuthorizationIds = new Set<string>();
  const expectedAuthorizationById = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const value of snapshotAuthorizations) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement recovery requires identity-bearing expected authorization records",
      );
    }
    const authorization = value as Readonly<Record<string, unknown>>;
    if (
      !nonBlank(authorization.id) ||
      expectedAuthorizationIds.has(authorization.id) ||
      authorization.claimId !== claimId ||
      authorization.resolutionId !== resolutionId ||
      authorization.replacementSetId !== replacementSetId ||
      authorization.status !== "issued" ||
      !Array.isArray(authorization.shipmentIds) ||
      !exact(authorization.shipmentIds as string[], authorization.shipmentIds)
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement recovery expected authorization snapshot is invalid",
      );
    }
    expectedAuthorizationIds.add(authorization.id);
    expectedAuthorizationById.set(authorization.id, authorization);
  }
  if (!exact([...expectedAuthorizationIds], authorizationIds)) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement recovery authorization IDs must equal the expected set",
    );
  }
  const invalidatedAuthorizationIds = new Set<string>();
  for (const value of authorizations) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement recovery requires authorization cancellation records",
      );
    }
    const authorization = value as Readonly<Record<string, unknown>>;
    const expected = nonBlank(authorization.id)
      ? expectedAuthorizationById.get(authorization.id)
      : undefined;
    if (
      !nonBlank(authorization.id) ||
      invalidatedAuthorizationIds.has(authorization.id) ||
      expected === undefined ||
      authorization.claimId !== claimId ||
      authorization.resolutionId !== resolutionId ||
      authorization.replacementSetId !== replacementSetId ||
      !Array.isArray(expected.shipmentIds) ||
      !exact(expected.shipmentIds as string[], authorization.shipmentIds) ||
      authorization.previousStatus !== expected.status ||
      authorization.targetStatus !== "invalidated" ||
      authorization.resultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement recovery must bind every authorization invalidation to its expected identity and result",
      );
    }
    invalidatedAuthorizationIds.add(authorization.id);
  }

  const shipmentIds = cancelledShipments.map((record) => record.id as string);
  const authorizedShipmentIds = new Set<string>();
  for (const authorization of expectedAuthorizationById.values()) {
    for (const shipmentId of authorization.shipmentIds as string[]) {
      if (!shipmentIds.includes(shipmentId)) {
        throw new TransitionGuardError(
          lifecycle,
          command.current,
          command.target,
          "replacement recovery authorization scope contains a foreign Shipment",
        );
      }
      authorizedShipmentIds.add(shipmentId);
    }
  }
  if (shipmentIds.some((id) => !authorizedShipmentIds.has(id))) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement recovery must invalidate authorization for every expected Shipment",
    );
  }
  const expectedShipmentById = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const value of snapshotShipments as readonly unknown[]) {
    const shipment = value as Readonly<Record<string, unknown>>;
    expectedShipmentById.set(shipment.id as string, shipment);
  }
  for (const shipment of cancelledShipments) {
    const expected = expectedShipmentById.get(shipment.id as string);
    const labelled =
      expected?.status === "label_created" ||
      expected?.status === "cancellation_pending";
    if (
      expected === undefined ||
      (labelled &&
        (!nonBlank(expected.labelId) ||
          !nonBlank(expected.providerTransactionId) ||
          expected.labelStatus !== "created" ||
          shipment.labelId !== expected.labelId ||
          shipment.providerTransactionId !== expected.providerTransactionId ||
          shipment.cancellationIntermediateStatus !== "cancellation_pending" ||
          shipment.providerVoidStatus !== "succeeded" ||
          shipment.providerVoidAuthenticated !== true ||
          shipment.providerVoidVerified !== true ||
          shipment.providerVoidResultId !== resultId)) ||
      (!labelled &&
        (expected.status !== "planned" ||
          expected.labelId !== null ||
          expected.providerTransactionId !== null ||
          expected.labelStatus !== null ||
          shipment.labelId !== null ||
          shipment.providerTransactionId !== null ||
          shipment.cancellationIntermediateStatus !== null ||
          shipment.providerVoidStatus !== "not_required" ||
          shipment.providerVoidAuthenticated !== false ||
          shipment.providerVoidVerified !== false ||
          shipment.providerVoidResultId !== resultId))
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement recovery Shipment cancellation must follow its exact current label and provider-void branch",
      );
    }
  }
  const labelIds = context?.replacementRecoveryCancellationLabelIds;
  const labels = context?.replacementRecoveryCancellationLabels;
  const expectedLabels = [...expectedShipmentById.values()].filter((shipment) =>
    nonBlank(shipment.labelId),
  );
  const expectedLabelIds = expectedLabels.map(
    (shipment) => shipment.labelId as string,
  );
  if (
    !Array.isArray(labelIds) ||
    !Array.isArray(labels) ||
    !exact(expectedLabelIds, labelIds) ||
    labels.length !== expectedLabels.length
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement recovery must invalidate the complete exact label set",
    );
  }
  const labelledShipments = new Set<string>();
  const usedLabelIds = new Set<string>();
  for (const value of labels) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement recovery requires identity-bearing label cancellation records",
      );
    }
    const label = value as Readonly<Record<string, unknown>>;
    if (
      !nonBlank(label.id) ||
      !labelIds.includes(label.id) ||
      usedLabelIds.has(label.id) ||
      !nonBlank(label.shipmentId) ||
      !shipmentIds.includes(label.shipmentId) ||
      labelledShipments.has(label.shipmentId) ||
      expectedShipmentById.get(label.shipmentId)?.labelId !== label.id ||
      label.claimId !== claimId ||
      label.resolutionId !== resolutionId ||
      label.replacementSetId !== replacementSetId ||
      label.previousStatus !==
        expectedShipmentById.get(label.shipmentId)?.labelStatus ||
      label.targetStatus !== "invalidated" ||
      label.resultId !== resultId
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "replacement recovery must bind every label invalidation to its exact Shipment and result",
      );
    }
    usedLabelIds.add(label.id);
    labelledShipments.add(label.shipmentId);
  }
  if (
    labelIds.some((id) => !nonBlank(id) || !usedLabelIds.has(id)) ||
    expectedLabels.some(
      (shipment) =>
        !nonBlank(shipment.id) || !labelledShipments.has(shipment.id),
    ) ||
    [...expectedAuthorizationIds].some(
      (id) => !invalidatedAuthorizationIds.has(id),
    ) ||
    context?.replacementRecoveryCancellationCompleted !== true ||
    context?.replacementRecoveryCancellationAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "replacement recovery requires one complete atomic cancellation result",
    );
  }
}

function requireIndependentReplacementHandoff<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
  transitionShipmentId?: string,
  cancellationRace = false,
  cancellationRaceShipmentSourceStatus: CancellationRaceShipmentSourceStatus = "cancellation_pending",
): void {
  requireIndependentReplacementResourceSet(lifecycle, command, true);
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
        cancellationRace && transitionShipmentId === id
          ? cancellationRaceShipmentSourceStatus
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
    (transitionShipmentId !== undefined &&
      !shipmentIds.has(transitionShipmentId))
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
  const previousResolutionResultId =
    context?.reshipmentSetupPreviousResolutionResultId;
  const stateKey = context?.reshipmentSetupCurrentStateCommandKey;
  const expectedResolutionValue = context?.reshipmentSetupExpectedResolution;
  const expectedResolution =
    typeof expectedResolutionValue === "object" &&
    expectedResolutionValue !== null &&
    !Array.isArray(expectedResolutionValue)
      ? (expectedResolutionValue as Readonly<Record<string, unknown>>)
      : undefined;
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
    !nonBlank(previousResolutionResultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== resolutionId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateCommandKey !== stateKey ||
    command.currentStateResultId !== previousResolutionResultId ||
    expectedResolution?.id !== resolutionId ||
    expectedResolution.claimId !== claimId ||
    expectedResolution.slotId !== slotId ||
    expectedResolution.orderId !== orderId ||
    expectedResolution.phaseId !== phaseId ||
    expectedResolution.status !== command.current ||
    expectedResolution.resultId !== previousResolutionResultId ||
    expectedResolution.currentStateCommandKey !== stateKey ||
    expectedResolution.immutable !== true ||
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
  selectedShipmentId?: string,
  cancellationRace = false,
  cancellationRaceShipmentSourceStatus: CancellationRaceShipmentSourceStatus = "cancellation_pending",
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
  const resultId = context?.reshipmentHandoffResultId;
  const previousResolutionResultId =
    context?.reshipmentHandoffPreviousResolutionResultId;
  const stateKey = context?.reshipmentHandoffCurrentStateCommandKey;
  const expectedResolutionValue = context?.reshipmentHandoffExpectedResolution;
  const expectedResolution =
    typeof expectedResolutionValue === "object" &&
    expectedResolutionValue !== null &&
    !Array.isArray(expectedResolutionValue)
      ? (expectedResolutionValue as Readonly<Record<string, unknown>>)
      : undefined;

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
    !nonBlank(resultId) ||
    (selectedShipmentId === undefined
      ? currentShipmentId !== originalShipmentId
      : currentShipmentId !== selectedShipmentId ||
        selectedShipmentId !== newShipmentId) ||
    context?.reshipmentHandoffClaimResultId !== resultId ||
    context?.reshipmentHandoffResolutionResultId !== resultId ||
    context?.reshipmentHandoffAuthorizationResultId !== resultId ||
    context?.reshipmentHandoffShipmentResultId !== resultId ||
    context?.reshipmentHandoffOriginalJobResultId !== resultId ||
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
      (cancellationRace
        ? cancellationRaceShipmentSourceStatus
        : "label_created") ||
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
  if (!cancellationRace && lifecycle === "ClaimSlotResolution") {
    if (
      !nonBlank(previousResolutionResultId) ||
      !nonBlank(stateKey) ||
      command.aggregateId !== resolutionId ||
      command.currentStateResultId !== previousResolutionResultId ||
      command.currentStateCommandKey !== stateKey ||
      expectedResolution?.id !== resolutionId ||
      expectedResolution.claimId !== claimId ||
      expectedResolution.slotId !== slotId ||
      expectedResolution.orderId !== orderId ||
      expectedResolution.phaseId !== phaseId ||
      expectedResolution.status !== "reship_pending" ||
      expectedResolution.resultId !== previousResolutionResultId ||
      expectedResolution.currentStateCommandKey !== stateKey ||
      expectedResolution.immutable !== true
    ) {
      throw new TransitionGuardError(
        lifecycle,
        command.current,
        command.target,
        "reship handoff must bind the command-selected immutable Claim child",
      );
    }
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
  const setupPreviousResultId =
    context?.claimRefundSetupPreviousResolutionResultId;
  const setupStateKey = context?.claimRefundSetupCurrentStateCommandKey;
  const setupExpectedValue = context?.claimRefundSetupExpectedResolution;
  const setupExpected =
    typeof setupExpectedValue === "object" &&
    setupExpectedValue !== null &&
    !Array.isArray(setupExpectedValue)
      ? (setupExpectedValue as Readonly<Record<string, unknown>>)
      : undefined;
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
    typeof setupPreviousResultId !== "string" ||
    setupPreviousResultId.trim().length === 0 ||
    typeof setupStateKey !== "string" ||
    setupStateKey.trim().length === 0 ||
    command.aggregateId !== resolutionId ||
    command.currentStateResultId !== setupPreviousResultId ||
    command.currentStateCommandKey !== setupStateKey ||
    setupExpected?.id !== resolutionId ||
    setupExpected.claimId !== claimId ||
    setupExpected.slotId !== slotId ||
    setupExpected.orderId !== orderId ||
    setupExpected.phaseId !== phaseId ||
    setupExpected.status !== command.current ||
    setupExpected.resultId !== setupPreviousResultId ||
    setupExpected.currentStateCommandKey !== setupStateKey ||
    setupExpected.immutable !== true ||
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
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const resolutionId = context?.claimSlotResolutionId;
  const claimId = context?.claimId;
  const slotId = context?.claimSlotId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const paymentId = context?.paymentId;
  const refundTransactionId = context?.refundTransactionId;
  const providerEventId = context?.refundProviderEventId;
  const refundAmountMinor = context?.refundWebhookAmountMinor;
  const previousResultId = context?.claimRefundPreviousResolutionResultId;
  const resultId = context?.claimRefundCompletionResultId;
  const stateKey = context?.claimRefundCurrentStateCommandKey;
  const currentStateResultId = command.currentStateResultId;
  const expectedValue = context?.claimRefundExpectedResolution;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const transactionValue = context?.claimRefundCompletionTransaction;
  const transaction =
    typeof transactionValue === "object" &&
    transactionValue !== null &&
    !Array.isArray(transactionValue)
      ? (transactionValue as Readonly<Record<string, unknown>>)
      : undefined;
  const eventValue = context?.claimRefundCompletionProviderEvent;
  const event =
    typeof eventValue === "object" &&
    eventValue !== null &&
    !Array.isArray(eventValue)
      ? (eventValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    !nonBlank(resolutionId) ||
    !nonBlank(claimId) ||
    !nonBlank(slotId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(paymentId) ||
    !nonBlank(refundTransactionId) ||
    !nonBlank(providerEventId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(resultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== resolutionId ||
    currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    context?.claimRefundResolutionId !== resolutionId ||
    context?.claimRefundClaimId !== claimId ||
    context?.claimRefundSlotId !== slotId ||
    context?.claimRefundPaymentId !== paymentId ||
    context?.refundWebhookPaymentId !== paymentId ||
    context?.claimRefundTransactionId !== refundTransactionId ||
    context?.refundWebhookRefundTransactionId !== refundTransactionId ||
    context?.claimRefundProviderEventId !== providerEventId ||
    typeof refundAmountMinor !== "bigint" ||
    refundAmountMinor <= 0n ||
    context?.claimRefundExpectedAmountMinor !== refundAmountMinor ||
    expected?.id !== resolutionId ||
    expected.claimId !== claimId ||
    expected.slotId !== slotId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.status !== "refund_pending" ||
    expected.activeClaimId !== claimId ||
    expected.paymentId !== paymentId ||
    expected.refundTransactionId !== refundTransactionId ||
    expected.amountMinor !== refundAmountMinor ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true ||
    transaction?.id !== refundTransactionId ||
    transaction.resolutionId !== resolutionId ||
    transaction.claimId !== claimId ||
    transaction.slotId !== slotId ||
    transaction.orderId !== orderId ||
    transaction.phaseId !== phaseId ||
    transaction.paymentId !== paymentId ||
    transaction.amountMinor !== refundAmountMinor ||
    transaction.status !== "succeeded" ||
    transaction.providerEventId !== providerEventId ||
    transaction.resultId !== resultId ||
    transaction.immutable !== true ||
    event?.id !== providerEventId ||
    event.resolutionId !== resolutionId ||
    event.refundTransactionId !== refundTransactionId ||
    event.paymentId !== paymentId ||
    event.amountMinor !== refundAmountMinor ||
    event.status !== "succeeded" ||
    event.projectedTarget !== command.target ||
    event.authenticated !== true ||
    event.verified !== true ||
    event.resultId !== resultId ||
    event.immutable !== true ||
    context?.claimRefundCompletionResolutionResultId !== resultId ||
    context?.claimRefundCompletionTransactionResultId !== resultId ||
    context?.claimRefundCompletionProviderEventResultId !== resultId ||
    context?.claimRefundCompletionPaymentResultId !== resultId ||
    context?.claimRefundCompletionCompleted !== true
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

function requireExactReprintSelection<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const context = command.context;
  const nonBlank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const resolutionId = context?.claimSlotResolutionId;
  const claimId = context?.claimId;
  const slotId = context?.claimSlotId;
  const orderId = context?.orderId;
  const phaseId = context?.phaseId;
  const artifactId = context?.reprintSelectionArtifactId;
  const sourceJobId = context?.reprintSelectionSourceJobId;
  const sourceShipmentId = context?.reprintSelectionSourceShipmentId;
  const artifactVersionId = context?.reprintSelectionArtifactVersionId;
  const configRevisionId = context?.reprintSelectionPrintConfigRevisionId;
  const previousResultId = context?.reprintSelectionPreviousResolutionResultId;
  const resultId = context?.reprintSelectionResultId;
  const stateKey = context?.reprintSelectionCurrentStateCommandKey;
  const expectedValue = context?.reprintSelectionExpectedResolution;
  const expected =
    typeof expectedValue === "object" &&
    expectedValue !== null &&
    !Array.isArray(expectedValue)
      ? (expectedValue as Readonly<Record<string, unknown>>)
      : undefined;
  const ownershipValue = context?.reprintSelectionSlotOwnership;
  const ownership =
    typeof ownershipValue === "object" &&
    ownershipValue !== null &&
    !Array.isArray(ownershipValue)
      ? (ownershipValue as Readonly<Record<string, unknown>>)
      : undefined;
  const artifactValue = context?.reprintSelectionArtifact;
  const artifact =
    typeof artifactValue === "object" &&
    artifactValue !== null &&
    !Array.isArray(artifactValue)
      ? (artifactValue as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    !nonBlank(resolutionId) ||
    !nonBlank(claimId) ||
    !nonBlank(slotId) ||
    !nonBlank(orderId) ||
    !nonBlank(phaseId) ||
    !nonBlank(artifactId) ||
    !nonBlank(sourceJobId) ||
    !nonBlank(sourceShipmentId) ||
    !nonBlank(artifactVersionId) ||
    !nonBlank(configRevisionId) ||
    !nonBlank(previousResultId) ||
    !nonBlank(resultId) ||
    !nonBlank(stateKey) ||
    command.aggregateId !== resolutionId ||
    !nonBlank(command.currentStateResultId) ||
    command.currentStateResultId !== previousResultId ||
    command.currentStateCommandKey !== stateKey ||
    context?.reprintSelectionPreviousStatus !== command.current ||
    context?.reprintSelectionTargetStatus !== "reprint_pending" ||
    expected?.id !== resolutionId ||
    expected.claimId !== claimId ||
    expected.slotId !== slotId ||
    expected.orderId !== orderId ||
    expected.phaseId !== phaseId ||
    expected.status !== command.current ||
    expected.activeClaimId !== claimId ||
    expected.canonicalDeliveredArtifactId !== artifactId ||
    expected.canonicalDeliveredArtifactSourceJobId !== sourceJobId ||
    expected.canonicalDeliveredArtifactSourceShipmentId !== sourceShipmentId ||
    expected.canonicalDeliveredArtifactVersionId !== artifactVersionId ||
    expected.canonicalDeliveredPrintConfigRevisionId !== configRevisionId ||
    expected.resultId !== previousResultId ||
    expected.currentStateCommandKey !== stateKey ||
    expected.immutable !== true ||
    ownership?.slotId !== slotId ||
    ownership.claimId !== claimId ||
    ownership.activeClaimId !== claimId ||
    ownership.resolutionId !== resolutionId ||
    ownership.orderId !== orderId ||
    ownership.phaseId !== phaseId ||
    ownership.immutable !== true ||
    artifact?.id !== artifactId ||
    artifact.sourceJobId !== sourceJobId ||
    artifact.sourceShipmentId !== sourceShipmentId ||
    artifact.claimId !== claimId ||
    artifact.resolutionId !== resolutionId ||
    artifact.orderId !== orderId ||
    artifact.phaseId !== phaseId ||
    artifact.slotId !== slotId ||
    artifact.reproductionArtifactVersionId !== artifactVersionId ||
    artifact.printConfigRevisionId !== configRevisionId ||
    artifact.status !== "sealed" ||
    artifact.delivered !== true ||
    artifact.currentLineageLeaf !== true ||
    artifact.canonical !== true ||
    artifact.immutable !== true ||
    artifact.resultId !== resultId ||
    context?.reprintSelectionResolutionResultId !== resultId ||
    context?.reprintSelectionSlotResultId !== resultId ||
    context?.reprintSelectionArtifactResultId !== resultId ||
    context?.reprintSelectionConfigResultId !== resultId ||
    context?.reprintSelectionCompleted !== true ||
    context?.reprintSelectionAtomic !== true
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "reprint selection requires the command-selected Claim slot and its exact canonical delivered reproduction artifact",
    );
  }
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
      if (
        (command.current === "pending" ||
          command.current === "recovery_pending") &&
        command.target === "reprint_pending"
      ) {
        requireExactReprintSelection("ClaimSlotResolution", command);
      }
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
        requireExactReplacementResolutionSource(
          "ClaimSlotResolution",
          command,
          "reprint_pending",
        );
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
        requireExactReplacementRecoveryCancellation(
          "ClaimSlotResolution",
          command,
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
