import { expect, test, type Page } from "@playwright/test";

const profileId = "00000000-0000-0000-0000-000000000011";
const secondProfileId = "00000000-0000-0000-0000-000000000012";
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
  referenceState?: "DRAFT" | "ACTIVE" | "RETIRED";
  activationFails?: boolean;
  postedVersions: number[];
  createdPriceRevisions?: string[];
  includeSecondReference?: boolean;
  refreshFailsAfterActivation?: boolean;
  failNextPolicyRead?: boolean;
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
      if (state.failNextPolicyRead) {
        state.failNextPolicyRead = false;
        await route.fulfill({
          status: 503,
          json: { message: "policy read failed" },
        });
        return;
      }
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
              state: state.referenceState ?? "DRAFT",
              digest: "a",
              createdAt: "2026-09-23T12:00:00Z",
            },
            ...(state.includeSecondReference
              ? [
                  {
                    id: secondProfileId,
                    material: "PETG",
                    quality: "FINE",
                    slicerEngine: "Orca",
                    slicerVersion: "2",
                    state: "DRAFT",
                    digest: "b",
                    createdAt: "2026-09-23T12:00:00Z",
                  },
                ]
              : []),
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
      await route.fulfill(
        state.refreshFailsAfterActivation && state.postedVersions.length
          ? { status: 503, json: { message: "read outage" } }
          : { json: { items: [] } },
      );
    } else if (
      method === "POST" &&
      path.endsWith(`/reference-profiles/${profileId}/activate`)
    ) {
      state.postHeaders.push({
        csrf: request.headers()["x-csrf-token"],
        key: request.headers()["idempotency-key"],
      });
      if (!state.activationFails) state.referenceState = "ACTIVE";
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
  await expect(page.getByRole("button", { name: "Aktivovat" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Vyřadit" })).toBeDisabled();
  await page.getByRole("button", { name: "Aktivovat" }).click();
  await expect(page.getByRole("button", { name: "Aktivovat" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Vyřadit" })).toBeEnabled();
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
  let releasePriceWrite: (() => void) | undefined;
  await page.route("**/admin/catalog/price-lists", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    state.createdPriceRevisions?.push(
      (route.request().postDataJSON() as { revision: string }).revision,
    );
    await new Promise<void>((resolve) => {
      releasePriceWrite = resolve;
    });
    await route.fulfill({ json: { id: "created-price" } });
  });
  await page.goto("/katalog");
  await page.getByRole("button", { name: "Vytvořit revizi ceníku" }).click();
  await page.getByLabel("Označení revize").fill("v3");
  await page
    .getByRole("button", { name: "Vytvořit revizi", exact: true })
    .click();
  await expect.poll(() => Boolean(releasePriceWrite)).toBe(true);
  for (const label of [
    "Vytvořit revizi ceníku",
    "Nová revize profilu",
    "Nová revize profilu stroje",
    "Nová revize konfigurace",
    "Nová schopnost stroje",
  ])
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toBeDisabled();
  releasePriceWrite?.();
  await expect(
    page.getByText("Aktuálně vybraná verze: 1", { exact: false }),
  ).toBeVisible();
  expect(state.createdPriceRevisions).toEqual(["v3"]);
  expect(state.postedVersions).toEqual([]);
});

test("a late catalog detail response cannot replace the latest selected revision", async ({
  page,
}) => {
  const state: CatalogState = {
    version: 1,
    selectedPriceId: priceId,
    feed: [],
    postedVersions: [],
    postHeaders: [],
    includeSecondReference: true,
  };
  await mockSession(page);
  await mockCatalog(page, state);
  let releaseFirst: (() => void) | undefined;
  let firstFinished: (() => void) | undefined;
  const firstDone = new Promise<void>((resolve) => {
    firstFinished = resolve;
  });
  await page.route(
    /\/admin\/catalog\/reference-profiles\/[0-9a-f-]+$/,
    async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
      if (id === profileId)
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      await route.fulfill({
        json: {
          id,
          material: id === profileId ? "PLA" : "PETG",
          quality: id === profileId ? "STANDARD" : "FINE",
          slicerEngine: "Orca",
          slicerVersion: "1",
          state: "DRAFT",
          digest: "digest",
          settings: { selected: id },
          createdAt: "2026-09-23T12:00:00Z",
        },
      });
      if (id === profileId) firstFinished?.();
    },
  );
  await page.goto("/katalog");
  const references = page
    .getByRole("heading", { name: "Referenční profily" })
    .locator("..");
  const clone = references.getByRole("button", {
    name: "Nová revize profilu",
    exact: true,
  });
  await references.getByRole("button", { name: "Detail" }).first().click();
  await expect.poll(() => Boolean(releaseFirst)).toBe(true);
  await expect(clone).toBeDisabled();
  await references.getByRole("button", { name: "Detail" }).nth(1).click();
  await expect(references.locator(".operator-detail")).toContainText(
    secondProfileId,
  );
  await expect(clone).toBeEnabled();
  releaseFirst?.();
  await firstDone;
  await expect(references.locator(".operator-detail")).toContainText(
    secondProfileId,
  );
  await clone.click();
  await expect(
    page.getByRole("textbox", { name: "Nastavení JSON" }),
  ).toHaveValue(new RegExp(secondProfileId));
});

test("catalog writes wait for a manual refresh to finish", async ({ page }) => {
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
  await expect(
    page.getByText("Aktuálně vybraná verze: 1", { exact: false }),
  ).toBeVisible();
  let releaseRead: (() => void) | undefined;
  await page.route(
    "**/admin/catalog/commercial-policy-selections/CZK",
    async (route) => {
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      await route.fulfill({
        json: { currency: "CZK", priceListId: priceId, selectionVersion: 1 },
      });
    },
  );
  await page
    .getByRole("textbox", { name: "Důvod publikace" })
    .fill("nový ceník");
  await page
    .getByRole("button", { name: "Obnovit katalog a upozornění" })
    .click();
  await expect.poll(() => Boolean(releaseRead)).toBe(true);
  await expect(
    page.getByRole("button", { name: "Potvrdit pro nové vazby" }).nth(1),
  ).toBeDisabled();
  const otherPriceDetail = page
    .getByRole("heading", { name: "Ceníky a obchodní pravidla" })
    .locator("..")
    .getByRole("button", { name: "Detail" })
    .nth(1);
  await expect(otherPriceDetail).toBeDisabled();
  releaseRead?.();
  await expect(
    page.getByRole("button", { name: "Potvrdit pro nové vazby" }).nth(1),
  ).toBeEnabled();
  await expect(otherPriceDetail).toBeEnabled();
  expect(state.postedVersions).toEqual([]);
});

test("the price editor waits for the requested detail before cloning", async ({
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
  const clone = page.getByRole("button", { name: "Vytvořit revizi ceníku" });
  await expect(clone).toBeEnabled();
  let releaseDetail: (() => void) | undefined;
  await page.route(
    `**/admin/catalog/price-lists/${nextPriceId}`,
    async (route) => {
      await new Promise<void>((resolve) => {
        releaseDetail = resolve;
      });
      await route.fulfill({
        json: {
          id: nextPriceId,
          revision: "v2",
          currency: "CZK",
          termsRevision: "terms-2",
          createdAt: "2026-09-23T12:00:00Z",
          parameters: {
            automaticQuote: {
              maximumAutomaticAmountMinor: "300000",
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
    },
  );
  const prices = page
    .getByRole("heading", { name: "Ceníky a obchodní pravidla" })
    .locator("..");
  await prices.getByRole("button", { name: "Detail" }).nth(1).click();
  await expect.poll(() => Boolean(releaseDetail)).toBe(true);
  await expect(clone).toBeDisabled();
  releaseDetail?.();
  await expect(clone).toBeEnabled();
  await clone.click();
  await expect(
    page.getByRole("textbox", { name: "Revize podmínek" }),
  ).toHaveValue("terms-2");
  await expect(
    page.getByRole("textbox", { name: "Úplné cenové parametry JSON" }),
  ).toHaveValue(/300000/);
});

test("a confirmed price activation cannot be repeated after a read outage", async ({
  page,
}) => {
  const state: CatalogState = {
    version: 1,
    selectedPriceId: priceId,
    feed: [],
    postedVersions: [],
    postHeaders: [],
    refreshFailsAfterActivation: true,
  };
  await mockSession(page);
  await mockCatalog(page, state);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/katalog");
  await page
    .getByRole("textbox", { name: "Důvod publikace" })
    .fill("nová revize");
  const activate = page
    .getByRole("button", { name: "Potvrdit pro nové vazby" })
    .nth(1);
  await activate.click();
  await expect(page.locator(".form-success")).toContainText("Ceník je vybrán");
  await expect(page.getByRole("alert")).toContainText(
    "Publikace byla potvrzena, ale obnovení katalogu selhalo",
  );
  await expect(activate).toBeDisabled();
  expect(state.postedVersions).toEqual([1]);
});

test("a stale price conflict blocks publication until policy refresh succeeds", async ({
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
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/katalog");
  await page.getByLabel("Důvod publikace").fill("Nová revize");
  state.version = 2;
  state.selectedPriceId = nextPriceId;
  state.failNextPolicyRead = true;
  const activate = page
    .getByRole("button", { name: "Potvrdit pro nové vazby" })
    .nth(1);
  await activate.click();
  await expect(page.getByRole("alert")).toContainText(
    "Obnovení aktuálního výběru selhalo",
  );
  await expect(activate).toBeDisabled();
  expect(state.postedVersions).toEqual([1]);
  await page
    .getByRole("button", { name: "Obnovit katalog a upozornění" })
    .click();
  await expect(
    page.getByText("Aktuálně vybraná verze: 2", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Potvrdit pro nové vazby" }).nth(0),
  ).toBeEnabled();
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
