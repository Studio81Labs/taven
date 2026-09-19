import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  loadBaselinePackage,
  normalizeEffectiveAt,
  parseArguments,
  parseTargetConfig,
  parseTrustedTargetAllowlist,
} from "./import-development-legal-baseline";

describe("development legal baseline importer", () => {
  it("accepts only an explicitly enabled non-production target", () => {
    expect(
      parseTargetConfig({
        targetId: "local-dev",
        environment: "development",
        baseUrl: "http://localhost:3001",
        origin: "http://localhost:3002",
        allowBaselineImport: true,
      }),
    ).toEqual({
      targetId: "local-dev",
      environment: "development",
      baseUrl: "http://localhost:3001",
      origin: "http://localhost:3002",
      allowBaselineImport: true,
    });

    expect(() =>
      parseTargetConfig({
        targetId: "production",
        environment: "production",
        baseUrl: "https://taven.cz",
        origin: "https://taven.cz",
        allowBaselineImport: true,
      }),
    ).toThrow(/development or staging/);
    expect(() =>
      parseTargetConfig({
        targetId: "staging",
        environment: "staging",
        baseUrl: "https://staging.taven.cz",
        origin: "https://staging.taven.cz",
        allowBaselineImport: false,
      }),
    ).toThrow(/explicitly allow/);
    expect(() =>
      parseTargetConfig({
        targetId: "staging",
        environment: "staging",
        baseUrl: "https://staging.taven.cz?secret=bad",
        origin: "https://staging.taven.cz",
        allowBaselineImport: true,
      }),
    ).toThrow(/credentials or a fragment/);
  });

  it("rejects valueless and unknown command-line options", () => {
    expect(() => parseArguments(["--effective-at"])).toThrow(
      /requires a value/,
    );
    expect(() => parseArguments(["--unexpected", "value"])).toThrow(
      /Unknown argument/,
    );
  });

  it("serializes package values deterministically", () => {
    expect(canonicalJson({ b: 2, a: [true, null, "x"] })).toBe(
      '{"a":[true,null,"x"],"b":2}',
    );
  });

  it("rejects impossible calendar dates before normalization", () => {
    expect(() => normalizeEffectiveAt("2027-02-30T00:00:00Z")).toThrow(
      /real calendar date/,
    );
    expect(normalizeEffectiveAt("2027-02-28T00:00:00+02:00")).toBe(
      "2027-02-27T22:00:00.000Z",
    );
  });

  it("requires an exact match in the trusted target allowlist", () => {
    expect(
      parseTrustedTargetAllowlist({
        targets: [
          {
            targetId: "local-dev",
            environment: "development",
            baseUrl: "http://localhost:3001",
            origin: "http://localhost:3002",
          },
        ],
      }),
    ).toEqual([
      {
        targetId: "local-dev",
        environment: "development",
        baseUrl: "http://localhost:3001",
        origin: "http://localhost:3002",
      },
    ]);
  });

  it("loads the six pinned v0.1 documents from the approved source commit", async () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    const baseline = await loadBaselinePackage(repoRoot);
    expect(baseline.documents).toHaveLength(6);
    expect(baseline.documents.map((document) => document.revisionCode)).toEqual(
      [
        "terms-of-service-cs-v0.1",
        "complaints-policy-cs-v0.1",
        "privacy-policy-cs-v0.1",
        "prohibited-content-policy-cs-v0.1",
        "retention-policy-cs-v0.1",
        "photo-consent-and-confidentiality-cs-v0.1",
      ],
    );
    expect(baseline.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline.packageHash).toBe(
      "f77dc21040b14699b112f31093171e5ccf4ce3d018ee4cb923227b261e0a184d",
    );
    expect(
      baseline.documents.every((document) => document.sections.length > 0),
    ).toBe(true);
  });
});
