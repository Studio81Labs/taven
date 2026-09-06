import { Module } from "@nestjs/common";
import { FetchGithubAuthAdapter } from "./fetch-github-auth.adapter";
import { GITHUB_AUTH } from "./github-auth.port";
import { OperatorAccessGuard } from "./operator-access.guard";
import { OperatorAuthController } from "./operator-auth.controller";
import { OperatorAuthService } from "./operator-auth.service";

@Module({
  controllers: [OperatorAuthController],
  providers: [
    OperatorAccessGuard,
    OperatorAuthService,
    FetchGithubAuthAdapter,
    { provide: GITHUB_AUTH, useExisting: FetchGithubAuthAdapter },
  ],
  exports: [OperatorAccessGuard, OperatorAuthService],
})
export class AdminAccessModule {}
