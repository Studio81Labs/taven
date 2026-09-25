// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecoveryPreparationPanel from "./RecoveryPreparationPanel.vue";

const { get, post, permissions } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  permissions: new Set<string>(["operations:write", "financial:exception"]),
}));
vi.mock("../api", () => ({ apiClient: { GET: get, POST: post } }));
vi.mock("../session", () => ({
  session: { phase: "authenticated", value: { csrfToken: "csrf" } },
  hasPermission: (permission: string) => permissions.has(permission),
}));

const orderId = "order-1";
const jobId = "job-1";
const jobId2 = "job-2";
const claimId = "claim-1";
const shipmentId = "lost-1";
const preparationId = "preparation-1";
const later = () => new Date(Date.now() + 45 * 60_000).toISOString();
const sooner = () => new Date(Date.now() + 10 * 60_000).toISOString();
const ok = (data: unknown) => ({
  data,
  response: new Response(null, { status: 200 }),
});
const denied = (status: number) => ({
  error: { message: "denied" },
  response: new Response(null, { status }),
});

function detail(
  kind: "JOB_REPLACEMENT" | "LOST_CLAIM_REPRINT",
  sourceIds: string[],
  status = "CANDIDATES_AVAILABLE",
) {
  return {
    preparationId,
    kind,
    status,
    generation: 1,
    orderId,
    targetId: kind === "JOB_REPLACEMENT" ? jobId : claimId,
    requestedAt: "2026-09-25T08:00:00Z",
    sourceJobIds: sourceIds,
    sources: sourceIds.map((sourceJobId) => ({
      sourceJobId,
      quantity: sourceJobId === jobId ? 1 : 2,
      fulfilmentSlotIds: [`slot-${sourceJobId}`],
      selectableCount: 1,
      pendingCount: 0,
      failedCount: 0,
      blockingCodes: [] as string[],
    })),
    dispatchCount: sourceIds.length,
    pendingCount: 0,
    failedCount: 0,
    blockingCodes: [] as string[],
  };
}
function choice(sourceJobId: string, expiresAt = later(), selectable = true) {
  return {
    sourceJobId,
    candidateResourceEstimateId: `candidate-${sourceJobId}`,
    machineId: "machine-1",
    machineProfileId: "profile-1",
    machineCalibrationId: "calibration-1",
    inventoryId: "inventory-1",
    printConfigRevisionId: "config-1",
    material: "PLA",
    color: "red",
    quantity: sourceJobId === jobId ? 1 : 2,
    partsPerPlate: 1,
    requiredMaterialMilligrams: "1000",
    requiredMachineSeconds: "3600",
    calculatedAt: "2026-09-25T08:00:00Z",
    expiresAt,
    intervals: [{ startsAt: later(), endsAt: later() }],
    selectable,
    blockingCodes: selectable ? [] : ["RESOURCE_CONFLICT"],
  };
}
function mountPanel(
  kind: "JOB_REPLACEMENT" | "LOST_CLAIM_REPRINT",
  overrides: Record<string, unknown> = {},
) {
  return mount(RecoveryPreparationPanel, {
    props: {
      orderId,
      jobs: kind === "JOB_REPLACEMENT" ? [{ id: jobId, status: "FAILED" }] : [],
      claims:
        kind === "LOST_CLAIM_REPRINT"
          ? [
              {
                id: claimId,
                origin: "SHIPMENT_INCIDENT",
                status: "OPEN",
                incidentShipmentId: shipmentId,
                reshipmentAuthorizations: [],
              },
            ]
          : [],
      shipments:
        kind === "LOST_CLAIM_REPRINT"
          ? [
              {
                id: shipmentId,
                status: "LOST",
                reprintClaimId: null,
                replacesShipmentId: null,
              },
            ]
          : [],
      replacementRequests:
        kind === "JOB_REPLACEMENT"
          ? [{ id: "request-1", sourceJobId: jobId, status: "OPEN" }]
          : [],
      actions:
        kind === "JOB_REPLACEMENT"
          ? [
              {
                action: "PREPARE_REPLACEMENT",
                targetId: jobId,
                enabled: false,
                blockingCodes: ["FRESH_RESERVATION_REQUIRED"],
              },
            ]
          : [],
      blocked: false,
      ...overrides,
    } as never,
  });
}
async function openFirst(wrapper: ReturnType<typeof mountPanel>) {
  await wrapper.find(".operator-actions button").trigger("click");
  await flushPromises();
}
async function showChoices(
  wrapper: ReturnType<typeof mountPanel>,
  index: number,
) {
  await wrapper
    .findAll("button")
    .filter((button) => button.text() === "Načíst aktuální volby")
    [index]!.trigger("click");
  await flushPromises();
}

describe("recovery preparation panel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    permissions.clear();
    permissions.add("operations:write");
    permissions.add("financial:exception");
  });

  it("prepares a failed job and commits only a fresh returned candidate with a separate reason", async () => {
    let current: ReturnType<typeof detail> | null = null;
    get.mockImplementation(
      (
        path: string,
        args: { params?: { query?: { sourceJobId?: string } } },
      ) => {
        if (path.endsWith("/candidates"))
          return Promise.resolve(
            ok({ items: [choice(args.params!.query!.sourceJobId!)] }),
          );
        if (path.endsWith("/{preparationId}"))
          return Promise.resolve(ok(current));
        return Promise.resolve(ok({ items: current ? [current] : [] }));
      },
    );
    post.mockImplementation((path: string) => {
      if (path.endsWith("/replacement-preparations")) {
        current = detail("JOB_REPLACEMENT", [jobId]);
        return Promise.resolve(ok({ preparationId, generation: 1 }));
      }
      return Promise.resolve(ok({ status: "CREATED" }));
    });
    const wrapper = mountPanel("JOB_REPLACEMENT");
    await openFirst(wrapper);
    await wrapper.get("textarea").setValue("Selhal tisk");
    await wrapper.findAll("form")[0]!.trigger("submit");
    await flushPromises();
    expect(post.mock.calls[0]![1].body).toEqual({
      expectedReplacementRequestId: "request-1",
      reason: "Selhal tisk",
    });
    await showChoices(wrapper, 0);
    expect(wrapper.text()).toContain("není rezervováno");
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(1);
    await wrapper.get('input[type="radio"]').setValue();
    await wrapper.findAll("textarea")[1]!.setValue("Schválená náhrada");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.findAll("form")[1]!.trigger("submit");
    await flushPromises();
    expect(post.mock.calls[1]![0]).toContain("/jobs/{jobId}/replacement");
    expect(post.mock.calls[1]![1].body).toEqual({
      candidateResourceEstimateId: `candidate-${jobId}`,
      reason: "Schválená náhrada",
    });
    expect(
      post.mock.calls[1]![1].params.header["Idempotency-Key"],
    ).toBeTruthy();
    expect(wrapper.emitted("changed")).toHaveLength(1);
  });

  it("requires every source of a LOST parcel and rejects stale choices", async () => {
    const current = detail("LOST_CLAIM_REPRINT", [jobId, jobId2]);
    get.mockImplementation(
      (
        path: string,
        args: { params?: { query?: { sourceJobId?: string } } },
      ) => {
        if (path.endsWith("/candidates")) {
          const source = args.params!.query!.sourceJobId!;
          return Promise.resolve(
            ok({
              items: [choice(source, source === jobId2 ? sooner() : later())],
            }),
          );
        }
        if (path.endsWith("/{preparationId}"))
          return Promise.resolve(ok(current));
        return Promise.resolve(ok({ items: [current] }));
      },
    );
    post.mockResolvedValue(ok({ status: "CREATED" }));
    const wrapper = mountPanel("LOST_CLAIM_REPRINT");
    await openFirst(wrapper);
    await showChoices(wrapper, 0);
    await wrapper.get('input[type="radio"]').setValue();
    await wrapper.findAll("textarea")[1]!.setValue("Opakovaná zásilka");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    const submit = wrapper.findAll("button[type=submit]")[1]!;
    expect(submit.attributes("disabled")).toBeDefined();
    await showChoices(wrapper, 1);
    expect(
      wrapper.findAll('input[type="radio"]')[1]!.attributes("disabled"),
    ).toBeDefined();
    expect(submit.attributes("disabled")).toBeDefined();
    expect(post).not.toHaveBeenCalled();
  });

  it("submits one candidate per source for a repeated-LOST predecessor", async () => {
    const current = detail("LOST_CLAIM_REPRINT", [jobId, jobId2]);
    get.mockImplementation(
      (
        path: string,
        args: { params?: { query?: { sourceJobId?: string } } },
      ) => {
        if (path.endsWith("/candidates"))
          return Promise.resolve(
            ok({ items: [choice(args.params!.query!.sourceJobId!)] }),
          );
        if (path.endsWith("/{preparationId}"))
          return Promise.resolve(ok(current));
        return Promise.resolve(ok({ items: [current] }));
      },
    );
    post.mockResolvedValue(ok({ status: "CREATED" }));
    const wrapper = mountPanel("LOST_CLAIM_REPRINT", {
      shipments: [
        { id: "original", status: "LOST", replacesShipmentId: null },
        {
          id: shipmentId,
          status: "LOST",
          replacesShipmentId: "original",
          reprintClaimId: claimId,
        },
      ],
    });
    await openFirst(wrapper);
    await showChoices(wrapper, 0);
    await wrapper.findAll('input[type="radio"]')[0]!.setValue();
    await showChoices(wrapper, 1);
    await wrapper.findAll('input[type="radio"]')[1]!.setValue();
    await wrapper.findAll("textarea")[1]!.setValue("Opakovat celý balík");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.findAll("form")[1]!.trigger("submit");
    await flushPromises();
    expect(post.mock.calls[0]![0]).toContain("/claims/{claimId}/reprint");
    expect(post.mock.calls[0]![1].body).toEqual({
      reason: "Opakovat celý balík",
      replacements: [
        {
          sourceJobId: jobId,
          candidateResourceEstimateId: `candidate-${jobId}`,
        },
        {
          sourceJobId: jobId2,
          candidateResourceEstimateId: `candidate-${jobId2}`,
        },
      ],
    });
  });

  it("shows worker failure and expiry without offering a final command", async () => {
    const failed = detail("JOB_REPLACEMENT", [jobId], "BLOCKED");
    failed.failedCount = 1;
    failed.blockingCodes = ["CANDIDATE_DISPATCH_FAILED"];
    failed.sources[0]!.failedCount = 1;
    get.mockImplementation((path: string) =>
      Promise.resolve(
        ok(path.endsWith("/{preparationId}") ? failed : { items: [failed] }),
      ),
    );
    const wrapper = mountPanel("JOB_REPLACEMENT");
    await openFirst(wrapper);
    expect(wrapper.text()).toContain("CANDIDATE_DISPATCH_FAILED");
    expect(wrapper.findAll("form")).toHaveLength(1);
    failed.status = "EXPIRED";
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Obnovit průběh a způsobilost")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("EXPIRED");
    expect(post).not.toHaveBeenCalled();
  });

  it("retains the same preparation body and key after an ambiguous 502", async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(
        ok(
          path.endsWith("/{preparationId}")
            ? detail("JOB_REPLACEMENT", [jobId])
            : { items: [] },
        ),
      ),
    );
    post.mockResolvedValueOnce(denied(502));
    post.mockResolvedValueOnce(ok({ preparationId, generation: 1 }));
    const wrapper = mountPanel("JOB_REPLACEMENT");
    await openFirst(wrapper);
    await wrapper.get("textarea").setValue("První důvod");
    await wrapper.findAll("form")[0]!.trigger("submit");
    await flushPromises();
    await wrapper.get("textarea").setValue("Změněný důvod");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Opakovat stejný požadavek")!
      .trigger("click");
    await flushPromises();
    expect(post.mock.calls.map(([, args]) => args.body)).toEqual([
      { expectedReplacementRequestId: "request-1", reason: "První důvod" },
      { expectedReplacementRequestId: "request-1", reason: "První důvod" },
    ]);
    expect(post.mock.calls[0]![1].params.header["Idempotency-Key"]).toBe(
      post.mock.calls[1]![1].params.header["Idempotency-Key"],
    );
  });

  it("does not offer a claim without permission and refreshes on node denial", async () => {
    permissions.delete("financial:exception");
    const hidden = mountPanel("LOST_CLAIM_REPRINT");
    expect(hidden.text()).not.toContain(
      "Připravit opakovanou zásilku pro reklamaci",
    );
    permissions.add("financial:exception");
    get.mockResolvedValue(ok({ items: [] }));
    post.mockResolvedValue(denied(403));
    const wrapper = mountPanel("LOST_CLAIM_REPRINT");
    await openFirst(wrapper);
    await wrapper.get("textarea").setValue("Ztracená zásilka");
    await wrapper.findAll("form")[0]!.trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("K této akci nemáte oprávnění");
    expect(get).toHaveBeenCalled();
  });
});
