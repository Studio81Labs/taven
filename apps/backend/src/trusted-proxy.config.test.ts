import { describe, expect, it, vi } from "vitest";
import {
  configureTrustedProxies,
  readTrustedProxyCidrs,
} from "./trusted-proxy.config";

describe("trusted proxy configuration", () => {
  it("keeps forwarding headers untrusted by default", () => {
    expect(readTrustedProxyCidrs(undefined)).toEqual([]);
  });

  it("accepts only explicit IP addresses and CIDRs", () => {
    expect(
      readTrustedProxyCidrs("10.0.0.0/8, 2001:db8::/32,127.0.0.1"),
    ).toEqual(["10.0.0.0/8", "2001:db8::/32", "127.0.0.1"]);
    expect(() => readTrustedProxyCidrs("true")).toThrow(
      "TAVEN_TRUSTED_PROXY_CIDRS",
    );
    expect(() => readTrustedProxyCidrs("10.0.0.0/33")).toThrow(
      "TAVEN_TRUSTED_PROXY_CIDRS",
    );
    expect(() => readTrustedProxyCidrs("0.0.0.0/0")).toThrow(
      "TAVEN_TRUSTED_PROXY_CIDRS",
    );
    expect(() => readTrustedProxyCidrs("::/0")).toThrow(
      "TAVEN_TRUSTED_PROXY_CIDRS",
    );
  });

  it("passes the exact allowlist to the HTTP adapter", () => {
    const set = vi.fn();
    const app = {
      getHttpAdapter: () => ({ getInstance: () => ({ set }) }),
    };
    configureTrustedProxies(app as never, {
      TAVEN_TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
    });
    expect(set).toHaveBeenCalledWith("trust proxy", ["10.0.0.0/8"]);
  });
});
