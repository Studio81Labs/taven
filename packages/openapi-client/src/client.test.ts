import { describe, expect, it } from "vitest";
import { createTavenApiClient } from "./client";

describe("createTavenApiClient", () => {
  it("creates the typed transport at a supplied base URL", () => {
    expect(
      createTavenApiClient({ baseUrl: "http://localhost:3001" }),
    ).toBeDefined();
  });
});
