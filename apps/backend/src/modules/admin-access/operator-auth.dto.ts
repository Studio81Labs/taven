import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class DevelopmentOperatorLoginDto {
  @ApiProperty({ format: "email", maxLength: 320 })
  email!: string;

  @ApiProperty({ minLength: 12, maxLength: 1024, format: "password" })
  password!: string;
}

export class OperatorAuthMethodsDto {
  @ApiProperty({ enum: ["EMAIL_PASSWORD", "GITHUB"], isArray: true })
  methods!: ("EMAIL_PASSWORD" | "GITHUB")[];
}

export class OperatorPrincipalDto {
  @ApiProperty({ format: "uuid" })
  operatorId!: string;

  @ApiProperty({ enum: ["ADMIN", "OPERATOR", "VIEWER"] })
  role!: "ADMIN" | "OPERATOR" | "VIEWER";

  @ApiProperty({ type: [String], format: "uuid" })
  nodeIds!: string[];

  @ApiProperty({ enum: ["DEVELOPMENT_PASSWORD", "GITHUB"] })
  authenticationMethod!: "DEVELOPMENT_PASSWORD" | "GITHUB";
}

export class OperatorSessionDto {
  @ApiProperty({ type: OperatorPrincipalDto })
  operator!: OperatorPrincipalDto;

  @ApiProperty()
  csrfToken!: string;
}

export class GithubLoginStartDto {
  @ApiProperty({ format: "uri" })
  authorizationUrl!: string;
}

export class GithubCallbackQueryDto {
  @ApiProperty({ minLength: 20, maxLength: 2048 })
  state!: string;

  @ApiProperty({ minLength: 20, maxLength: 2048 })
  code!: string;

  @ApiPropertyOptional()
  error?: string;
}
