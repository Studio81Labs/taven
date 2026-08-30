import { describe, expect, it } from "vitest";
import { DomainError } from "../primitives/errors.js";
import { orderLockTargets, type LockTarget } from "./lock-order.js";

describe("orderLockTargets", () => {
  it("sorts every command lock set by rank and canonical identity", () => {
    const input = [
      { kind: "payment", id: "payment-b" },
      { kind: "job", id: "job-b", nodeId: "node-1" },
      { kind: "order_phase", id: "phase-1" },
      { kind: "order", id: "order-1" },
      { kind: "job", id: "job-a", nodeId: "node-1" },
      { kind: "shipment", id: "shipment-1" },
      { kind: "shipment_plan", id: "shipment-plan-1" },
      { kind: "payment", id: "payment-a" },
      {
        kind: "inventory_reservation",
        id: "inventory-1",
        nodeId: "node-1",
      },
    ] as const satisfies readonly LockTarget[];

    expect(
      orderLockTargets(input).map(({ kind, id }) => `${kind}:${id}`),
    ).toEqual([
      "order:order-1",
      "order_phase:phase-1",
      "shipment_plan:shipment-plan-1",
      "job:job-a",
      "job:job-b",
      "shipment:shipment-1",
      "payment:payment-a",
      "payment:payment-b",
      "inventory_reservation:inventory-1",
    ]);
    expect(input[0].id).toBe("payment-b");
  });

  it("requires node scope for operational resources and jobs", () => {
    expect(() => orderLockTargets([{ kind: "job", id: "job-1" }])).toThrow(
      expect.objectContaining<Partial<DomainError>>({
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it.each(["payment", "shipment"] as const)(
    "rejects node scope on globally scoped %s targets",
    (kind) => {
      expect(() =>
        orderLockTargets([{ kind, id: `${kind}-1`, nodeId: "node-1" }]),
      ).toThrow(/must not include node scope/);
    },
  );

  it("keeps a phase reservation set and its children in one node scope", () => {
    const targets = [
      { kind: "production_reservation", id: "reservation-b", nodeId: "node-1" },
      { kind: "phase_reservation_set", id: "set-1", nodeId: "node-1" },
      { kind: "production_reservation", id: "reservation-a", nodeId: "node-1" },
    ] as const satisfies readonly LockTarget[];

    expect(orderLockTargets(targets)).toEqual([
      { kind: "phase_reservation_set", id: "set-1", nodeId: "node-1" },
      { kind: "production_reservation", id: "reservation-a", nodeId: "node-1" },
      { kind: "production_reservation", id: "reservation-b", nodeId: "node-1" },
    ]);
  });

  it("rejects duplicate targets", () => {
    const target = { kind: "payment", id: "payment-1" } as const;
    expect(() => orderLockTargets([target, target])).toThrow(
      /Duplicate lock target/,
    );
  });

  it("cannot use node IDs to split a duplicate global lock target", () => {
    expect(() =>
      orderLockTargets([
        { kind: "payment", id: "payment-1", nodeId: "node-a" },
        { kind: "payment", id: "payment-1", nodeId: "node-b" },
      ]),
    ).toThrow(/must not include node scope/);
  });

  it("cannot use node IDs to derive a different global lock order", () => {
    expect(() =>
      orderLockTargets([
        { kind: "shipment", id: "shipment-a", nodeId: "node-z" },
        { kind: "shipment", id: "shipment-b", nodeId: "node-a" },
      ]),
    ).toThrow(/must not include node scope/);
  });

  it("does not collide when opaque node and target IDs contain delimiters", () => {
    const targets = [
      { kind: "job", nodeId: "a:b", id: "c" },
      { kind: "job", nodeId: "a", id: "b:c" },
    ] as const;
    expect(orderLockTargets(targets)).toHaveLength(2);
  });
});
