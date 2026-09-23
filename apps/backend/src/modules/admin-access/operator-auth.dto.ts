import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  OPERATOR_PERMISSIONS,
  type OperatorPermission,
} from "./operator-permissions";

export class DevelopmentOperatorLoginDto {
  @ApiProperty({ type: String, format: "email", maxLength: 320 })
  email!: string;

  @ApiProperty({
    type: String,
    minLength: 12,
    maxLength: 1024,
    format: "password",
  })
  password!: string;
}

export class OperatorAuthMethodsDto {
  @ApiProperty({
    type: [String],
    enum: ["EMAIL_PASSWORD", "GITHUB"],
    isArray: true,
  })
  methods!: ("EMAIL_PASSWORD" | "GITHUB")[];
}

export class OperatorSessionOperatorDto {
  @ApiProperty({ type: String, format: "uuid" })
  operatorId!: string;

  @ApiProperty({ enum: ["ADMIN", "OPERATOR", "VIEWER"] })
  role!: "ADMIN" | "OPERATOR" | "VIEWER";

  @ApiProperty({ type: [String], format: "uuid" })
  nodeIds!: string[];

  @ApiProperty({
    type: [String],
    enum: Object.values(OPERATOR_PERMISSIONS),
    isArray: true,
    description:
      "Effective grants after the current role and node scope are applied.",
  })
  permissions!: OperatorPermission[];

  @ApiProperty({ enum: ["DEVELOPMENT_PASSWORD", "GITHUB"] })
  authenticationMethod!: "DEVELOPMENT_PASSWORD" | "GITHUB";
}

export class OperatorSessionDto {
  @ApiProperty({ type: () => OperatorSessionOperatorDto })
  operator!: OperatorSessionOperatorDto;

  @ApiProperty({ type: String })
  csrfToken!: string;
}

export class GithubLoginStartDto {
  @ApiProperty({ type: String, format: "uri" })
  authorizationUrl!: string;
}

export class GithubCallbackQueryDto {
  @ApiProperty({ type: String, minLength: 20, maxLength: 2048 })
  state!: string;

  @ApiProperty({ type: String, minLength: 20, maxLength: 2048 })
  code!: string;

  @ApiPropertyOptional({ type: String })
  error?: string;
}
