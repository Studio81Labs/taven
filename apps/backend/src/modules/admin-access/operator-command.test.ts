import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  assertOperationalOrderScope,
  operatorNode,
  requireOperatorPermission,
} from "./operator-command";
import type { OperatorContext } from "./operator-context";
import { OPERATOR_PERMISSIONS } from "./operator-permissions";

const nodeId = "11111111-1111-4111-8111-111111111111";
const otherNodeId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";

function operator(overrides: Partial<OperatorContext> = {}): OperatorContext {
  return {
    operatorId: "44444444-4444-4444-8444-444444444444",
    role: "OPERATOR",
    permissions: [OPERATOR_PERMISSIONS.OPERATIONS_WRITE],
    nodeIds: [nodeId],
    authenticationMethod: "DEVELOPMENT_PASSWORD",
    sessionId: "55555555-5555-4555-8555-555555555555",
    ...overrides,
  };
}

function transactionWithNodes(nodes: string[]) {
  return {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(nodes.map((node_id) => ({ node_id }))),
  };
}

describe("operator command boundary", () => {
  it("refuses missing or ambiguous grants instead of selecting a node", () => {
    expect(() => operatorNode(operator({ nodeIds: [] }))).toThrow(
      ForbiddenException,
    );
    expect(() =>
      operatorNode(operator({ nodeIds: [nodeId, otherNodeId] })),
    ).toThrow(ForbiddenException);
  });

  it("enforces application permissions independently of an HTTP guard", () => {
    expect(() =>
      requireOperatorPermission(
        operator(),
        OPERATOR_PERMISSIONS.OPERATIONS_READ,
      ),
    ).toThrow(ForbiddenException);
  });

  it("allows an order only when every persisted operational lineage is at the acting node", async () => {
    const transaction = transactionWithNodes([nodeId]);

    await expect(
      assertOperationalOrderScope(transaction as never, orderId, nodeId),
    ).resolves.toBeUndefined();
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it.each([
    { nodes: [] },
    { nodes: [otherNodeId] },
    { nodes: [nodeId, otherNodeId] },
  ])(
    "fails closed for absent, foreign, or mixed order scope",
    async ({ nodes }) => {
      const transaction = transactionWithNodes(nodes);

      await expect(
        assertOperationalOrderScope(transaction as never, orderId, nodeId),
      ).rejects.toThrow(NotFoundException);
    },
  );

  it("normalizes a missing canonical order lock to the generic not-found outcome", async () => {
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockRejectedValue({ code: "P2010", meta: { code: "23503" } }),
    };

    await expect(
      assertOperationalOrderScope(transaction as never, orderId, nodeId),
    ).rejects.toThrow(NotFoundException);
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
  });
});
