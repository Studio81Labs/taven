import { describe, expect, it } from "vitest";
import {
  OPERATOR_PERMISSIONS,
  permissionsForRole,
} from "./operator-permissions";

describe("operator permissions", () => {
  it("keeps exceptional financial access restricted to administrators", () => {
    expect(permissionsForRole("ADMIN")).toContain(
      OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION,
    );
    expect(permissionsForRole("OPERATOR")).not.toContain(
      OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION,
    );
    expect(permissionsForRole("VIEWER")).not.toContain(
      OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION,
    );
  });

  it("keeps legal document management restricted to administrators", () => {
    expect(permissionsForRole("ADMIN")).toContain(
      OPERATOR_PERMISSIONS.LEGAL_READ,
    );
    expect(permissionsForRole("ADMIN")).toContain(
      OPERATOR_PERMISSIONS.LEGAL_WRITE,
    );
    expect(permissionsForRole("OPERATOR")).not.toContain(
      OPERATOR_PERMISSIONS.LEGAL_READ,
    );
    expect(permissionsForRole("OPERATOR")).not.toContain(
      OPERATOR_PERMISSIONS.LEGAL_WRITE,
    );
    expect(permissionsForRole("VIEWER")).not.toContain(
      OPERATOR_PERMISSIONS.LEGAL_READ,
    );
    expect(permissionsForRole("VIEWER")).not.toContain(
      OPERATOR_PERMISSIONS.LEGAL_WRITE,
    );
  });

  it("permits viewers only scoped operational reads", () => {
    expect(permissionsForRole("VIEWER")).toEqual([
      OPERATOR_PERMISSIONS.OPERATIONS_READ,
    ]);
  });
});
