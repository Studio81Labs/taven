import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { OperatorRole, PrismaClient, SecurityEventType } from "@prisma/client";
import { stdin as input, stdout as output } from "node:process";
import { passwordHash } from "../src/modules/admin-access/operator-auth.service";
import { readAdminAccessConfig } from "../src/modules/admin-access/admin-access.config";

const SECURITY_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

type Arguments = Readonly<Record<string, string | true>>;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArguments(rest);
  if (command === "provision") {
    await provision(args);
  } else if (command === "reset-password") {
    await resetPassword(args);
  } else if (command === "disable") {
    await disable(args);
  } else {
    throw new Error(
      "Usage: provision|reset-password|disable --email EMAIL [--node-id UUID] [--role ADMIN|OPERATOR|VIEWER] [--github-user-id NUMERIC_ID]",
    );
  }
}

async function provision(args: Arguments): Promise<void> {
  const config = readAdminAccessConfig();
  const email = requiredEmail(args);
  const nodeId = required(args, "node-id");
  const role = requiredRole(args);
  const githubUserId = optional(args, "github-user-id");
  const password =
    config.environment === "development"
      ? await readPassword("New development operator password: ")
      : undefined;
  if (config.environment === "development" && githubUserId) {
    throw new Error(
      "Development operator provisioning does not accept GitHub identities",
    );
  }
  if (config.environment !== "development" && !githubUserId) {
    throw new Error("GitHub user ID is required outside development");
  }
  if (githubUserId && !/^[1-9][0-9]{0,28}$/.test(githubUserId)) {
    throw new Error(
      "--github-user-id must be an immutable numeric GitHub user ID",
    );
  }

  const node = await prisma.node.findFirst({
    where: { id: nodeId, active: true },
  });
  if (!node) throw new Error("--node-id must identify an active node");
  const now = new Date();
  const operator = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.operatorIdentity.findUnique({
      where: { email },
    });
    if (existing)
      throw new Error(
        `Operator ${email} already exists; use reset-password or disable`,
      );
    const created = await transaction.operatorIdentity.create({
      data: {
        email,
        role,
        nodeGrants: { create: { nodeId } },
        ...(password
          ? {
              developmentCredential: {
                create: { passwordHash: await passwordHash(password) },
              },
            }
          : {}),
        ...(githubUserId
          ? {
              githubIdentity: {
                create: {
                  issuer: "https://github.com",
                  githubUserId,
                },
              },
            }
          : {}),
      },
    });
    await transaction.securityEvent.create({
      data: {
        eventType: SecurityEventType.CREDENTIAL_RESET,
        operatorId: created.id,
        outcome: "provisioned",
        recordedAt: now,
        expiresAt: new Date(now.getTime() + SECURITY_RETENTION_MILLISECONDS),
      },
    });
    return created;
  });
  output.write(`Provisioned operator ${operator.id} for ${operator.email}\n`);
}

async function resetPassword(args: Arguments): Promise<void> {
  const config = readAdminAccessConfig();
  if (config.environment !== "development") {
    throw new Error(
      "Development passwords cannot be reset outside development",
    );
  }
  const email = requiredEmail(args);
  const password = await readPassword("New development operator password: ");
  const now = new Date();
  const updated = await prisma.$transaction(async (transaction) => {
    const operator = await transaction.operatorIdentity.findUnique({
      where: { email },
    });
    if (!operator) throw new Error(`Unknown operator ${email}`);
    const nextVersion = operator.credentialVersion + 1;
    await transaction.operatorIdentity.update({
      where: { id: operator.id },
      data: {
        credentialVersion: nextVersion,
        developmentCredential: {
          upsert: {
            create: { passwordHash: await passwordHash(password) },
            update: { passwordHash: await passwordHash(password) },
          },
        },
      },
    });
    await transaction.operatorSession.updateMany({
      where: { operatorId: operator.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await transaction.securityEvent.create({
      data: {
        eventType: SecurityEventType.CREDENTIAL_RESET,
        operatorId: operator.id,
        outcome: "password_reset",
        recordedAt: now,
        expiresAt: new Date(now.getTime() + SECURITY_RETENTION_MILLISECONDS),
      },
    });
    return operator;
  });
  output.write(`Reset development password for ${updated.email}\n`);
}

async function disable(args: Arguments): Promise<void> {
  const email = requiredEmail(args);
  const now = new Date();
  const updated = await prisma.$transaction(async (transaction) => {
    const operator = await transaction.operatorIdentity.findUnique({
      where: { email },
    });
    if (!operator) throw new Error(`Unknown operator ${email}`);
    await transaction.operatorIdentity.update({
      where: { id: operator.id },
      data: {
        active: false,
        credentialVersion: operator.credentialVersion + 1,
      },
    });
    await transaction.operatorSession.updateMany({
      where: { operatorId: operator.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await transaction.securityEvent.create({
      data: {
        eventType: SecurityEventType.OPERATOR_DISABLED,
        operatorId: operator.id,
        outcome: "disabled",
        recordedAt: now,
        expiresAt: new Date(now.getTime() + SECURITY_RETENTION_MILLISECONDS),
      },
    });
    return operator;
  });
  output.write(`Disabled operator ${updated.email}\n`);
}

function parseArguments(values: string[]): Arguments {
  const result: Record<string, string | true> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith("--"))
      throw new Error(`Unexpected argument ${value ?? ""}`);
    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[name] = true;
    } else {
      result[name] = next;
      index += 1;
    }
  }
  return result;
}

function required(args: Arguments, name: string): string {
  const value = optional(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function optional(args: Arguments, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function requiredEmail(args: Arguments): string {
  const email = required(args, "email").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error("--email must be a valid email address");
  }
  return email;
}

function requiredRole(args: Arguments): OperatorRole {
  const role = required(args, "role");
  if (!Object.values(OperatorRole).includes(role as OperatorRole)) {
    throw new Error("--role must be ADMIN, OPERATOR, or VIEWER");
  }
  return role as OperatorRole;
}

async function readPassword(prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "A TTY is required to enter a password without exposing it in arguments or environment",
    );
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\r" || text === "\n") {
        cleanup();
        output.write("\n");
        if (value.length < 12 || value.length > 1_024) {
          reject(new Error("Password must be between 12 and 1024 characters"));
        } else {
          resolve(value);
        }
      } else if (text === "\u0003") {
        cleanup();
        reject(new Error("Password entry cancelled"));
      } else if (text === "\u007f") {
        value = value.slice(0, -1);
      } else if (!containsControlCharacter(text)) {
        value += text;
      }
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    input.on("data", onData);
  });
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => character.codePointAt(0)! < 32);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
