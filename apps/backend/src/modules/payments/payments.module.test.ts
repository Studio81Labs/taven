import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { CHECKOUT_PAYMENT_FLOWS_ENV } from "../../launch-approval-gates";
import { PrismaService } from "../../prisma/prisma.service";
import { OBJECT_STORAGE_CONFIG } from "../storage/storage.config";
import { PAYMENT_PROVIDER } from "./payment-provider.port";
import type { PaymentProviderPort } from "./payment-provider.port";
import { PaymentsModule } from "./payments.module";

describe("PaymentsModule", () => {
  it("boots with a disabled provider when checkout is disabled", async () => {
    const previousGate = process.env[CHECKOUT_PAYMENT_FLOWS_ENV];
    const previousProvider = process.env.TAVEN_PAYMENT_PROVIDER;
    process.env[CHECKOUT_PAYMENT_FLOWS_ENV] = "false";
    delete process.env.TAVEN_PAYMENT_PROVIDER;

    try {
      const moduleRef = await Test.createTestingModule({
        imports: [PaymentsModule],
      })
        .overrideProvider(PrismaService)
        .useValue({})
        .overrideProvider(OBJECT_STORAGE_CONFIG)
        .useValue({
          endpoint: "http://127.0.0.1:9010/",
          publicEndpoint: "http://127.0.0.1:9010/",
          region: "us-east-1",
          bucket: "taven",
          accessKeyId: "taven",
          secretAccessKey: "taven-local-only",
          forcePathStyle: true,
          signedUrlTtlSeconds: 900,
          uploadClientHashKey: "module-test-upload-client-hash-key",
        })
        .compile();
      try {
        const provider = moduleRef.get<PaymentProviderPort>(PAYMENT_PROVIDER);
        expect(provider.providerName()).toBe("disabled");
        await expect(provider.capabilities()).resolves.toEqual({
          provider: "disabled",
          methods: [],
        });
      } finally {
        await moduleRef.close();
      }
    } finally {
      restoreEnvironment(CHECKOUT_PAYMENT_FLOWS_ENV, previousGate);
      restoreEnvironment("TAVEN_PAYMENT_PROVIDER", previousProvider);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
