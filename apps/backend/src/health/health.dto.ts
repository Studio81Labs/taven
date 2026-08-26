import { ApiProperty } from "@nestjs/swagger";

export class HealthResponseDto {
  @ApiProperty({ type: String, enum: ["ok"], example: "ok" })
  status!: "ok";

  @ApiProperty({
    type: String,
    enum: ["taven-backend"],
    example: "taven-backend",
  })
  service!: "taven-backend";
}
