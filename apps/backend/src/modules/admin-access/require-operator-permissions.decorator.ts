import { SetMetadata } from "@nestjs/common";
import type { OperatorPermission } from "./operator-permissions";

export const OPERATOR_PERMISSIONS_KEY = "taven:operator-permissions";

export const RequireOperatorPermissions = (
  ...permissions: OperatorPermission[]
) => SetMetadata(OPERATOR_PERMISSIONS_KEY, permissions);
