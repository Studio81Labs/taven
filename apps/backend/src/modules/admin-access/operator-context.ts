import type {
  OperatorAuthenticationMethod,
  OperatorRole,
} from "@prisma/client";
import type { OperatorPermission } from "./operator-permissions";

export type OperatorContext = Readonly<{
  operatorId: string;
  role: OperatorRole;
  permissions: readonly OperatorPermission[];
  nodeIds: readonly string[];
  authenticationMethod: OperatorAuthenticationMethod;
  sessionId: string;
}>;

export type AdminRequest = {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  ip?: string;
  socket?: { remoteAddress?: string };
  operator?: OperatorContext;
};
