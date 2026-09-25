// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrdersView from "./OrdersView.vue";

const orderId = "00000000-0000-0000-0000-000000000034";
const refundId = "00000000-0000-0000-0000-000000000035";
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("../api", () => ({ apiClient: { GET: get, POST: post } }));
vi.mock("../session", () => ({
  session: {
    phase: "authenticated",
    value: {
      csrfToken: "csrf",
      operator: { role: "ADMIN", nodeIds: ["node-1"] },
    },
  },
  hasPermission: () => true,
}));
vi.mock("vue-router", () => ({
  useRoute: () => ({ query: { order: orderId } }),
  useRouter: () => ({ push: vi.fn() }),
}));

const ok = (data: unknown) => ({
  data,
  response: new Response(null, { status: 200 }),
});

describe("operator order view", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    get.mockImplementation((path: string) => {
      if (path === "/admin/orders") return Promise.resolve(ok({ items: [] }));
      if (path === "/admin/jobs") return Promise.resolve(ok({ items: [] }));
      if (path === `/admin/orders/{orderId}`)
        return Promise.resolve(
          ok({
            id: orderId,
            publicReference: "TV-34",
            status: "CANCELLED",
            blockingCodes: ["COMPENSATION_DUE"],
            financial: {
              blockingCodes: ["REFUND_FAILED"],
              outstandingCompensationMinor: "12000",
              payments: [
                {
                  id: "payment-1",
                  status: "CAPTURED",
                  role: "FULL",
                  requestedAmountMinor: "12000",
                  provider: "comgate",
                },
              ],
              settlements: [],
            },
            fulfilment: {
              phase: { id: "phase-1", status: "CANCELLED" },
              jobs: [],
              shipments: [],
              slots: [],
              replacementRequests: [],
              claims: [],
              priceAdjustments: [],
            },
            fulfilmentNextCursors: {},
            items: [
              {
                id: "item-1",
                ordinal: 1,
                quantity: 2,
                material: "PLA",
                color: "red",
                printConfigRevisionId: "config-1",
                printConfig: {
                  id: "config-1",
                  createdAt: "2026-09-25T10:00:00Z",
                  digest: "digest",
                  layerHeightMicrometers: 200,
                  infillPercent: 15,
                  supportsEnabled: true,
                  brimEnabled: false,
                  quality: "STANDARD",
                },
                geometry: {
                  boundsXMicrometers: "1000",
                  boundsYMicrometers: "2000",
                  boundsZMicrometers: "3000",
                  geometrySha256: "hash",
                  volumeCubicMicrometers: "6000",
                },
                sourceModelFileId: "file-1",
                modelGeometryId: "geometry-1",
                acceptedFindings: [],
                preflightFindings: [],
                primaryReferenceSlice: null,
                tailReferenceSlice: null,
              },
            ],
            legalAcceptances: [],
            shipmentPlans: [],
            slotLineage: [],
            timeline: [],
            actions: [
              {
                action: "RETRY_REFUND",
                targetType: "REFUND",
                targetId: refundId,
                enabled: false,
                blockingCodes: ["REFUND_REPLACEMENT_EXISTS"],
                requiresReason: true,
                requiresConfirmation: true,
              },
            ],
          }),
        );
      if (path === "/admin/orders/{orderId}/refunds")
        return Promise.resolve(
          ok({
            items: [
              {
                id: refundId,
                status: "FAILED",
                amountMinor: "12000",
                currency: "CZK",
                dispatchStatus: "FAILED",
                replacementRefundIds: ["child-1"],
              },
            ],
          }),
        );
      return Promise.resolve(ok({ items: [] }));
    });
  });

  it("keeps captured compensation visible and disables a blocked second refund transfer", async () => {
    const wrapper = mount(OrdersView);
    await flushPromises();
    expect(wrapper.text()).toContain("Nevyřešené překážky");
    expect(wrapper.text()).toContain("120,00 Kč");
    expect(wrapper.text()).toContain(
      "Stav platby sám o sobě nepotvrzuje úhradu zakázky",
    );
    const retry = wrapper
      .findAll("button")
      .find((button) =>
        button.text().includes("Jednou zopakovat selhané vrácení"),
      );
    expect(retry?.attributes("disabled")).toBeDefined();
    expect(post).not.toHaveBeenCalled();
  });

  it("shows accepted print settings and handling validation failures", async () => {
    const wrapper = mount(OrdersView);
    await flushPromises();
    expect(wrapper.text()).toContain("200 µm");
    expect(wrapper.text()).toContain("15 %");
    expect(wrapper.text()).toContain("STANDARD");

    const manual = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Ruční záznam práce/cesty"));
    await manual?.trigger("click");
    const form = wrapper.find("form.operator-form");
    await form.trigger("submit");
    await flushPromises();
    expect(form.get('[role="alert"]').text()).toContain("začátek");
    expect(post).not.toHaveBeenCalled();
  });
});
