import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { FetchGithubAuthAdapter } from "./modules/admin-access/fetch-github-auth.adapter";
import { GITHUB_AUTH } from "./modules/admin-access/github-auth.port";
import { OperatorAuthService } from "./modules/admin-access/operator-auth.service";

@Module({
  imports: [PrismaModule],
  providers: [
    OperatorAuthService,
    FetchGithubAuthAdapter,
    { provide: GITHUB_AUTH, useExisting: FetchGithubAuthAdapter },
  ],
})
export class OperatorAuthWorkerModule {}
