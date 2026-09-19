import { computed, effectScope, readonly, ref, watch } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LegalAvailability } from "../utils/legal-availability";
import { usePublicLegalDocument } from "./usePublicLegalDocument";

const legalAvailability = {
  schemaVersion: 1,
  policyRevision: "policy-v1",
  evaluatedAt: "2026-09-19T08:00:00.000Z",
  documents: Object.fromEntries(
    [
      "terms",
      "claims",
      "privacy",
      "prohibitedContent",
      "retention",
      "photoConsent",
    ].map((key) => [
      key,
      {
        revision: "terms-v2",
        status: "approved",
        effectiveAt: "2026-09-19T07:00:00.000Z",
        contentHash: "terms-hash-v2",
        effective: true,
      },
    ]),
  ),
} as LegalAvailability;

const legalRevision = {
  key: "terms",
  revisionCode: "terms-v2",
  title: "Published terms",
  summary: "Published terms summary",
  sections: [],
  effectiveAt: "2026-09-19T07:00:00.000Z",
  contentHash: "terms-hash-v2",
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("usePublicLegalDocument scope disposal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["success", "failure"] as const)(
    "does not let a disposed request overwrite a live instance after %s completion",
    async (completion) => {
      const state = new Map<string, ReturnType<typeof ref>>();
      vi.stubGlobal("useState", (key: string, factory: () => unknown) => {
        let value = state.get(key);
        if (!value) {
          value = ref(factory());
          state.set(key, value);
        }
        return value;
      });
      vi.stubGlobal("computed", computed);
      vi.stubGlobal("readonly", readonly);
      vi.stubGlobal("watch", watch);

      const firstRevision = deferred<{ data: typeof legalRevision }>();
      let revisionCalls = 0;
      vi.stubGlobal("useNuxtApp", () => ({
        $api: {
          GET: (path: string) => {
            if (path === "/legal-documents/availability") {
              return Promise.resolve({ data: legalAvailability });
            }
            revisionCalls += 1;
            return revisionCalls === 1
              ? firstRevision.promise
              : Promise.resolve({ data: legalRevision });
          },
        },
      }));

      const disposedScope = effectScope();
      const disposedDocument = disposedScope.run(() =>
        usePublicLegalDocument("terms"),
      )!;
      const disposedRefresh = disposedDocument.refresh(legalAvailability);
      expect(revisionCalls).toBe(1);

      disposedScope.stop();

      const liveScope = effectScope();
      const liveDocument = liveScope.run(() =>
        usePublicLegalDocument("terms"),
      )!;
      await liveDocument.refresh(legalAvailability);
      expect(liveDocument.document.value.id).toBe("terms-v2");

      if (completion === "success") {
        firstRevision.resolve({ data: legalRevision });
      } else {
        firstRevision.reject(new Error("request failed after disposal"));
      }
      await disposedRefresh;

      expect(liveDocument.document.value.id).toBe("terms-v2");
      const callsAfterCompletion = revisionCalls;
      await disposedDocument.refresh(legalAvailability);
      expect(revisionCalls).toBe(callsAfterCompletion);

      liveScope.stop();
    },
  );
});
