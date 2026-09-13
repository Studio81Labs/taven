import type { OperatorRole } from "@prisma/client";

export const OPERATOR_PERMISSIONS = {
  OPERATIONS_READ: "operations:read",
  OPERATIONS_WRITE: "operations:write",
  QUOTES_WRITE: "quotes:write",
  PAYMENTS_WRITE: "payments:write",
  FINANCIAL_EXCEPTION: "financial:exception",
  AUDIT_READ: "audit:read",
  METRICS_READ: "metrics:read",
  CATALOG_WRITE: "catalog:write",
  LEGAL_READ: "legal:read",
  LEGAL_WRITE: "legal:write",
} as const;

export type OperatorPermission =
  (typeof OPERATOR_PERMISSIONS)[keyof typeof OPERATOR_PERMISSIONS];

const ROLE_PERMISSIONS: Readonly<
  Record<OperatorRole, readonly OperatorPermission[]>
> = {
  ADMIN: Object.values(OPERATOR_PERMISSIONS),
  OPERATOR: [
    OPERATOR_PERMISSIONS.OPERATIONS_READ,
    OPERATOR_PERMISSIONS.OPERATIONS_WRITE,
    OPERATOR_PERMISSIONS.QUOTES_WRITE,
    OPERATOR_PERMISSIONS.PAYMENTS_WRITE,
  ],
  VIEWER: [OPERATOR_PERMISSIONS.OPERATIONS_READ],
};

export function permissionsForRole(
  role: OperatorRole,
): readonly OperatorPermission[] {
  return ROLE_PERMISSIONS[role];
}
