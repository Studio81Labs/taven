import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AdminRequest, OperatorContext } from "./operator-context";

export const CurrentOperator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OperatorContext | undefined =>
    context.switchToHttp().getRequest<AdminRequest>().operator,
);
