import { describe, expect, it, vi } from "vitest";
import { CommandIntent } from "./command-intent";
import { CursorPager } from "./cursor-pager";
import { formatCzkMinor, formatGrams, formatPragueInstant } from "./format";
import { requestFeedback } from "./request-feedback";
import {
  CommandJournal,
  isUncertainCommandOutcome,
  isoFromZonedInput,
  OperatorRequestError,
  requireData,
} from "./operator-requests";

describe("operator request helpers", () => {
  it("retains ambiguous server failures but refreshes on definite conflicts", () => {
    for (const status of [500, 502, 503, 504])
      expect(
        isUncertainCommandOutcome(
          new OperatorRequestError(status, true, "server"),
        ),
      ).toBe(true);
    expect(
      isUncertainCommandOutcome(
        new OperatorRequestError(409, true, "conflict"),
      ),
    ).toBe(false);
    expect(isUncertainCommandOutcome(new Error("lost response"))).toBe(true);
  });
  it("rejects calendar-invalid UTC evidence instead of normalizing it", () => {
    expect(isoFromZonedInput("2024-02-29T10:00:00Z")).toBe(
      "2024-02-29T10:00:00.000Z",
    );
    expect(() => isoFromZonedInput("2026-02-30T10:00:00Z")).toThrow(
      "platné datum",
    );
    expect(() => isoFromZonedInput("2026-02-28T24:00:00Z")).toThrow(
      "platné datum",
    );
  });
  it("formats exact decimal strings without converting large amounts to Number", () => {
    expect(formatCzkMinor("900719925474099300")).toContain(
      "9 007 199 254 740 993,00 Kč",
    );
    expect(formatCzkMinor("-1")).toBe("−0,01 Kč");
    expect(formatGrams("1234")).toContain("1 234 g");
    expect(formatPragueInstant("2026-09-23T12:00:00Z")).toContain("14:00");
    expect(formatPragueInstant("2026-09-23T12:00:00")).toBe("Neplatný čas");
  });

  it("retains the body and key when an outcome is unknown", async () => {
    const body = { amountMinor: "100", nested: { reason: "A" } };
    const intent = new CommandIntent(body, "same-key");
    body.nested.reason = "B";
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce("done");
    await expect(intent.submit(send)).rejects.toThrow("lost response");
    await expect(intent.submit(send)).resolves.toBe("done");
    expect(send).toHaveBeenNthCalledWith(
      1,
      { amountMinor: "100", nested: { reason: "A" } },
      "same-key",
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      { amountMinor: "100", nested: { reason: "A" } },
      "same-key",
    );
  });

  it("reuses the command key for an unchanged retry and changes it with the body", async () => {
    const journal = new CommandJournal();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue("done");
    await expect(journal.submit("receive", { sku: "A" }, send)).rejects.toThrow(
      "lost response",
    );
    await expect(journal.submit("receive", { sku: "A" }, send)).resolves.toBe(
      "done",
    );
    expect(send.mock.calls[0]?.[1]).toBe(send.mock.calls[1]?.[1]);
    await journal.submit("receive", { sku: "B" }, send);
    expect(send.mock.calls[2]?.[1]).not.toBe(send.mock.calls[1]?.[1]);
  });

  it("retains an uncertain command across a different failed command", async () => {
    const journal = new CommandJournal();
    const adjustment = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue("confirmed");
    await expect(
      journal.submit("adjust", { delta: "100" }, adjustment),
    ).rejects.toThrow("lost response");
    await expect(
      journal.submit("mount", { state: "MOUNTED" }, async () => {
        throw new Error("rejected mount");
      }),
    ).rejects.toThrow("rejected mount");
    await expect(
      journal.submit("adjust", { delta: "100" }, adjustment),
    ).resolves.toBe("confirmed");
    expect(adjustment.mock.calls[0]?.[1]).toBe(adjustment.mock.calls[1]?.[1]);
    await journal.submit("adjust", { delta: "100" }, adjustment);
    expect(adjustment.mock.calls[2]?.[1]).not.toBe(
      adjustment.mock.calls[1]?.[1],
    );
  });

  it("discards a late page after the filters change", async () => {
    let resolveFirst:
      | ((value: { items: number[]; nextCursor: string | null }) => void)
      | undefined;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [2], nextCursor: null });
    const pager = new CursorPager<number>(load);
    const first = pager.reset("old");
    await pager.reset("new");
    resolveFirst?.({ items: [1], nextCursor: "old-next" });
    await first;
    expect(pager.items).toEqual([2]);
    expect(pager.nextCursor).toBeNull();
  });

  it("loads one page for concurrent next-page requests", async () => {
    let finish:
      | ((value: { items: number[]; nextCursor: string | null }) => void)
      | undefined;
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [1], nextCursor: "next" })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const pager = new CursorPager<number>(load);
    await pager.reset("same");
    const first = pager.more();
    const second = pager.more();
    expect(load).toHaveBeenCalledTimes(2);
    finish?.({ items: [2], nextCursor: null });
    await Promise.all([first, second]);
    expect(pager.items).toEqual([1, 2]);
  });

  it("ignores an aborted request when filters change", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(
        (_cursor: string | null, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      )
      .mockResolvedValueOnce({ items: [3], nextCursor: null });
    const pager = new CursorPager<number>(load);
    const obsolete = pager.reset("old");
    await pager.reset("new");
    await expect(obsolete).resolves.toBeUndefined();
    expect(pager.items).toEqual([3]);
  });

  it("separates conflicts from rate limits and service outages", () => {
    expect(requestFeedback(409).refreshRequired).toBe(true);
    expect(requestFeedback(429, "12").retryAfterSeconds).toBe(12);
    expect(requestFeedback(503).refreshRequired).toBe(false);
  });

  it("reports exact reservation conflicts from a rejected availability publication", () => {
    const id = "00000000-0000-0000-0000-000000000123";
    expect(() =>
      requireData({
        response: new Response(null, { status: 409 }),
        error: { conflictReservationIds: [id], moreConflicts: false },
      }),
    ).toThrow(id);
  });
});
