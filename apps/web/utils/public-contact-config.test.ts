import { describe, expect, it } from "vitest";
import { resolvePublicContacts } from "./public-contact-config";

describe("resolvePublicContacts", () => {
  it("returns safe mailto contacts for configured addresses", () => {
    expect(
      resolvePublicContacts({
        customerContactEmail: " zakaznici@taven.cz ",
        dataControllerEmail: "legal@taven.cz",
      }),
    ).toEqual({
      customer: {
        email: "zakaznici@taven.cz",
        href: "mailto:zakaznici@taven.cz",
      },
      dataController: {
        email: "legal@taven.cz",
        href: "mailto:legal@taven.cz",
      },
    });
  });

  it.each([
    ["customerContactEmail", ""],
    ["customerContactEmail", "customer@example"],
    ["customerContactEmail", "customer@example.cz\r\nBcc:other@example.cz"],
    ["dataControllerEmail", undefined],
    ["dataControllerEmail", "legal @example.cz"],
  ] as const)("rejects an invalid %s value", (key, value) => {
    const config = {
      customerContactEmail: "zakaznici@taven.cz",
      dataControllerEmail: "legal@taven.cz",
      [key]: value,
    };

    expect(() => resolvePublicContacts(config)).toThrow(
      key === "customerContactEmail"
        ? "NUXT_PUBLIC_CUSTOMER_CONTACT_EMAIL must be a valid email address."
        : "NUXT_PUBLIC_DATA_CONTROLLER_EMAIL must be a valid email address.",
    );
  });
});
