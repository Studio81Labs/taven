import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const composeFile = join(root, "infra/coolify/docker-compose.yml");

test("rendered Compose preserves worker secret scopes and one runtime build", () => {
  const dir = mkdtempSync(join(tmpdir(), "taven-compose-"));
  try {
    const variables = Object.fromEntries(
      [...readFileSync(composeFile, "utf8").matchAll(/\$\{([A-Z0-9_]+)/g)].map(
        ([, key]) => [key, `test-${key}`],
      ),
    );
    Object.assign(variables, {
      NODE_ENV: "production",
      TAVEN_ENVIRONMENT: "staging",
      SOURCE_COMMIT: "0123456789abcdef",
      TAVEN_DOCKER_NETWORK: "taven-staging",
      TAVEN_BACKEND_NETWORK_ALIAS: "taven-staging-api",
    });
    const envFile = join(dir, ".env");
    writeFileSync(
      envFile,
      Object.entries(variables)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--project-directory",
        root,
        "--env-file",
        envFile,
        "-f",
        composeFile,
        "--profile",
        "release",
        "config",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const { services, networks } = JSON.parse(result.stdout);
    assert.equal(Object.keys(services).length, 8);
    assert.equal(networks.application.external, true);
    for (const [name, service] of Object.entries(services)) {
      assert.equal(service.env_file, undefined);
      assert.equal(service.ports, undefined);
      if (name !== "migration") {
        assert.equal(service.image, services.backend.image);
        assert.ok(service.healthcheck);
      }
      if (!["backend", "migration"].includes(name))
        assert.equal(service.build, undefined);
      if (!["backend", "operator-auth-expiry-worker"].includes(name)) {
        assert.equal(
          service.environment.TAVEN_GITHUB_APP_CLIENT_SECRET,
          undefined,
        );
      }
      if (!["backend", "checkout-payment-worker"].includes(name)) {
        assert.equal(service.environment.TAVEN_COMGATE_SECRET, undefined);
      }
      if (!["backend", "slicing-dispatcher"].includes(name)) {
        assert.equal(service.environment.TAVEN_REDIS_URL, undefined);
      }
    }
    assert.equal(services.backend.build.context, root);
    assert.equal(services.migration.build.target, "migration");
    assert.deepEqual(services.migration.profiles, ["release"]);
    assert.equal(
      services["retention-worker"].environment.DATABASE_URL,
      variables.TAVEN_RETENTION_DATABASE_URL,
    );
    assert.equal(
      services["retention-worker"].environment.TAVEN_S3_SECRET_ACCESS_KEY,
      variables.TAVEN_RETENTION_S3_SECRET_ACCESS_KEY,
    );
    assert.equal(
      services["slicing-dispatcher"].environment.TAVEN_S3_SECRET_ACCESS_KEY,
      variables.TAVEN_SLICER_S3_SECRET_ACCESS_KEY,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const migrationExit of [0, 1]) {
  test(`release gates activation on migration (exit ${migrationExit})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "taven-release-"));
    try {
      writeFileSync(
        join(dir, "docker"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\ncase "$*" in *"run --rm --no-deps migration"*) exit "$MIGRATION_EXIT";; esac\n',
        { mode: 0o755 },
      );
      const log = join(dir, "calls");
      const result = spawnSync("sh", ["infra/coolify/release.sh"], {
        cwd: root,
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          CALL_LOG: log,
          MIGRATION_EXIT: String(migrationExit),
        },
      });
      assert.equal(result.status, migrationExit);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(calls.length, migrationExit ? 1 : 2);
      assert.match(calls[0], /run --rm --no-deps migration$/);
      if (!migrationExit)
        assert.match(
          calls[1],
          /up -d --no-build --force-recreate --wait --wait-timeout 180$/,
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
