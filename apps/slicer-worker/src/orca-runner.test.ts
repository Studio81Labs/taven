import { execFile } from "node:child_process";
import {
  access,
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function makeRootCleanupFixtureAccessible(
  directory: string,
): Promise<void> {
  if (process.getuid?.() !== 0) return;
  await chown(directory, 10001, 10001);
  await chmod(directory, 0o770);
}

describe("Orca runner lifecycle", () => {
  it("creates a network namespace before Bubblewrap", async () => {
    const runner = await readFile(path.resolve("orca-runner.sh"), "utf8");

    expect(runner.indexOf("/usr/bin/unshare --net --")).toBeLessThan(
      runner.indexOf("/usr/bin/bwrap"),
    );
    expect(runner).not.toContain("--unshare-net");
  });

  it("recovers restart markers and reaps cancelled or expired requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "taven-runner-lifecycle-"));
    cleanup.push(root);
    await chmod(root, 0o777);
    const future = Math.ceil(Date.now() / 1_000) + 120;
    const past = Math.floor(Date.now() / 1_000) - 1;

    const processing = path.join(root, "request-processing");
    await mkdir(processing);
    await makeRootCleanupFixtureAccessible(processing);
    await writeFile(path.join(processing, "processing"), "\n");
    await writeFile(path.join(processing, "lease-expires-at"), `${future}\n`);

    const cancelled = path.join(root, "request-cancelled");
    await mkdir(cancelled);
    await makeRootCleanupFixtureAccessible(cancelled);
    await writeFile(path.join(cancelled, "cancel"), "\n");

    const expired = path.join(root, "request-expired");
    await mkdir(expired);
    await makeRootCleanupFixtureAccessible(expired);
    await writeFile(path.join(expired, "complete"), "\n");
    await writeFile(path.join(expired, "lease-expires-at"), `${past}\n`);

    const preparing = path.join(root, "request-preparing");
    await mkdir(preparing);
    await makeRootCleanupFixtureAccessible(preparing);
    await writeFile(path.join(preparing, "lease-expires-at"), `${future}\n`);

    await execute("/bin/sh", [path.resolve("orca-runner.sh")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        TAVEN_ORCA_RUNNER_ROOT: root,
        TAVEN_ORCA_RUNNER_ONCE: "true",
      },
    });

    await expect(
      readFile(path.join(processing, "failure-code"), "utf8"),
    ).resolves.toBe("ENGINE_UNAVAILABLE\n");
    await expect(exists(path.join(processing, "processing"))).resolves.toBe(
      false,
    );
    await expect(exists(path.join(processing, "failed"))).resolves.toBe(true);
    await expect(exists(cancelled)).resolves.toBe(false);
    await expect(exists(expired)).resolves.toBe(false);
    await expect(exists(preparing)).resolves.toBe(true);
  });

  it("fails a ready request when its writable workspace is not group accessible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "taven-runner-workspace-"));
    cleanup.push(root);
    await chmod(root, 0o777);
    const request = path.join(root, "request-wrong-mode");
    const toolsDirectory = path.join(root, "tools");
    const statLog = path.join(root, "stat.log");
    const future = Math.ceil(Date.now() / 1_000) + 120;

    await mkdir(path.join(request, "output"), { recursive: true });
    await mkdir(path.join(request, "tmp", "data"), { recursive: true });
    await mkdir(path.join(request, "profiles", "settings"), {
      recursive: true,
    });
    await mkdir(toolsDirectory);
    await writeFile(
      path.join(toolsDirectory, "find"),
      `#!/bin/sh
case "$1" in
  */profiles/settings) printf '%s\\n' /work/profiles/settings/0.json ;;
esac
`,
    );
    await writeFile(
      path.join(toolsDirectory, "stat"),
      `#!/bin/sh
printf '%s\\n' "$3" >> "$TAVEN_TEST_STAT_LOG"
case "$3" in
  */output) printf '%s\\n' 10001:10001:700 ;;
  *) printf '%s\\n' 10001:10001:770 ;;
esac
`,
    );
    await chmod(path.join(toolsDirectory, "find"), 0o755);
    await chmod(path.join(toolsDirectory, "stat"), 0o755);
    await chmod(path.join(request, "output"), 0o700);
    await writeFile(path.join(request, "lease-expires-at"), `${future}\n`);
    await writeFile(path.join(request, "copies"), "1\n");
    await writeFile(path.join(request, "artifact-format"), "gcode\n");
    await writeFile(path.join(request, "timeout-seconds"), "60\n");
    await writeFile(path.join(request, "geometry.stl"), "solid test\n");
    await writeFile(
      path.join(request, "profiles", "settings", "0.json"),
      "{}\n",
    );
    await writeFile(path.join(request, "ready"), "\n");

    await execute("/bin/sh", [path.resolve("orca-runner.sh")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PATH: `${toolsDirectory}:${process.env.PATH}`,
        TAVEN_ORCA_RUNNER_ROOT: root,
        TAVEN_ORCA_RUNNER_ONCE: "true",
        TAVEN_TEST_STAT_LOG: statLog,
      },
    });

    await expect(
      readFile(path.join(request, "failure-code"), "utf8"),
    ).resolves.toBe("ENGINE_UNAVAILABLE\n");
    await expect(readFile(statLog, "utf8")).resolves.toContain(
      path.join(request, "output"),
    );
    await expect(exists(path.join(request, "processing"))).resolves.toBe(false);
    await expect(exists(path.join(request, "failed"))).resolves.toBe(true);
  });
});
