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

function requireAllShipmentLineageLeavesDelivered<S extends string>(
  lifecycle: string,
  command: TransitionCommand<S>,
): void {
  const leaves = command.context?.shipmentLineageLeafStatuses;
  if (
    !Array.isArray(leaves) ||
    leaves.length === 0 ||
    leaves.some((status) => status !== "delivered")
  ) {
    throw new TransitionGuardError(
      lifecycle,
      command.current,
      command.target,
      "delivery requires every current shipment lineage leaf to be delivered",
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
    pending: ["captured", "failed", "voided"],
    captured: ["refund_pending"],
    partially_refunded: ["refund_pending"],
    voided: ["refund_pending"],
    refund_pending: ["partially_refunded", "refunded"],
  },
  guard: (command) => {
    if (command.current === "pending" && command.target === "captured") {
      requireFlag(
        "Payment",
        command,
        "captureAuthorized",
        "capture must be authorized and before its immutable cutoff",
      );
    }
    if (command.current === "voided" && command.target === "refund_pending") {
      requireFlag(
        "Payment",
        command,
        "verifiedLateCapture",
        "a voided payment may be refunded only after verified late capture",
      );
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
    if (command.current === "quoted" && command.target === "confirmed") {
      requireFlag(
        "Order",
        command,
        "completeReservationCaptured",
        "capture and the complete phase reservation set must be valid",
      );
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
      requireZeroBalances("Order", command);
    }
    if (
      command.current === "awaiting_balance" &&
      command.target === "ready_to_ship"
    ) {
      requireZeroBalances("Order", command);
    }
    if (command.current === "shipped" && command.target === "delivered") {
      requireAllShipmentLineageLeavesDelivered("Order", command);
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
    if (command.current === "created" && command.target === "accepted") {
      requireFlag(
        "Job",
        command,
        "nodeAssigned",
        "acceptance requires a verified node assignment",
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
      requireFlag(
        "Shipment",
        command,
        "contextHandoffCompleted",
        "the complete context-specific handoff or reconciliation must complete",
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
  status: ClaimSlotResolutionStatus,
): status is ClaimSlotResolutionTerminalStatus {
  return Object.prototype.hasOwnProperty.call(claimTerminalProjection, status);
}

/** Projects a claim's terminal status from every child resolution disposition. */
export function projectClaimTerminalStatus(
  statuses: readonly ClaimSlotResolutionStatus[],
): ClaimStatus | undefined {
  if (
    statuses.length === 0 ||
    statuses.some((status) => !isClaimSlotResolutionTerminalStatus(status))
  ) {
    return undefined;
  }

  const firstStatus = statuses[0];
  if (firstStatus === undefined) {
    return undefined;
  }
  if (!isClaimSlotResolutionTerminalStatus(firstStatus)) {
    return undefined;
  }
  if (statuses.every((status) => status === firstStatus)) {
    return claimTerminalProjection[firstStatus];
  }

  if (
    statuses.some((status) => status === "rejected" || status === "withdrawn")
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
        requireFlag(
          "ClaimSlotResolution",
          command,
          "verifiedShipmentIncident",
          "a shipped remedy can recover only after a verified lost or returned incident",
        );
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
