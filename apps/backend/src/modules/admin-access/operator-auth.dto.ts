import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

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

export class OperatorSessionDto {
  @ApiProperty({
    type: "object",
    additionalProperties: false,
    required: ["operatorId", "role", "nodeIds", "authenticationMethod"],
    properties: {
      operatorId: { type: "string", format: "uuid" },
      role: { type: "string", enum: ["ADMIN", "OPERATOR", "VIEWER"] },
      nodeIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
      authenticationMethod: {
        type: "string",
        enum: ["DEVELOPMENT_PASSWORD", "GITHUB"],
      },
    },
  })
  operator!: {
    operatorId: string;
    role: "ADMIN" | "OPERATOR" | "VIEWER";
    nodeIds: string[];
    authenticationMethod: "DEVELOPMENT_PASSWORD" | "GITHUB";
  };

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
