import { describe, expect, it } from "vitest";
import { Money } from "../primitives/money.js";
import { allocateMoney, allocatePriceComponents } from "./allocations.js";

describe("price component allocations", () => {
  it("uses largest remainder and stable target-ID ties", () => {
    const allocations = allocateMoney(Money.of(10n, "CZK"), [
      { id: "slot-b", basis: 1n },
      { id: "slot-a", basis: 1n },
      { id: "slot-c", basis: 1n },
    ]);
    expect(allocations).toEqual([
      { targetId: "slot-b", amount: Money.of(3n, "CZK") },
      { targetId: "slot-a", amount: Money.of(4n, "CZK") },
      { targetId: "slot-c", amount: Money.of(3n, "CZK") },
    ]);
    expect(
      allocations.reduce(
        (sum, allocation) => sum + allocation.amount.minorUnits,
        0n,
      ),
    ).toBe(10n);
  });

  it("splits an all-zero basis equally and emits separately reconcilable components", () => {
    const components = allocatePriceComponents([
      {
        componentId: "shipping",
        amount: Money.of(1n, "CZK"),
        targets: [
          { id: "slot-z", basis: 0n },
          { id: "slot-a", basis: 0n },
        ],
      },
      {
        componentId: "express",
        amount: Money.of(5n, "CZK"),
        targets: [{ id: "slot-a", basis: 1n }],
      },
    ]);
    expect(components[0]?.allocations).toEqual([
      { targetId: "slot-z", amount: Money.of(0n, "CZK") },
      { targetId: "slot-a", amount: Money.of(1n, "CZK") },
    ]);
    expect(components[1]?.allocations[0]?.amount).toEqual(Money.of(5n, "CZK"));
  });

  it("rejects duplicate target and component identities", () => {
    expect(() =>
      allocateMoney(Money.of(1n, "CZK"), [
        { id: "slot", basis: 1n },
        { id: "slot", basis: 1n },
      ]),
    ).toThrow(/must be unique/);
    expect(() =>
      allocatePriceComponents([
        {
          componentId: "x",
          amount: Money.of(1n, "CZK"),
          targets: [{ id: "a", basis: 1n }],
        },
        {
          componentId: "x",
          amount: Money.of(1n, "CZK"),
          targets: [{ id: "b", basis: 1n }],
        },
      ]),
    ).toThrow(/must be unique/);
  });
});
