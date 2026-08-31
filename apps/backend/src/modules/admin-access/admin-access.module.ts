import { Module } from "@nestjs/common";
import { OperatorAccessGuard } from "./operator-access.guard";

@Module({
  providers: [OperatorAccessGuard],
  exports: [OperatorAccessGuard],
})
export class AdminAccessModule {}
