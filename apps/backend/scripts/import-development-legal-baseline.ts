import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BASELINE_SOURCE_COMMIT =
  "e2343c42290feef1ff1ef45da1694106906b59e3";
export const BASELINE_SOURCE_PATH = "apps/web/content/legal-drafts.ts";
export const BASELINE_MANIFEST_PATH = "apps/web/content/launch-manifest.ts";
const BASELINE_SOURCE_HASH =
  "d295c84a2a54f59aca65bd7d9d756264aa0c14126a6de3e54fc9a9c85b9788cf";

const BASELINE_KEYS = [
  "terms",
  "claims",
  "privacy",
  "prohibitedContent",
  "retention",
  "photoConsent",
] as const;
const BASELINE_CODES: Record<BaselineKey, string> = {
  terms: "terms-of-service-cs-v0.1",
  claims: "complaints-policy-cs-v0.1",
  privacy: "privacy-policy-cs-v0.1",
  prohibitedContent: "prohibited-content-policy-cs-v0.1",
  retention: "retention-policy-cs-v0.1",
  photoConsent: "photo-consent-and-confidentiality-cs-v0.1",
};
const BASELINE_DOCUMENT_IDS: Record<BaselineKey, string> = {
  terms: "terms-of-service",
  claims: "complaints-policy",
  privacy: "privacy-policy",
  prohibitedContent: "prohibited-content-policy",
  retention: "retention-policy",
  photoConsent: "photo-consent-and-confidentiality",
};
const BASELINE_SOURCE_DOCUMENT_IDS: Record<BaselineKey, string> = {
  terms: "terms-pending",
  claims: "claims-pending",
  privacy: "privacy-pending",
  prohibitedContent: "prohibited-content-pending",
  retention: "retention-pending",
  photoConsent: "photo-consent-pending",
};
const BASELINE_REASON_CODE = "V0_1_BASELINE_IMPORT";
const BASELINE_REASON =
  "Import owner-approved development/staging legal baseline v0.1";
const OWNER_DECISION_REFERENCE =
  "https://github.com/Studio81Labs/taven/issues/38#issuecomment-5744707749";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type BaselineKey = (typeof BASELINE_KEYS)[number];

export type BaselineDocument = Readonly<{
  key: BaselineKey;
  documentId: string;
  title: string;
  summary: string;
  sections: readonly BaselineSection[];
  revisionCode: string;
}>;

export type BaselineSection = Readonly<{
  title: string;
  paragraphs?: readonly string[];
  items?: readonly string[];
  note?: string;
}>;

export type BaselinePackage = Readonly<{
  sourceCommit: string;
  sourcePath: string;
  sourceHash: string;
  packageHash: string;
  documents: readonly BaselineDocument[];
}>;

export type BaselineTargetConfig = Readonly<{
  targetId: string;
  environment: "development" | "staging";
  baseUrl: string;
  origin: string;
  allowBaselineImport: true;
}>;

type Arguments = Readonly<Record<string, string | true>>;

type ReceiptDocument = {
  revisionId?: string;
  contentHash: string;
  effectiveAt: string;
  publicationId?: string;
  status: "approved" | "published" | "scheduled";
  auditEventIds: string[];
};

export type BaselineReceipt = {
  version: 1;
  preparedAt: string;
  target: BaselineTargetConfig & { configHash: string };
  package: BaselinePackage;
  operator?: {
    operatorId: string;
    role: string;
    authenticationMethod: string;
  };
  documents: Partial<Record<BaselineKey, ReceiptDocument>>;
};

type ApiResponse = Readonly<{
  status: number;
  body: unknown;
}>;

type LegalDocumentSummary = {
  id: string;
  key: string;
  generation: number;
  activePublication?: LegalPublication;
  pendingPublication?: LegalPublication;
};

type LegalDocumentDetail = LegalDocumentSummary & {
  revisions: LegalRevision[];
  publications: LegalPublication[];
};

type LegalRevision = {
  id: string;
  sequence: number;
  editVersion: number;
  status: "DRAFT" | "APPROVED";
  title: string;
  summary: string;
  sections: BaselineSection[];
  contentHash: string;
  revisionCode?: string;
  effectiveAt?: string;
};

type LegalPublication = {
  id: string;
  revisionId: string;
  revisionCode?: string;
  startsAt: string;
  endsAt?: string;
  cancelledAt?: string;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Baseline package contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("Baseline package contains an unsupported value");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

export function parseTargetConfig(value: unknown): BaselineTargetConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Target config must be a JSON object");
  }
  const config = value as Record<string, unknown>;
  const targetId = requiredString(config.targetId, "targetId");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,99}$/.test(targetId)) {
    throw new Error("targetId must be a stable non-production identifier");
  }
  if (
    config.environment !== "development" &&
    config.environment !== "staging"
  ) {
    throw new Error(
      "Baseline import is restricted to explicitly selected development or staging targets",
    );
  }
  if (config.allowBaselineImport !== true) {
    throw new Error("Target config must explicitly allow baseline import");
  }
  const baseUrl = parseUrl(config.baseUrl, "baseUrl");
  const origin = parseUrl(config.origin, "origin");
  return {
    targetId,
    environment: config.environment,
    baseUrl,
    origin,
    allowBaselineImport: true,
  };
}

function parseUrl(value: unknown, name: string): string {
  const raw = requiredString(value, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search
  ) {
    throw new Error(`${name} must not contain credentials or a fragment`);
  }
  if (name === "origin" && parsed.pathname !== "/") {
    throw new Error("origin must be an exact origin URL");
  }
  return name === "origin"
    ? parsed.origin
    : `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
}

export async function loadBaselinePackage(
  repoRoot: string,
): Promise<BaselinePackage> {
  const sourcePath = path.join(repoRoot, BASELINE_SOURCE_PATH);
  const manifestPath = path.join(repoRoot, BASELINE_MANIFEST_PATH);
  const source = readFileSync(sourcePath);
  const sourceHash = sha256(source);
  let pinnedSourceHash = BASELINE_SOURCE_HASH;
  try {
    const committedSource = execFileSync(
      "git",
      ["show", `${BASELINE_SOURCE_COMMIT}:${BASELINE_SOURCE_PATH}`],
      { cwd: repoRoot },
    );
    pinnedSourceHash = sha256(committedSource);
  } catch {
    // Pull-request checkouts are shallow; the pinned digest still verifies the
    // immutable source when the historical commit object is unavailable.
  }
  if (sourceHash !== pinnedSourceHash) {
    throw new Error(
      `${BASELINE_SOURCE_PATH} differs from pinned package commit ${BASELINE_SOURCE_COMMIT}`,
    );
  }

  const manifest = (await import(
    `${pathToFileURL(manifestPath).href}?baseline=${sourceHash}`
  )) as {
    legalDocuments?: Record<string, Record<string, unknown>>;
  };
  if (!manifest.legalDocuments) {
    throw new Error("The legal document manifest could not be loaded");
  }

  const documents = BASELINE_KEYS.map((key) => {
    const value = manifest.legalDocuments?.[key];
    if (!value || value.status !== "draft") {
      throw new Error(
        `Baseline source document ${key} is not an immutable draft`,
      );
    }
    const expectedDocumentId = BASELINE_DOCUMENT_IDS[key];
    const sourceDocumentId = requiredString(value.id, `${key}.id`);
    if (sourceDocumentId !== BASELINE_SOURCE_DOCUMENT_IDS[key]) {
      throw new Error(
        `${key} must remain the repository's pinned non-effective draft`,
      );
    }
    const title = requiredString(value.title, `${key}.title`);
    const summary = requiredString(value.summary, `${key}.summary`);
    if (!Array.isArray(value.sections) || value.sections.length === 0) {
      throw new Error(`${key}.sections must contain at least one section`);
    }
    const sections = value.sections as BaselineSection[];
    const packageDocument: BaselineDocument = {
      key,
      documentId: expectedDocumentId,
      title,
      summary,
      sections,
      revisionCode: BASELINE_CODES[key],
    };
    return packageDocument;
  });
  const packageHash = sha256(
    canonicalJson({
      sourceCommit: BASELINE_SOURCE_COMMIT,
      sourcePath: BASELINE_SOURCE_PATH,
      sourceHash,
      documents,
    }),
  );
  return {
    sourceCommit: BASELINE_SOURCE_COMMIT,
    sourcePath: BASELINE_SOURCE_PATH,
    sourceHash,
    packageHash,
    documents,
  };
}

function parseArguments(argv: readonly string[]): Arguments {
  const result: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) throw new Error(`Unknown argument ${value}`);
    const name = value.slice(2);
    if (!name) throw new Error("Argument name is empty");
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[name] = next;
      index += 1;
    } else result[name] = true;
  }
  return result;
}

function requiredArgument(args: Arguments, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function normalizeEffectiveAt(value: string | undefined): string {
  const raw = value ?? new Date().toISOString();
  if (
    value !== undefined &&
    !/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
  ) {
    throw new Error("--effective-at must include a timezone offset or Z");
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("--effective-at must be a valid timezone-aware instant");
  }
  return parsed.toISOString();
}

function readJsonFile(file: string): { value: unknown; hash: string } {
  const bytes = readFileSync(file);
  try {
    return { value: JSON.parse(bytes.toString("utf8")), hash: sha256(bytes) };
  } catch {
    throw new Error(`Target config ${file} is not valid JSON`);
  }
}

function readReceipt(file: string): BaselineReceipt | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BaselineReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Receipt ${file} is not valid JSON`, { cause: error });
  }
}

function writeReceipt(file: string, receipt: BaselineReceipt): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function assertReceiptMatches(
  receipt: BaselineReceipt,
  target: BaselineTargetConfig,
  targetConfigHash: string,
  baseline: BaselinePackage,
): void {
  if (receipt.version !== 1)
    throw new Error("Unsupported baseline receipt version");
  if (
    receipt.target.targetId !== target.targetId ||
    receipt.target.environment !== target.environment ||
    receipt.target.baseUrl !== target.baseUrl ||
    receipt.target.configHash !== targetConfigHash
  ) {
    throw new Error("Baseline receipt belongs to a different target config");
  }
  if (
    receipt.package.sourceCommit !== baseline.sourceCommit ||
    receipt.package.sourceHash !== baseline.sourceHash ||
    receipt.package.packageHash !== baseline.packageHash
  ) {
    throw new Error(
      "Baseline receipt belongs to a different immutable package",
    );
  }
}

function idempotencyKey(
  targetId: string,
  key: BaselineKey,
  action: string,
  packageHash: string,
): string {
  return `baseline-${sha256(`${targetId}:${key}:${action}:${packageHash}`).slice(0, 48)}`;
}

class BaselineApi {
  constructor(
    private readonly target: BaselineTargetConfig,
    private readonly sessionCookie: string,
    private readonly csrfToken: string,
  ) {}

  async request(
    route: string,
    options: RequestInit = {},
    mutation = false,
  ): Promise<ApiResponse> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    headers.set("Cookie", this.sessionCookie);
    headers.set("Origin", this.target.origin);
    if (mutation) {
      headers.set("X-CSRF-Token", this.csrfToken);
      if (!headers.has("Idempotency-Key")) {
        throw new Error(`Missing idempotency key for ${route}`);
      }
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(new URL(route, `${this.target.baseUrl}/`), {
      ...options,
      headers,
    });
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Response from ${route} exceeds the bounded response size`,
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Response from ${route} exceeds the bounded response size`,
      );
    }
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  }

  async json<T>(
    route: string,
    options: RequestInit = {},
    mutation = false,
  ): Promise<T> {
    const result = await this.request(route, options, mutation);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `${options.method ?? "GET"} ${route} failed with ${result.status}: ${JSON.stringify(result.body)}`,
      );
    }
    return result.body as T;
  }
}

function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}

function packageDocumentMatches(
  revision: Pick<LegalRevision, "title" | "summary" | "sections">,
  document: BaselineDocument,
): boolean {
  return (
    revision.title === document.title &&
    revision.summary === document.summary &&
    canonicalJson(revision.sections) === canonicalJson(document.sections)
  );
}

function packageDocumentHash(document: BaselineDocument): string {
  return sha256(
    canonicalJson({
      contentVersion: 1,
      title: document.title,
      summary: document.summary,
      sections: document.sections,
    }),
  );
}

async function auditIds(
  api: BaselineApi,
  key: BaselineKey,
  revisionId: string,
  publicationId: string | undefined,
): Promise<string[]> {
  const page = await api.json<{
    items: Array<{ id: string; payload: Record<string, unknown> }>;
  }>(
    `/admin/legal-documents/${encodeURIComponent(key)}/audit-events?limit=100`,
  );
  return page.items
    .filter((event) => {
      const payload = event.payload;
      return (
        payload.revisionId === revisionId &&
        (payload.publicationId === undefined ||
          (publicationId !== undefined &&
            payload.publicationId === publicationId))
      );
    })
    .map((event) => event.id);
}

async function reconcileDocument(
  api: BaselineApi,
  baseline: BaselinePackage,
  receipt: BaselineReceipt,
  document: BaselineDocument,
  receiptPath: string,
): Promise<void> {
  const state = receipt.documents[document.key];
  if (state?.status === "published" || state?.status === "scheduled") return;
  const detail = await api.json<LegalDocumentDetail>(
    `/admin/legal-documents/${encodeURIComponent(document.key)}?limit=100&publicationLimit=100`,
  );
  let revision = detail.revisions.find(
    (candidate) =>
      candidate.contentHash ===
      (state?.contentHash || packageDocumentHash(document)),
  );
  if (!revision) {
    revision = detail.revisions.find(
      (candidate) =>
        candidate.status === "APPROVED" &&
        candidate.revisionCode === document.revisionCode,
    );
    if (revision && !packageDocumentMatches(revision, document)) {
      throw new Error(
        `${document.key} already uses ${document.revisionCode} with different content`,
      );
    }
  }
  if (!revision) {
    const created = await api.json<LegalRevision>(
      `/admin/legal-documents/${encodeURIComponent(document.key)}/revisions`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(
            receipt.target.targetId,
            document.key,
            "draft",
            baseline.packageHash,
          ),
        },
        ...jsonBody({
          expectedGeneration: detail.generation,
          title: document.title,
          summary: document.summary,
          sections: document.sections,
          reasonCode: BASELINE_REASON_CODE,
          reason: BASELINE_REASON,
        }),
      },
      true,
    );
    revision = created;
    receipt.documents[document.key] = {
      revisionId: revision.id,
      contentHash: revision.contentHash,
      effectiveAt: state?.effectiveAt ?? normalizeEffectiveAt(undefined),
      status: "approved",
      auditEventIds: [],
    };
    writeReceipt(receiptPath, receipt);
  }
  if (!packageDocumentMatches(revision, document)) {
    throw new Error(
      `${document.key} draft content differs from the frozen package`,
    );
  }
  if (revision.status === "DRAFT") {
    const current = receipt.documents[document.key];
    const effectiveAt = current?.effectiveAt ?? normalizeEffectiveAt(undefined);
    const approved = await api.json<LegalRevision>(
      `/admin/legal-documents/${encodeURIComponent(document.key)}/revisions/${revision.id}/approve`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(
            receipt.target.targetId,
            document.key,
            "approve",
            baseline.packageHash,
          ),
        },
        ...jsonBody({
          expectedEditVersion: revision.editVersion,
          expectedContentHash: revision.contentHash,
          revisionCode: document.revisionCode,
          effectiveAt,
          approvalEvidence: [
            "Owner-approved development/staging baseline v0.1",
            OWNER_DECISION_REFERENCE,
            `source commit ${baseline.sourceCommit}`,
            `package hash ${baseline.packageHash}`,
            `target ${receipt.target.targetId} (${receipt.target.environment})`,
            "Counsel and production approval are not claimed",
          ].join("; "),
          reasonCode: BASELINE_REASON_CODE,
          reason: BASELINE_REASON,
        }),
      },
      true,
    );
    revision = approved;
    receipt.documents[document.key] = {
      revisionId: approved.id,
      contentHash: approved.contentHash,
      effectiveAt,
      status: "approved",
      auditEventIds: [],
    };
    writeReceipt(receiptPath, receipt);
  } else if (revision.revisionCode !== document.revisionCode) {
    throw new Error(
      `${document.key} approved revision code does not match v0.1`,
    );
  }

  const current = receipt.documents[document.key];
  const publication = detail.publications.find(
    (candidate) =>
      candidate.revisionId === revision.id &&
      candidate.cancelledAt === undefined,
  );
  const currentDetail = await api.json<LegalDocumentDetail>(
    `/admin/legal-documents/${encodeURIComponent(document.key)}?limit=100&publicationLimit=100`,
  );
  const currentPublication = currentDetail.publications.find(
    (candidate) =>
      candidate.revisionId === revision.id &&
      candidate.cancelledAt === undefined,
  );
  const selectedPublication = currentPublication ?? publication;
  if (!selectedPublication) {
    const published = await api.json<LegalPublication>(
      `/admin/legal-documents/${encodeURIComponent(document.key)}/revisions/${revision.id}/publish`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(
            receipt.target.targetId,
            document.key,
            "publish",
            baseline.packageHash,
          ),
        },
        ...jsonBody({
          expectedGeneration: currentDetail.generation,
          reasonCode: BASELINE_REASON_CODE,
          reason: BASELINE_REASON,
        }),
      },
      true,
    );
    receipt.documents[document.key] = {
      revisionId: revision.id,
      contentHash: revision.contentHash,
      effectiveAt: current?.effectiveAt ?? revision.effectiveAt!,
      publicationId: published.id,
      status:
        new Date(published.startsAt).getTime() <= Date.now()
          ? "published"
          : "scheduled",
      auditEventIds: [],
    };
  } else {
    receipt.documents[document.key] = {
      revisionId: revision.id,
      contentHash: revision.contentHash,
      effectiveAt: current?.effectiveAt ?? revision.effectiveAt!,
      publicationId: selectedPublication.id,
      status:
        new Date(selectedPublication.startsAt).getTime() <= Date.now()
          ? "published"
          : "scheduled",
      auditEventIds: current?.auditEventIds ?? [],
    };
  }
  const finalState = receipt.documents[document.key]!;
  finalState.auditEventIds = await auditIds(
    api,
    document.key,
    revision.id,
    finalState.publicationId,
  );
  writeReceipt(receiptPath, receipt);
}

async function verifyBaseline(
  api: BaselineApi,
  baseline: BaselinePackage,
  receipt: BaselineReceipt,
): Promise<void> {
  const availability = await api.json<{
    documents: Record<
      BaselineKey,
      { revision: string; contentHash: string | null; effective: boolean }
    >;
  }>("/legal-documents/availability");
  for (const document of baseline.documents) {
    const state = receipt.documents[document.key];
    if (!state?.revisionId || !state.contentHash) {
      throw new Error(`${document.key} has no completed baseline receipt`);
    }
    const record = availability.documents[document.key];
    if (state.status === "published") {
      if (
        !record?.effective ||
        record.revision !== document.revisionCode ||
        record.contentHash !== state.contentHash
      ) {
        throw new Error(
          `${document.key} availability does not match the receipt`,
        );
      }
      const publicRevision = await api.json<{
        key: string;
        revisionCode: string;
        contentHash: string;
        title: string;
        summary: string;
        sections: BaselineSection[];
      }>(
        `/legal-documents/${encodeURIComponent(document.key)}/revisions/${encodeURIComponent(document.revisionCode)}`,
      );
      if (
        publicRevision.key !== document.key ||
        publicRevision.revisionCode !== document.revisionCode ||
        publicRevision.contentHash !== state.contentHash ||
        !packageDocumentMatches(publicRevision, document)
      ) {
        throw new Error(
          `${document.key} public revision does not match the package`,
        );
      }
    } else if (record?.effective) {
      throw new Error(
        `${document.key} receipt is scheduled but availability is effective`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const targetConfigPath = requiredArgument(args, "target-config");
  const receiptPath = requiredArgument(args, "receipt");
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const targetFile = readJsonFile(path.resolve(targetConfigPath));
  const target = parseTargetConfig(targetFile.value);
  const baseline = await loadBaselinePackage(repoRoot);
  const existing = readReceipt(path.resolve(receiptPath));
  const effectiveAt = normalizeEffectiveAt(
    typeof args["effective-at"] === "string" ? args["effective-at"] : undefined,
  );
  const receipt: BaselineReceipt = existing ?? {
    version: 1,
    preparedAt: new Date().toISOString(),
    target: { ...target, configHash: targetFile.hash },
    package: baseline,
    documents: Object.fromEntries(
      baseline.documents.map((document) => [
        document.key,
        {
          contentHash: "",
          effectiveAt,
          status: "approved" as const,
          auditEventIds: [],
        },
      ]),
    ),
  };
  assertReceiptMatches(receipt, target, targetFile.hash, baseline);
  for (const document of baseline.documents) {
    const state = receipt.documents[document.key];
    if (!state) {
      receipt.documents[document.key] = {
        contentHash: "",
        effectiveAt,
        status: "approved",
        auditEventIds: [],
      };
    } else if (!state.effectiveAt) {
      state.effectiveAt = effectiveAt;
    }
  }
  writeReceipt(path.resolve(receiptPath), receipt);

  const sessionCookie = requiredString(
    process.env.TAVEN_LEGAL_IMPORT_SESSION_COOKIE,
    "TAVEN_LEGAL_IMPORT_SESSION_COOKIE",
  );
  const csrfToken = requiredString(
    process.env.TAVEN_LEGAL_IMPORT_CSRF_TOKEN,
    "TAVEN_LEGAL_IMPORT_CSRF_TOKEN",
  );
  const api = new BaselineApi(target, sessionCookie, csrfToken);
  const session = await api.json<{
    operator: {
      operatorId: string;
      role: string;
      authenticationMethod: string;
    };
  }>("/admin/auth/session");
  if (session.operator.role !== "ADMIN") {
    throw new Error(
      "The baseline importer requires an authenticated ADMIN session",
    );
  }
  receipt.operator = session.operator;
  writeReceipt(path.resolve(receiptPath), receipt);

  for (const document of baseline.documents) {
    await reconcileDocument(
      api,
      baseline,
      receipt,
      document,
      path.resolve(receiptPath),
    );
  }
  await verifyBaseline(api, baseline, receipt);
  console.log(
    JSON.stringify(
      {
        target: receipt.target.targetId,
        environment: receipt.target.environment,
        packageHash: receipt.package.packageHash,
        documents: receipt.documents,
        receipt: path.resolve(receiptPath),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
