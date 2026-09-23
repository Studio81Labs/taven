import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../../tools/slicing-fixtures/fixtures/single-pla/cube.stl",
);
const benchmarkEnabled = process.env.INTEGRATION_BENCHMARK === "true";
const localReferenceRun = process.env.INTEGRATION_BENCHMARK_LOCAL === "true";
const sampleCount = Number(process.env.INTEGRATION_BENCHMARK_SAMPLES ?? 4);

type BrowserTiming = {
  parserStart: number;
  parserComplete: number;
  dispatch: number;
  responseComplete: number;
  committed: number;
  visible: number;
};

type TimingSample = BrowserTiming & {
  parseMs: number;
  schedulingMs: number;
  networkMs: number;
  renderMs: number;
  commitToRenderMs: number;
  postParseVisibleMs: number;
};

test.describe("Automatic estimate browser timing", () => {
  test.skip(
    !benchmarkEnabled,
    "Skipped unless INTEGRATION_BENCHMARK=true is present",
  );

  test("measures warm browser parse, network, and visible-estimate timing", async ({
    page,
  }) => {
    test.setTimeout(360_000);
    expect(Number.isInteger(sampleCount) && sampleCount >= 1).toBe(true);

    // Warm the browser's parser, bundle, API and database connections first.
    await openHome(page);
    await measureSample(page);

    const samples: TimingSample[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      await openHome(page);
      samples.push(await measureSample(page));
    }

    const median = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      const middle = (sorted.length - 1) / 2;
      const lower = Math.floor(middle);
      const upper = Math.ceil(middle);
      return (
        sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (middle - lower)
      );
    };
    const visibleDurations = samples.map((sample) => sample.postParseVisibleMs);
    const medianPostParseVisibleMs = median(visibleDurations);

    console.log(
      JSON.stringify(
        {
          browserProfile: "Playwright Chromium Desktop Chrome 1280x800",
          fixture: "tools/slicing-fixtures/fixtures/single-pla/cube.stl",
          sampleCount,
          samples: samples.map((sample) =>
            Object.fromEntries(
              Object.entries(sample).map(([key, value]) => [
                key,
                Number(value.toFixed(2)),
              ]),
            ),
          ),
          medianPostParseVisibleMs: Number(medianPostParseVisibleMs.toFixed(2)),
          maxPostParseVisibleMs: Number(
            Math.max(...visibleDurations).toFixed(2),
          ),
          localReferenceRun,
          target:
            "warm local real-API parse-complete to visible estimate <= 200 ms when local reference mode is enabled",
        },
        null,
        2,
      ),
    );
    if (localReferenceRun) {
      expect(medianPostParseVisibleMs).toBeLessThanOrEqual(200);
    }
  });
});

async function openHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Nahraj model/i, level: 1 }),
  ).toBeVisible();
}

async function measureSample(page: Page): Promise<TimingSample> {
  await page.evaluate(() => {
    performance.clearMarks();
  });
  const timing = waitForBrowserTiming(page);
  await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
  const browserTiming = await timing;
  return {
    ...browserTiming,
    parseMs: browserTiming.parserComplete - browserTiming.parserStart,
    schedulingMs: browserTiming.dispatch - browserTiming.parserComplete,
    networkMs: browserTiming.responseComplete - browserTiming.dispatch,
    renderMs: browserTiming.visible - browserTiming.responseComplete,
    commitToRenderMs: browserTiming.visible - browserTiming.committed,
    postParseVisibleMs: browserTiming.visible - browserTiming.parserComplete,
  };
}

function waitForBrowserTiming(page: Page): Promise<BrowserTiming> {
  return page.evaluate(
    () =>
      new Promise<BrowserTiming>((resolve, reject) => {
        const deadline = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error("estimate timing marks were not rendered"));
        }, 120_000);
        const observer = new MutationObserver(check);
        observer.observe(document.body, {
          childList: true,
          characterData: true,
          subtree: true,
        });

        function check(): void {
          const marks = new Map(
            performance
              .getEntriesByType("mark")
              .filter((entry) => entry.name.startsWith("taven-estimate:"))
              .map((entry) => [entry.name, entry.startTime]),
          );
          const revision = [...marks.keys()]
            .map((name) => name.split(":")[2])
            .find((candidate) => candidate !== undefined);
          if (!revision) return;
          const timestamp = (phase: string) =>
            marks.get(`taven-estimate:${phase}:${revision}`);
          const parserStart = timestamp("parser-start");
          const parserComplete = timestamp("parser-complete");
          const dispatch = timestamp("dispatch");
          const responseComplete = timestamp("response-complete");
          const committed = timestamp("committed");
          const hasVisibleEstimate = [...document.querySelectorAll("p")].some(
            (element) =>
              /Odhad pro PLA, standardní kvalitu/i.test(
                element.textContent ?? "",
              ),
          );
          if (
            parserStart === undefined ||
            parserComplete === undefined ||
            dispatch === undefined ||
            responseComplete === undefined ||
            committed === undefined ||
            !hasVisibleEstimate
          ) {
            return;
          }
          observer.disconnect();
          window.clearTimeout(deadline);
          requestAnimationFrame(() =>
            resolve({
              parserStart,
              parserComplete,
              dispatch,
              responseComplete,
              committed,
              visible: performance.now(),
            }),
          );
        }

        check();
      }),
    undefined,
  );
}
