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

  it("encodes URI-reserved characters in the recipient address", () => {
    expect(
      resolvePublicContacts({
        customerContactEmail: "support#eu@example.cz",
        dataControllerEmail: "legal+privacy@example.cz",
      }),
    ).toEqual({
      customer: {
        email: "support#eu@example.cz",
        href: "mailto:support%23eu@example.cz",
      },
      dataController: {
        email: "legal+privacy@example.cz",
        href: "mailto:legal%2Bprivacy@example.cz",
      },
    });
  });

  it.each([
    ["customerContactEmail", ""],
    ["customerContactEmail", "customer@example"],
    ["customerContactEmail", ".customer@example.cz"],
    ["customerContactEmail", "customer.@example.cz"],
    ["customerContactEmail", "customer..eu@example.cz"],
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
