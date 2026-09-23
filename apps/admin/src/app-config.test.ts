import { describe, expect, it } from "vitest";
import { adminApiBaseUrl, adminTitle } from "./app-config";

describe("adminTitle", () => {
  it("includes an explicitly named environment", () => {
    expect(adminTitle("local")).toBe("Taven Admin · local");
  });
});

describe("adminApiBaseUrl", () => {
  it("requires an exact HTTPS API origin outside local development", () => {
    expect(adminApiBaseUrl("local", undefined)).toBe("http://localhost:3001");
    expect(adminApiBaseUrl("staging", "https://api.example.test")).toBe(
      "https://api.example.test",
    );
    expect(() => adminApiBaseUrl("production", undefined)).toThrow();
    expect(() =>
      adminApiBaseUrl("staging", "http://api.example.test"),
    ).toThrow();
    expect(() =>
      adminApiBaseUrl("staging", "https://api.example.test/path"),
    ).toThrow();
  });
});
