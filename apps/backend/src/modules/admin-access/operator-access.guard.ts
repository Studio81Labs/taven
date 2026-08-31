import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

type RequestWithHeaders = {
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};

/**
 * Minimal fail-closed boundary for v0 operator commands. Issue #24 owns the
 * eventual session/role strategy; this guard deliberately exposes no identity
 * or authorization policy beyond possession of the deployment secret.
 */
@Injectable()
export class OperatorAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configured = process.env.TAVEN_OPERATOR_API_TOKEN;
    const header = context.switchToHttp().getRequest<RequestWithHeaders>()
      .headers.authorization;
    const authorization = Array.isArray(header) ? header[0] : header;
    const match = /^Bearer (\S+)$/.exec(authorization ?? "");
    const presented = match?.[1];

    if (
      !configured ||
      configured.length < 32 ||
      !presented ||
      !equalSecret(presented, configured)
    ) {
      throw new UnauthorizedException("Operator access is unavailable");
    }
    return true;
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
