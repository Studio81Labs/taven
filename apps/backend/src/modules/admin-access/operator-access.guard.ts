import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OperatorAuthService } from "./operator-auth.service";
import type { AdminRequest } from "./operator-context";
import { OPERATOR_PERMISSIONS_KEY } from "./require-operator-permissions.decorator";
import type { OperatorPermission } from "./operator-permissions";
import { ALLOW_NODE_FREE_ADMIN_KEY } from "./allow-node-free-admin.decorator";

/**
 * Authenticates the operator's browser session and applies route permissions.
 * Unsafe methods additionally require the session-bound CSRF header.
 * By default requires exactly 1 node scope; node-free ADMIN is allowed only
 * when decorated with @AllowNodeFreeAdmin().
 */
@Injectable()
export class OperatorAccessGuard implements CanActivate {
  constructor(
    private readonly auth: OperatorAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AdminRequest & { method?: string }>();
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string): void }>();
    response.setHeader("Cache-Control", "no-store");
    const operator = await this.auth.authenticateRequest(request);

    const allowNodeFreeAdmin =
      this.reflector.getAllAndOverride<boolean>(ALLOW_NODE_FREE_ADMIN_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    if (!allowNodeFreeAdmin || operator.role !== "ADMIN") {
      if (operator.nodeIds.length !== 1) {
        throw new ForbiddenException("Operator node scope is unavailable");
      }
    }

    if (!isSafeMethod(request.method)) {
      await this.auth.assertCsrf(request);
    }
    const required =
      this.reflector.getAllAndOverride<OperatorPermission[]>(
        OPERATOR_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    if (
      !required.every((permission) => operator.permissions.includes(permission))
    ) {
      return false;
    }
    request.operator = operator;
    return true;
  }
}

function isSafeMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
