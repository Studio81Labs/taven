import type { PaymentProjection } from "./financial.js";

export type CurrentJobLeafStatus =
  "qc_approved" | "packed" | "handed_over" | "settled" | "other";

export interface FulfilmentSlotState {
  readonly id: string;
  readonly currentJobLeafStatus?: CurrentJobLeafStatus;
  readonly hasOpenReplacement: boolean;
  readonly recoveryBlocked?: boolean;
  readonly outcome?: "delivered" | "cancelled_refunded" | "pending";
}

/** Every required slot needs an approved current leaf and no open replacement. */
export function isQcReady(slots: readonly FulfilmentSlotState[]): boolean {
  return (
    slots.length > 0 &&
    slots.every(
      (slot) =>
        !slot.hasOpenReplacement &&
        (slot.currentJobLeafStatus === "qc_approved" ||
          slot.currentJobLeafStatus === "packed" ||
          slot.currentJobLeafStatus === "handed_over" ||
          slot.currentJobLeafStatus === "settled"),
    )
  );
}

/** Handoff is scoped to one complete Shipment slot set. */
export function isShipmentHandoffReady(
  shipmentSlots: readonly FulfilmentSlotState[],
  balances: Pick<PaymentProjection, "amountDue" | "refundableBalance">,
): boolean {
  return (
    shipmentSlots.length > 0 &&
    balances.amountDue.minorUnits === 0n &&
    balances.refundableBalance.minorUnits === 0n &&
    shipmentSlots.every(
      (slot) =>
        slot.currentJobLeafStatus === "packed" &&
        !slot.hasOpenReplacement &&
        !slot.recoveryBlocked,
    )
  );
}

export type SlotCompletion =
  | "all_delivered"
  | "partially_fulfilled"
  | "all_cancelled_refunded"
  | "pending";

export type SinglePhaseCompletion =
  "completed" | "partially_fulfilled" | "cancelled_refunded" | "pending";

export type OrderCompletion =
  "completed" | "partially_fulfilled" | "refunded" | "pending";

/**
 * The same completion barrier serves a single phase and its v0 Order: never
 * complete after one of several parcels merely happens to be delivered.
 */
export function projectSlotCompletion(
  slots: readonly FulfilmentSlotState[],
): SlotCompletion {
  if (
    slots.length === 0 ||
    slots.some(
      (slot) => slot.outcome === undefined || slot.outcome === "pending",
    )
  ) {
    return "pending";
  }
  const delivered = slots.filter((slot) => slot.outcome === "delivered").length;
  const cancelledRefunded = slots.filter(
    (slot) => slot.outcome === "cancelled_refunded",
  ).length;
  if (delivered === slots.length) return "all_delivered";
  if (delivered > 0 && delivered + cancelledRefunded === slots.length)
    return "partially_fulfilled";
  if (cancelledRefunded === slots.length) return "all_cancelled_refunded";
  return "pending";
}

export function projectSinglePhaseCompletion(
  slots: readonly FulfilmentSlotState[],
): SinglePhaseCompletion {
  const completion = projectSlotCompletion(slots);
  if (completion === "all_delivered") return "completed";
  if (completion === "all_cancelled_refunded") return "cancelled_refunded";
  return completion;
}

export function projectOrderCompletion(
  slots: readonly FulfilmentSlotState[],
): OrderCompletion {
  const completion = projectSlotCompletion(slots);
  if (completion === "all_delivered") return "completed";
  if (completion === "all_cancelled_refunded") return "refunded";
  return completion;
}
