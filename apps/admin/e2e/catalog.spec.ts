import { expect, test, type Page } from "@playwright/test";

const profileId = "00000000-0000-0000-0000-000000000011";
const priceId = "00000000-0000-0000-0000-000000000021";
const nextPriceId = "00000000-0000-0000-0000-000000000022";
const notice = {
  id: "activation-1",
  kind: "REFERENCE_PROFILE_ACTIVATED",
  action: "REVIEW_PRICE_LIST",
  schemaVersion: 1,
  activatedAt: "2026-09-23T12:00:00.000Z",
  material: "PLA",
  quality: "STANDARD",
  referenceProfileId: profileId,
};
const secondNotice = {
  ...notice,
  id: "activation-2",
  activatedAt: "2026-09-22T12:00:00.000Z",
};

async function mockSession(page: Page): Promise<void> {
  await page.route("**/admin/auth/session", (route) =>
    route.fulfill({
      json: {
        csrfToken: "csrf-test",
        operator: {
          operatorId: "00000000-0000-0000-0000-000000000001",
          role: "ADMIN",
          nodeIds: ["00000000-0000-0000-0000-000000000002"],
          permissions: [
            "operations:read",
            "catalog:write",
            "metrics:read",
            "financial:exception",
          ],
          authenticationMethod: "DEVELOPMENT_PASSWORD",
        },
      },
    }),
  );
}

type CatalogState = {
  version: number;
  selectedPriceId: string;
  feed: (typeof notice)[];
  activationFails?: boolean;
  postedVersions: number[];
  createdPriceRevisions?: string[];
  postHeaders: { csrf?: string; key?: string }[];
};

async function mockCatalog(page: Page, state: CatalogState): Promise<void> {
  await page.route("**/admin/catalog/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (
      method === "GET" &&
      path.endsWith("/commercial-policy-selections/CZK")
    ) {
      await route.fulfill({
        json: {
          currency: "CZK",
          priceListId: state.selectedPriceId,
          selectionVersion: state.version,
        },
      });
    } else if (method === "GET" && path.endsWith("/price-lists")) {
      await route.fulfill({
        json: {
          items: [
            {
              id: priceId,
              revision: "v1",
              currency: "CZK",
              termsRevision: "terms-1",
              createdAt: "2026-09-22T12:00:00Z",
            },
            {
              id: nextPriceId,
              revision: "v2",
              currency: "CZK",
              termsRevision: "terms-1",
              createdAt: "2026-09-23T12:00:00Z",
            },
          ],
        },
      });
    } else if (method === "POST" && path.endsWith("/price-lists")) {
      const body = request.postDataJSON() as { revision: string };
      state.createdPriceRevisions?.push(body.revision);
      await route.fulfill({ json: { id: "created-price" } });
    } else if (method === "GET" && path.includes("/price-lists/")) {
      await route.fulfill({
        json: {
          id: path.endsWith(nextPriceId) ? nextPriceId : priceId,
          revision: path.endsWith(nextPriceId) ? "v2" : "v1",
          currency: "CZK",
          termsRevision: "terms-1",
          createdAt: "2026-09-23T12:00:00Z",
          parameters: {
            automaticQuote: {
              maximumAutomaticAmountMinor: "200000",
              maximumAutomaticQuantity: "20",
              expressMaximumPlateCount: "2",
              expressAvailableProductionWindowSeconds: "86400",
              freeShippingPrintThresholdMinor: "100000",
              shipmentCategories: [],
            },
            sellerTaxPolicy: {},
          },
        },
      });
    } else if (method === "GET" && path.endsWith("/reference-profiles")) {
      await route.fulfill({
        json: {
          items: [
            {
              id: profileId,
              material: "PLA",
              quality: "STANDARD",
              slicerEngine: "Orca",
              slicerVersion: "1",
              state: "DRAFT",
              digest: "a",
              createdAt: "2026-09-23T12:00:00Z",
            },
          ],
        },
      });
    } else if (
      method === "GET" &&
      path.endsWith("/reference-profile-activation-notices")
    ) {
      await route.fulfill({
        json: url.searchParams.has("cursor")
          ? { items: [notice, secondNotice] }
          : {
              items: state.feed,
              nextCursor: state.feed.length ? "next" : undefined,
            },
      });
    } else if (
      method === "GET" &&
      /\/(machine-profiles|print-config-revisions|machine-capabilities)$/.test(
        path,
      )
    ) {
      await route.fulfill({ json: { items: [] } });
    } else if (
      method === "POST" &&
      path.endsWith(`/reference-profiles/${profileId}/activate`)
    ) {
      state.postHeaders.push({
        csrf: request.headers()["x-csrf-token"],
        key: request.headers()["idempotency-key"],
      });
      await route.fulfill(
        state.activationFails
          ? { status: 409, json: { message: "conflict" } }
          : { json: { id: profileId, notice } },
      );
    } else if (
      method === "POST" &&
      path.endsWith("/activate") &&
      path.includes("/price-lists/")
    ) {
      const body = request.postDataJSON() as {
        expectedSelectionVersion: number;
      };
      state.postedVersions.push(body.expectedSelectionVersion);
      state.postHeaders.push({
        csrf: request.headers()["x-csrf-token"],
        key: request.headers()["idempotency-key"],
      });
      if (body.expectedSelectionVersion !== state.version) {
        await route.fulfill({ status: 409, json: { message: "stale" } });
      } else {
        state.version += 1;
        state.selectedPriceId = path.includes(nextPriceId)
          ? nextPriceId
          : priceId;
        await route.fulfill({
          json: {
            id: "selection",
            currency: "CZK",
            priceListId: state.selectedPriceId,
            selectionVersion: state.version,
          },
        });
      }
    } else {
      await route.fulfill({ status: 404, body: "" });
    }
  });
}

test("shows immediate profile notice, recovers it from the feed, and deduplicates pagination", async ({
  page,
}) => {
  const state: CatalogState = {
    version: 1,
    selectedPriceId: priceId,
    feed: [],
    postedVersions: [],
    postHeaders: [],
  };
  await mockSession(page);
  await mockCatalog(page, state);
  await page.goto("/katalog");
  await expect(page.getByText("Žádná zaznamenaná aktivace.")).toBeVisible();
  await page.getByLabel("Důvod publikace").fill("Ověřeno");
  await page.getByRole("button", { name: "Aktivovat" }).click();
  await expect(
    page.getByRole("button", { name: `Profil ${profileId}` }),
  ).toHaveCount(1);
  expect(state.postHeaders[0].csrf).toBe("csrf-test");
  expect(state.postHeaders[0].key).toBeTruthy();
  state.feed = [notice];
  await page
    .getByRole("button", { name: "Obnovit katalog a upozornění" })
    .click();
  await expect(
    page.getByRole("button", { name: `Profil ${profileId}` }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Další upozornění" }).click();
  await expect(
    page.getByRole("button", { name: `Profil ${profileId}` }),
  ).toHaveCount(2);
});

test("does not show an activation notice when the command fails", async ({
  page,
}) => {
  const state: CatalogState = {
    version: 1,
    selectedPriceId: priceId,
    feed: [],
    activationFails: true,
    postedVersions: [],
    postHeaders: [],
  };
  await mockSession(page);
  await mockCatalog(page, state);
  await page.goto("/katalog");
  await page.getByLabel("Důvod publikace").fill("Ověřeno");
  await page.getByRole("button", { name: "Aktivovat" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Žádná zaznamenaná aktivace.")).toBeVisible();
});

test("creating a price revision leaves the selected policy untouched", async ({
  page,
}) => {
  const state: CatalogState = {
    version: 1,
    selectedPriceId: priceId,
    feed: [],
    postedVersions: [],
    createdPriceRevisions: [],
    postHeaders: [],
  };
  await mockSession(page);
  await mockCatalog(page, state);
  await page.goto("/katalog");
  await page.getByRole("button", { name: "Vytvořit revizi ceníku" }).click();
  await page.getByLabel("Označení revize").fill("v3");
  await page
    .getByRole("button", { name: "Vytvořit revizi", exact: true })
    .click();
  await expect(
    page.getByText("Aktuálně vybraná verze: 1", { exact: false }),
  ).toBeVisible();
  expect(state.createdPriceRevisions).toEqual(["v3"]);
  expect(state.postedVersions).toEqual([]);
});

test("two tabs require a fresh deliberate publication after a stale selection", async ({
  context,
}) => {
  const state: CatalogState = {
    version: 1,
    selectedPriceId: priceId,
    feed: [],
    postedVersions: [],
    postHeaders: [],
  };
  const first = await context.newPage();
  const second = await context.newPage();
  const confirmations: string[] = [];
  for (const page of [first, second]) {
    await mockSession(page);
    await mockCatalog(page, state);
    page.on("dialog", (dialog) => {
      confirmations.push(dialog.message());
      void dialog.accept();
    });
    await page.goto("/katalog");
    await page.getByLabel("Důvod publikace").fill("Schváleno");
  }
  await first
    .getByRole("button", { name: "Potvrdit pro nové vazby" })
    .nth(1)
    .click();
  await expect(
    first.getByText("Aktuálně vybraná verze: 2", { exact: false }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Potvrdit pro nové vazby" })
    .nth(1)
    .click();
  await expect(second.getByRole("alert")).toContainText("jiném okně");
  await expect(
    second.getByText("Aktuálně vybraná verze: 2", { exact: false }),
  ).toBeVisible();
  expect(state.postedVersions).toEqual([1, 1]);
  await second
    .getByRole("button", { name: "Potvrdit pro nové vazby" })
    .nth(0)
    .click();
  await expect(
    second.getByText("Aktuálně vybraná verze: 3", { exact: false }),
  ).toBeVisible();
  expect(state.postedVersions).toEqual([1, 1, 2]);
  expect(
    confirmations.every(
      (message) =>
        message.includes("původní lhůty") &&
        message.includes("Existující vazby a nabídky"),
    ),
  ).toBe(true);
  expect(
    state.postHeaders.every(
      (headers) => headers.csrf === "csrf-test" && !!headers.key,
    ),
  ).toBe(true);
});
