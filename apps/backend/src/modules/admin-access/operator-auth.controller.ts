import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { readAdminAccessConfig } from "./admin-access.config";
import { OperatorAccessGuard } from "./operator-access.guard";
import { OPERATOR_CSRF_HEADER } from "./operator-auth.openapi";
import {
  DevelopmentOperatorLoginDto,
  GithubCallbackQueryDto,
  GithubLoginStartDto,
  OperatorAuthMethodsDto,
  OperatorSessionDto,
} from "./operator-auth.dto";
import {
  loginAttemptCookieName,
  OperatorAuthService,
  sessionCookieName,
  type AuthSessionView,
} from "./operator-auth.service";
import type { AdminRequest } from "./operator-context";

type ResponseLike = {
  cookie(
    name: string,
    value: string,
    options: Record<string, unknown>,
  ): unknown;
  clearCookie(name: string, options: Record<string, unknown>): unknown;
  redirect(status: number, url: string): unknown;
  setHeader(name: string, value: string): unknown;
};

@ApiTags("operator authentication")
@Controller("admin/auth")
export class OperatorAuthController {
  private readonly config = readAdminAccessConfig();

  constructor(private readonly auth: OperatorAuthService) {}

  @Get("methods")
  @ApiOperation({
    summary:
      "List the operator authentication methods enabled in this environment",
  })
  @ApiOkResponse({ type: OperatorAuthMethodsDto })
  methods(): OperatorAuthMethodsDto {
    return { methods: [...this.auth.methods()] };
  }

  @Post("login")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Create a development-only operator session from a provisioned password",
  })
  @ApiBody({ type: DevelopmentOperatorLoginDto })
  @ApiOkResponse({ type: OperatorSessionDto })
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  @ApiTooManyRequestsResponse()
  async login(
    @Body() body: DevelopmentOperatorLoginDto,
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: ResponseLike,
  ): Promise<OperatorSessionDto> {
    const result = await this.auth.loginWithDevelopmentPassword(body, request);
    noStore(response);
    this.setSessionCookie(response, result.sessionToken);
    return sessionDto(result);
  }

  @Post("github/start")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Start the production or staging GitHub operator authorization flow",
  })
  @ApiOkResponse({ type: GithubLoginStartDto })
  @ApiForbiddenResponse()
  @ApiTooManyRequestsResponse()
  async startGithub(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: ResponseLike,
  ): Promise<GithubLoginStartDto> {
    const result = await this.auth.startGithubLogin(request);
    noStore(response);
    response.cookie(
      loginAttemptCookieName(this.config.environment),
      result.browserBinding,
      {
        ...cookieOptions(this.config.environment),
        maxAge: 10 * 60 * 1_000,
      },
    );
    return { authorizationUrl: result.authorizationUrl };
  }

  @Get("github/callback")
  @ApiOperation({
    summary:
      "Complete the browser-bound GitHub operator authorization callback",
  })
  @ApiQuery({ name: "state", required: true, minLength: 20, maxLength: 2048 })
  @ApiQuery({ name: "code", required: true, minLength: 20, maxLength: 2048 })
  @ApiQuery({ name: "error", required: false })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  async completeGithub(
    @Query() query: GithubCallbackQueryDto,
    @Req() request: AdminRequest,
    @Res() response: ResponseLike,
  ): Promise<void> {
    noStore(response);
    response.setHeader("Referrer-Policy", "no-referrer");
    if (query.error) {
      response.redirect(302, this.callbackFailureUrl());
      return;
    }
    const binding = cookieValue(
      request,
      loginAttemptCookieName(this.config.environment),
    );
    const result = await this.auth.completeGithubLogin({
      state: query.state,
      code: query.code,
      browserBinding: binding,
    });
    this.setSessionCookie(response, result.sessionToken);
    response.clearCookie(
      loginAttemptCookieName(this.config.environment),
      cookieOptions(this.config.environment),
    );
    response.redirect(302, result.completionUrl);
  }

  @Get("session")
  @UseGuards(OperatorAccessGuard)
  @ApiSecurity("operatorSession")
  @ApiOperation({
    summary: "Read the current authenticated operator session and CSRF token",
  })
  @ApiOkResponse({ type: OperatorSessionDto })
  @ApiUnauthorizedResponse()
  async session(@Req() request: AdminRequest): Promise<OperatorSessionDto> {
    return sessionDto(await this.auth.currentSession(request));
  }

  @Delete("session")
  @HttpCode(204)
  @UseGuards(OperatorAccessGuard)
  @ApiSecurity("operatorSession")
  @ApiOperation({ summary: "Revoke the current operator session" })
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  @ApiNoContentResponse()
  @ApiHeader({ ...OPERATOR_CSRF_HEADER, required: true })
  async logout(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: ResponseLike,
  ): Promise<void> {
    await this.auth.logout(request);
    response.clearCookie(
      sessionCookieName(this.config.environment),
      cookieOptions(this.config.environment),
    );
  }

  private setSessionCookie(response: ResponseLike, token: string): void {
    response.cookie(sessionCookieName(this.config.environment), token, {
      ...cookieOptions(this.config.environment),
      maxAge: 8 * 60 * 60 * 1_000,
    });
  }

  private callbackFailureUrl(): string {
    const completion = this.config.github?.completionUrl;
    if (!completion) return "/";
    const url = new URL(completion);
    url.searchParams.set("auth", "failed");
    return url.toString();
  }
}

function noStore(response: ResponseLike): void {
  response.setHeader("Cache-Control", "no-store");
}

function sessionDto(value: AuthSessionView): OperatorSessionDto {
  return {
    operator: {
      operatorId: value.operator.operatorId,
      role: value.operator.role,
      nodeIds: [...value.operator.nodeIds],
      authenticationMethod: value.operator.authenticationMethod,
    },
    csrfToken: value.csrfToken,
  };
}

function cookieOptions(
  environment: "development" | "staging" | "production",
): Record<string, unknown> {
  return {
    httpOnly: true,
    secure: environment !== "development",
    sameSite: "lax",
    path: "/",
  };
}

function cookieValue(request: AdminRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === name) return value;
  }
  return undefined;
}
