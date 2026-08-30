import type { INestApplication } from "@nestjs/common";
import { isIP } from "node:net";

export function configureTrustedProxies(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trusted = readTrustedProxyCidrs(env.TAVEN_TRUSTED_PROXY_CIDRS);
  if (trusted.length === 0) return;
  const server = app.getHttpAdapter().getInstance() as {
    set(name: string, value: readonly string[]): void;
  };
  server.set("trust proxy", trusted);
}

export function readTrustedProxyCidrs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => {
    const cidr = entry.trim();
    const [address, prefix, extra] = cidr.split("/");
    const family = isIP(address ?? "");
    const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d{1,3}$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > maximumPrefix))
    ) {
      throw new Error(
        "TAVEN_TRUSTED_PROXY_CIDRS must contain only IPv4/IPv6 addresses or CIDRs",
      );
    }
    return cidr;
  });
}
