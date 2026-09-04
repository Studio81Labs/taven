import { spawn } from "node:child_process";

const port = 4173;
const origin = `http://127.0.0.1:${port}`;
const budgets = {
  performance: 0.9,
  accessibility: 0.9,
  "best-practices": 0.9,
  seo: 0.9,
};

const preview = spawn(process.execPath, [".output/server/index.mjs"], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    NUXT_PUBLIC_SITE_URL: origin,
  },
  stdio: ["ignore", "ignore", "pipe"],
});

let previewError = "";
preview.stderr.setEncoding("utf8");
preview.stderr.on("data", (chunk) => {
  previewError += chunk;
});

try {
  await waitForPreview();

  for (const mode of ["mobile", "desktop"]) {
    const report = await runLighthouse(mode);
    const scores = Object.fromEntries(
      Object.entries(budgets).map(([category, minimum]) => {
        const score = report.categories[category]?.score;
        if (typeof score !== "number") {
          throw new Error(`Lighthouse did not return a ${category} score.`);
        }
        if (score < minimum) {
          throw new Error(
            `${mode} ${category} score ${Math.round(score * 100)} is below ${Math.round(minimum * 100)}.`,
          );
        }
        return [category, Math.round(score * 100)];
      }),
    );
    process.stdout.write(`${mode}: ${JSON.stringify(scores)}\n`);
  }
} finally {
  preview.kill("SIGTERM");
}

async function waitForPreview() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error(`Nuxt preview exited early.\n${previewError}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Nuxt preview did not start within 30 seconds.\n${previewError}`,
  );
}

async function runLighthouse(mode) {
  const args = [
    origin,
    "--quiet",
    "--output=json",
    "--output-path=stdout",
    "--only-categories=performance,accessibility,best-practices,seo",
    "--chrome-flags=--headless=new --no-sandbox",
  ];
  if (mode === "desktop") args.push("--preset=desktop");

  const result = await run("lighthouse", args);
  return JSON.parse(result);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}.\n${stderr}`));
    });
  });
}
