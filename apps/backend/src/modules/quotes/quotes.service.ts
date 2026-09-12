import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AuditActorKind,
  AutomaticQuoteHandoffScope,
  IdempotencyStatus,
  Material,
  PaymentRole,
  PhotoScopeKind,
  PriceComponentKind,
  PriceComponentScope,
  Prisma,
  QuoteRequestStatus,
  QuoteSessionStatus,
  RetentionHold,
  SellerTaxRegime,
  SliceKind,
} from "@prisma/client";
import type { QuoteRequestStatus as DomainQuoteRequestStatus } from "@taven/core" with {
  "resolution-mode": "import",
};
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  assertBindingQuoteFlowsEnabled,
  assertEffectiveQuoteRequestLegalDocuments,
} from "../../launch-approval-gates";
import { PrismaService } from "../../prisma/prisma.service";
import { assertEffectiveLegalDocuments } from "../legal-approvals/legal-approvals.catalog";
import { LegalApprovalsService } from "../legal-approvals/legal-approvals.service";
import {
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { AuditService } from "../audit/audit.service";
import { normalizeAttribution } from "../metrics/attribution";
import { writeBusinessEvent } from "../metrics/business-event.writer";
import { parseSellerTaxPolicy } from "../../pricing/seller-tax-policy";
import { reserveAnonymousQuote } from "./anonymous-quote-limit";
import type {
  AcceptOfferDto,
  AcceptedOfferDto,
  AutomaticQuoteRequestHandoffItemDto,
  CreateQuoteRequestDto,
  IssueOfferDto,
  ModelOfferItemDto,
  OfferDeliveryDestinationDto,
  OfferIssuedDto,
  OfferPaymentCapturePolicyDto,
  OfferPaymentScheduleDto,
  OfferPreviewDto,
  OfferPreviewPriceComponentDto,
  OperatorQuoteRequestDetailDto,
  OperatorQuoteRequestPageDto,
  OfferShipmentPlanDto,
  QuoteContactDto,
  QuoteRequestCreatedDto,
  QuoteRequestDetailDto,
  QuoteRequestStatusDto,
  RejectOfferDto,
} from "./quotes.dto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_SESSION_DAYS = 30;
const IDEMPOTENCY_DAYS = 7;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const OFFER_PACKING_UNIT_MAX = 1_000;
const QUOTE_WRITE_BATCH_SIZE = 500;
const JSON_MAXIMUM_DEPTH = 64;
const OPERATOR_QUEUE_DEFAULT_LIMIT = 25;
const OPERATOR_QUEUE_MAX_LIMIT = 100;
const REQUIRED_ITEM_COMPONENTS = new Set<PriceComponentKind>([
  PriceComponentKind.ITEM_PRODUCTION,
  PriceComponentKind.ITEM_QUANTITY,
  PriceComponentKind.ITEM_POSTPROCESSING,
]);
const ITEM_COMPONENTS = REQUIRED_ITEM_COMPONENTS;
const ORDER_COMPONENTS = new Set<PriceComponentKind>([
  PriceComponentKind.ORDER_MIN_PRINT,
  PriceComponentKind.ORDER_SMALL_SURCHARGE,
  PriceComponentKind.EXPRESS,
]);
const OFFER_COMPONENT_ORDER = [
  PriceComponentKind.ITEM_PRODUCTION,
  PriceComponentKind.ITEM_QUANTITY,
  PriceComponentKind.ITEM_POSTPROCESSING,
  PriceComponentKind.ORDER_MIN_PRINT,
  PriceComponentKind.ORDER_SMALL_SURCHARGE,
  PriceComponentKind.SHIPMENT,
  PriceComponentKind.EXPRESS,
  PriceComponentKind.PAYMENT_FEE,
  PriceComponentKind.VAT,
] as const;

type Transaction = Prisma.TransactionClient;
type RequestAttachments = Awaited<
  ReturnType<PrismaService["photoAsset"]["findMany"]>
>;
type QuoteAcceptanceRow = {
  evaluated_at: Date;
  accepted_at: Date | null;
};
type ExpiringResult<T> =
  Readonly<{ kind: "ok"; value: T }> | Readonly<{ kind: "expired" }>;
type IdempotencyResponseCodec<T> = Readonly<{
  toStoredResponse: (response: T, generation: number) => unknown;
  fromStoredResponse: (
    response: Prisma.JsonValue,
    requestFingerprint: string,
    generation: number,
  ) => T;
}>;
type OperatorQueueSla = "PENDING" | "MET" | "BREACHED";
type OperatorQueueCursor = Readonly<{
  slaDueAt: string;
  createdAt: string;
  id: string;
  filterHash: string;
}>;

export type OperatorQuoteRequestPageInput = Readonly<{
  status?: string;
  sla?: string;
  cursor?: string;
  limit?: number;
}>;
type IdempotencyOptions<T> = Readonly<{
  responseCodec?: IdempotencyResponseCodec<T>;
  responseStatusCode?: number | ((response: T) => number);
  beforeReplay?: (transaction: Transaction) => Promise<void>;
}>;
type QuoteCapabilityKey = Readonly<{ id: string; key: string }>;
type StoredQuoteRequestCreatedResponse = Omit<
  QuoteRequestCreatedDto,
  "requestToken"
> &
  Readonly<{
    capabilityKeyId: string;
    capabilityTokenGeneration?: number;
  }>;
type StoredOfferIssuedResponse = Omit<OfferIssuedDto, "offerToken"> &
  Readonly<{ capabilityKeyId: string }>;

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly legalApprovals?: LegalApprovalsService,
  ) {}

  private requiredLegalApprovals(): LegalApprovalsService {
    if (!this.legalApprovals) {
      throw new Error("Legal approvals service is unavailable");
    }
    return this.legalApprovals;
  }

  async createRequest(
    input: CreateQuoteRequestDto,
    clientAddress: string,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestCreatedDto> {
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const request = validateCreateRequest(input);
    const capabilityRequests = quoteCapabilityKeyRing().all.map(
      (capabilityKey) => {
        const clientSubjectHash = anonymousQuoteClientSubject(
          capabilityKey.key,
          clientAddress,
        );
        return {
          capabilityKey,
          clientSubjectHash,
          fingerprint: fingerprintOf({
            request: {
              ...request,
              requestedDate: request.requestedDate
                ? dateOnly(request.requestedDate)
                : undefined,
            },
            clientSubjectHash,
          }),
        };
      },
    );
    const currentCapabilityRequest = capabilityRequests[0]!;
    return this.idempotent<QuoteRequestCreatedDto>(
      "quote-request.create",
      commandKey,
      capabilityRequests.map(({ fingerprint }) => fingerprint),
      async (transaction, generation) => {
        await reserveAnonymousQuote(
          transaction,
          currentCapabilityRequest.clientSubjectHash,
        );
        const observedAt = await databaseNow(transaction);
        assertEffectiveQuoteRequestLegalDocuments(
          this.requiredLegalApprovals().evaluateAt(observedAt),
          request.photoPublicationConsent,
        );
        const requestToken = capabilityToken(
          currentCapabilityRequest.capabilityKey.key,
          "quote-request",
          commandKey,
          currentCapabilityRequest.fingerprint,
          String(generation),
        );
        const requestId = randomUUID();
        const sessionId = randomUUID();
        const customerId = randomUUID();
        const resultId = randomUUID();
        const publicReference = `QR-${requestId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
        const expiresAt = addDays(observedAt, REQUEST_SESSION_DAYS);
        const slaDueAt = addBusinessHours(observedAt, 24);

        const customer = await transaction.customer.upsert({
          where: { email: request.contact.email },
          create: {
            id: customerId,
            email: request.contact.email,
            displayName: request.contact.name,
            phone: request.contact.phone ?? null,
            firstAttribution: jsonNullable(request.attribution),
            firstSeenAt: observedAt,
          },
          update: {},
        });
        await transaction.quoteSession.create({
          data: {
            id: sessionId,
            customerId: customer.id,
            publicTokenHash: hashToken(requestToken),
            capabilityKeyId: currentCapabilityRequest.capabilityKey.id,
            attribution: jsonNullable(request.attribution),
            expiresAt,
          },
        });
        await transaction.quoteRequest.create({
          data: {
            id: requestId,
            quoteSessionId: sessionId,
            customerId: customer.id,
            publicReference,
            description: request.description,
            purpose: request.purpose ?? null,
            measurements: jsonNullable(request.measurements),
            requestedDate: request.requestedDate ?? null,
            contactSnapshot: jsonInput(request.contact)!,
            photoPublicationConsentGrantedAt: request.photoPublicationConsent
              ? observedAt
              : null,
            attribution: jsonNullable(request.attribution),
            slaDueAt,
            currentStateCommandKey: commandKey,
            currentStateResultId: resultId,
            createdAt: observedAt,
            updatedAt: observedAt,
          },
        });
        if (request.automaticQuoteHandoffToken) {
          await consumeAutomaticQuoteHandoff(
            transaction,
            request.automaticQuoteHandoffToken,
            requestId,
          );
        }
        await transaction.auditEvent.create({
          data: {
            quoteRequestId: requestId,
            eventType: "quote_request.created",
            actorKind: AuditActorKind.CUSTOMER,
            actorId: customer.id,
            idempotencyKey: commandKey,
            correlationId: resultId,
            payload: jsonInput({ requestId, publicReference })!,
            createdAt: observedAt,
          },
        });
        await writeBusinessEvent(transaction, {
          eventType: "quote-request.created",
          quoteRequestId: requestId,
          quoteSessionId: sessionId,
          observedAt,
        });

        return {
          requestId,
          publicReference,
          requestToken,
          status: "NEW",
          slaDueAt: slaDueAt.toISOString(),
        } satisfies QuoteRequestCreatedDto;
      },
      {
        responseStatusCode: HttpStatus.CREATED,
        responseCodec: {
          toStoredResponse: (response, generation) => ({
            requestId: response.requestId,
            publicReference: response.publicReference,
            status: response.status,
            slaDueAt: response.slaDueAt,
            capabilityKeyId: currentCapabilityRequest.capabilityKey.id,
            capabilityTokenGeneration: generation,
          }),
          fromStoredResponse: (stored, storedFingerprint) => {
            const { capabilityKeyId, capabilityTokenGeneration, ...response } =
              stored as unknown as StoredQuoteRequestCreatedResponse;
            return {
              ...response,
              requestToken: capabilityToken(
                this.capabilityKeyForId(capabilityKeyId),
                "quote-request",
                commandKey,
                storedFingerprint,
                ...(capabilityTokenGeneration === undefined
                  ? []
                  : [String(capabilityTokenGeneration)]),
              ),
            };
          },
        },
      },
    );
  }

  async getRequest(
    requestId: string,
    authorization?: string,
  ): Promise<QuoteRequestDetailDto> {
    requestId = normalizedUuid(requestId, "requestId");
    const token = bearerCapability(authorization);
    const observedAt = await databaseNow(this.prisma);
    const request = await this.prisma.quoteRequest.findUnique({
      where: { id: requestId },
      include: { quoteSession: true, customer: true },
    });
    if (
      !request?.quoteSession ||
      request.quoteSession.expiresAt.getTime() <= observedAt.getTime() ||
      !matchesTokenHash(token, request.quoteSession.publicTokenHash)
    ) {
      throw new UnauthorizedException("Quote-request capability is invalid");
    }
    return this.requestDetail(request, observedAt);
  }

  async listRequests(
    operator: OperatorContext,
    status?: string,
  ): Promise<OperatorQuoteRequestDetailDto[]> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    const normalizedStatus = status ? parseStatus(status) : undefined;
    const observedAt = await databaseNow(this.prisma);
    const requests = await this.prisma.quoteRequest.findMany({
      where: normalizedStatus
        ? { status: normalizedStatus }
        : {
            status: {
              in: [
                QuoteRequestStatus.NEW,
                QuoteRequestStatus.IN_REVIEW,
                QuoteRequestStatus.QUOTED,
              ],
            },
          },
      include: {
        quoteSession: true,
        customer: true,
        quote: { select: { issuedAt: true } },
        automaticQuoteHandoff: true,
      },
      orderBy: [{ slaDueAt: "asc" }, { createdAt: "asc" }],
      take: 100,
    });
    return Promise.all(
      requests.map((request) =>
        this.operatorRequestDetail(request, observedAt),
      ),
    );
  }

  async listRequestsPage(
    operator: OperatorContext,
    input: OperatorQuoteRequestPageInput,
  ): Promise<OperatorQuoteRequestPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    const status = input.status ? parseStatus(input.status) : undefined;
    const sla = input.sla ? parseOperatorQueueSla(input.sla) : undefined;
    const limit = operatorQueuePageLimit(input.limit);
    const filterHash = fingerprintOf({ status, sla });
    const cursor = input.cursor
      ? parseOperatorQueueCursor(input.cursor, filterHash)
      : undefined;
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
        const observedAt = await databaseNow(transaction);
        const statusFilter = status
          ? Prisma.sql`AND request.status = ${status}::quote_request_status`
          : Prisma.sql`
          AND request.status IN (
            'NEW'::quote_request_status,
            'IN_REVIEW'::quote_request_status,
            'QUOTED'::quote_request_status
          )
        `;
        const slaFilter = operatorQueueSlaFilter(sla, observedAt);
        const keyset = cursor
          ? Prisma.sql`
          AND (request.sla_due_at, request.created_at, request.id) > (
            ${new Date(cursor.slaDueAt)}::timestamptz,
            ${new Date(cursor.createdAt)}::timestamptz,
            ${cursor.id}::uuid
          )
        `
          : Prisma.empty;
        const keys = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT request.id
      FROM quote_requests AS request
      LEFT JOIN quotes AS quote ON quote.quote_request_id = request.id
      WHERE TRUE
        ${statusFilter}
        ${slaFilter}
        ${keyset}
      ORDER BY request.sla_due_at ASC, request.created_at ASC, request.id ASC
      LIMIT ${limit + 1}
    `;
        const requests = await transaction.quoteRequest.findMany({
          where: { id: { in: keys.map((key) => key.id) } },
          include: {
            quoteSession: true,
            customer: true,
            quote: { select: { issuedAt: true } },
            automaticQuoteHandoff: true,
          },
        });
        const byId = new Map(requests.map((request) => [request.id, request]));
        const page = keys
          .slice(0, limit)
          .map((key) => byId.get(key.id))
          .filter(
            (request): request is (typeof requests)[number] =>
              request !== undefined,
          );
        const last = page.at(-1);
        const attachments = await transaction.photoAsset.findMany({
          where: {
            scopeKind: PhotoScopeKind.QUOTE_REQUEST,
            scopeId: { in: page.map((request) => request.id) },
            deletedAt: null,
          },
          orderBy: { uploadedAt: "asc" },
        });
        const attachmentsByRequest = groupAttachmentsByRequest(attachments);
        return {
          items: await Promise.all(
            page.map((request) =>
              this.operatorRequestDetail(
                request,
                observedAt,
                attachmentsByRequest.get(request.id) ?? [],
              ),
            ),
          ),
          ...(keys.length > limit && last
            ? {
                nextCursor: encodeOperatorQueueCursor({
                  slaDueAt: last.slaDueAt.toISOString(),
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                  filterHash,
                }),
              }
            : {}),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async getOperatorRequest(
    operator: OperatorContext,
    requestId: string,
  ): Promise<OperatorQuoteRequestDetailDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    requestId = normalizedUuid(requestId, "requestId");
    const observedAt = await databaseNow(this.prisma);
    const request = await this.prisma.quoteRequest.findUnique({
      where: { id: requestId },
      include: {
        quoteSession: true,
        customer: true,
        quote: { select: { issuedAt: true } },
        automaticQuoteHandoff: true,
      },
    });
    if (!request) throw new NotFoundException("Quote request was not found");
    return this.operatorRequestDetail(request, observedAt);
  }

  async beginReview(
    operator: OperatorContext,
    requestId: string,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestStatusDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.QUOTES_WRITE);
    const nodeId = operatorNode(operator);
    requestId = normalizedUuid(requestId, "requestId");
    const commandKey = requireIdempotencyKey(idempotencyKey);
    return this.idempotent<QuoteRequestStatusDto>(
      "quote-request.review",
      commandKey,
      fingerprintOf({ requestId }),
      async (transaction) => {
        const request = await lockedRequest(transaction, requestId);
        if (!request)
          throw new NotFoundException("Quote request was not found");
        if (request.status !== QuoteRequestStatus.NEW) {
          throw new ConflictException("Quote request is not new");
        }
        await applyTransition(
          request,
          QuoteRequestStatus.IN_REVIEW,
          commandKey,
          undefined,
        );
        const observedAt = await databaseNow(transaction);
        const resultId = randomUUID();
        await transaction.quoteRequest.update({
          where: { id: requestId },
          data: {
            status: QuoteRequestStatus.IN_REVIEW,
            currentStateCommandKey: commandKey,
            currentStateResultId: resultId,
            updatedAt: observedAt,
          },
        });
        await this.audit.recordOperator(transaction, operator, {
          quoteRequestId: requestId,
          nodeId,
          createdAt: observedAt,
          eventType: "quote_request.review_started",
          idempotencyKey: commandKey,
          correlationId: resultId,
          payload: { operation: "review", status: "IN_REVIEW" },
        });
        return { requestId, status: "IN_REVIEW" };
      },
      {
        beforeReplay: async () => {
          requireOperatorPermission(
            operator,
            OPERATOR_PERMISSIONS.QUOTES_WRITE,
          );
          operatorNode(operator);
        },
      },
    );
  }

  async issueOffer(
    operator: OperatorContext,
    requestId: string,
    input: IssueOfferDto,
    idempotencyKey: string | undefined,
  ): Promise<OfferIssuedDto> {
    assertBindingQuoteFlowsEnabled();
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.QUOTES_WRITE);
    const nodeId = operatorNode(operator);
    requestId = normalizedUuid(requestId, "requestId");
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const offer = validateOffer(input);
    const fingerprint = fingerprintOf({ requestId, ...offer.fingerprint });
    const offerCapabilityKey = this.currentCapabilityKey();

    return this.idempotent<OfferIssuedDto>(
      "quote-request.issue-offer",
      commandKey,
      fingerprint,
      async (transaction) => {
        const request = await lockedRequest(transaction, requestId);
        if (!request)
          throw new NotFoundException("Quote request was not found");
        if (
          request.status !== QuoteRequestStatus.IN_REVIEW ||
          !request.customerId
        ) {
          throw new ConflictException(
            "Quote request is not ready for an offer",
          );
        }
        const observedAt = await databaseNow(transaction);
        if (offer.expiresAt.getTime() <= observedAt.getTime()) {
          throw new BadRequestException("expiresAt must be in the future");
        }
        const priceList = await transaction.priceList.findUnique({
          where: { id: offer.priceListId },
        });
        if (!priceList) throw new BadRequestException("priceListId is invalid");
        const termsRevision = requiredText(
          priceList.termsRevision,
          "priceList.termsRevision",
          100,
        );
        if (termsRevision !== priceList.termsRevision) {
          throw new BadRequestException(
            "priceListId has a non-canonical terms revision",
          );
        }
        if (priceList.currency !== "CZK") {
          throw new BadRequestException("Individual v0 offers must use CZK");
        }
        let configuredTaxPolicy;
        try {
          configuredTaxPolicy = parseSellerTaxPolicy(priceList.parameters);
        } catch {
          throw new BadRequestException(
            "priceListId has no valid seller tax policy",
          );
        }
        if (
          configuredTaxPolicy.regime !== offer.taxRegime ||
          configuredTaxPolicy.vatRateBasisPoints !== offer.vatRateBasisPoints
        ) {
          throw new BadRequestException(
            "Offer tax treatment must match the selected price list",
          );
        }
        if (
          !(await individualSplitPaymentPolicyIsValid(
            transaction,
            priceList.id,
          ))
        ) {
          throw new BadRequestException(
            "priceListId does not support individual split payments",
          );
        }
        await validateOfferItemReferences(transaction, offer.items, observedAt);

        const quoteId = randomUUID();
        const resultId = randomUUID();
        const offerToken = capabilityToken(
          offerCapabilityKey.key,
          "quote-offer",
          quoteId,
          commandKey,
        );
        const issuedAt = observedAt;
        const quoteItems = offer.items.map((item, ordinal) => ({
          ...item,
          id: randomUUID(),
          ordinal,
        }));
        const quoteDeliveryDestination = {
          ...offer.deliveryDestination,
          id: randomUUID(),
        };
        const quoteShipmentPlans = offer.shipmentPlans.map((plan, ordinal) => ({
          ...plan,
          id: randomUUID(),
          ordinal,
        }));
        const snapshotId = randomUUID();
        const snapshotHash = fingerprintOf({
          quoteId,
          priceListId: priceList.id,
          pricingRevision: priceList.revision,
          inputSnapshot: offer.inputSnapshot,
          deliveryDestination: offer.deliveryDestination,
          shipmentPlans: offer.shipmentPlans,
          paymentPolicy: offer.paymentPolicy,
          items: offer.fingerprint.items,
          components: offer.fingerprint.components,
          contractTotalMinor: offer.contractTotalMinor,
          taxRegime: offer.taxRegime,
          vatRateBasisPoints: offer.vatRateBasisPoints,
          netAmountMinor: offer.netAmountMinor,
          vatAmountMinor: offer.vatAmountMinor,
          depositMinor: offer.depositMinor,
        });

        await applyIssuanceTransition(request, {
          commandKey,
          quoteId,
          resultId,
          issuedAt,
          expiresAt: offer.expiresAt,
        });

        await transaction.quoteRequest.update({
          where: { id: requestId },
          data: {
            status: QuoteRequestStatus.QUOTED,
            slaRespondedAt: issuedAt,
            currentStateCommandKey: commandKey,
            currentStateResultId: resultId,
            updatedAt: issuedAt,
          },
        });

        await transaction.quote.create({
          data: {
            id: quoteId,
            quoteRequestId: requestId,
            customerId: request.customerId,
            publicTokenHash: hashToken(offerToken),
            capabilityKeyId: offerCapabilityKey.id,
            version: 1,
            summary: offer.summary,
            termsRevision,
            termsSnapshot: jsonInput(offer.termsSnapshot)!,
            promisedDate: offer.promisedDate ?? null,
            issuanceCommandKey: commandKey,
            issuanceResultId: resultId,
            expiresAt: offer.expiresAt,
            issuedAt,
            createdAt: issuedAt,
          },
        });
        const quoteItemRows = quoteItems.map(
          (item) =>
            ({
              id: item.id,
              quoteId,
              ordinal: item.ordinal,
              sourceModelFileId: item.sourceModelFileId,
              modelGeometryId: item.modelGeometryId,
              printConfigRevisionId: item.printConfigRevisionId,
              primaryReferenceSliceResultId:
                item.primaryReferenceSliceResultId ?? null,
              tailReferenceSliceResultId:
                item.tailReferenceSliceResultId ?? null,
              referencePartsPerPlate: item.referencePartsPerPlate ?? null,
              material: item.material ?? null,
              color: item.color ?? null,
              quantity: item.quantity,
              createdAt: issuedAt,
            }) satisfies Prisma.QuoteItemCreateManyInput,
        );
        for (const batch of batchesOf(quoteItemRows)) {
          await transaction.quoteItem.createMany({ data: batch });
        }
        await transaction.priceSnapshot.create({
          data: {
            id: snapshotId,
            priceListId: priceList.id,
            currency: priceList.currency,
            contractTotalMinor: BigInt(offer.contractTotalMinor),
            taxRegime: offer.taxRegime,
            vatRateBasisPoints: offer.vatRateBasisPoints,
            netAmountMinor: BigInt(offer.netAmountMinor),
            vatAmountMinor: BigInt(offer.vatAmountMinor),
            pricingRevision: priceList.revision,
            inputSnapshot: jsonInput({
              ...offer.inputSnapshot,
              quoteRequestId: requestId,
              quoteVersion: 1,
              deliveryDestination: offer.deliveryDestination,
              shipmentPlans: offer.shipmentPlans,
              paymentPolicy: offer.paymentPolicy,
            })!,
            snapshotHash,
            createdAt: issuedAt,
          },
        });
        await transaction.quotePriceBinding.create({
          data: { quoteId, priceSnapshotId: snapshotId },
        });
        await writeBusinessEvent(transaction, {
          eventType: "quote.bound",
          bindingId: quoteId,
          quoteId,
          observedAt: issuedAt,
        });
        await transaction.quoteDeliveryDestination.create({
          data: {
            id: quoteDeliveryDestination.id,
            quoteId,
            providerEndpointId: quoteDeliveryDestination.providerEndpointId,
            endpointType: quoteDeliveryDestination.endpointType,
            addressSnapshot: jsonInput(
              quoteDeliveryDestination.addressSnapshot,
            )!,
            capabilitySnapshot: jsonInput(
              quoteDeliveryDestination.capabilitySnapshot,
            )!,
            createdAt: issuedAt,
          },
        });
        const quoteShipmentPlanRows = quoteShipmentPlans.map(
          (plan) =>
            ({
              id: plan.id,
              quoteId,
              priceSnapshotId: snapshotId,
              quoteDeliveryDestinationId: quoteDeliveryDestination.id,
              ordinal: plan.ordinal,
              category: plan.category,
              plannedVolumeCubicMm: BigInt(plan.plannedVolumeCubicMm),
              plannedWeightMilligrams: BigInt(plan.plannedWeightMilligrams),
              shippingAmountMinor: BigInt(plan.shippingAmountMinor),
              packagingAmountMinor: BigInt(plan.packagingAmountMinor),
              handlingAmountMinor: BigInt(plan.handlingAmountMinor),
              allocationSnapshot: jsonInput({
                packingUnits: plan.packingUnits,
                details: plan.allocationSnapshot ?? {},
              })!,
              createdAt: issuedAt,
            }) satisfies Prisma.QuoteShipmentPlanCreateManyInput,
        );
        for (const batch of batchesOf(quoteShipmentPlanRows)) {
          await transaction.quoteShipmentPlan.createMany({ data: batch });
        }
        const priceComponents = offer.components.map((component) => {
          const quoteItem =
            component.quoteItemOrdinal === undefined
              ? undefined
              : quoteItems[component.quoteItemOrdinal];
          const quoteShipmentPlan =
            component.quoteShipmentPlanOrdinal === undefined
              ? undefined
              : quoteShipmentPlans[component.quoteShipmentPlanOrdinal];
          return {
            id: randomUUID(),
            priceSnapshotId: snapshotId,
            kind: component.kind,
            scope: quoteItem
              ? PriceComponentScope.QUOTE_ITEM
              : quoteShipmentPlan
                ? PriceComponentScope.QUOTE_SHIPMENT_PLAN
                : PriceComponentScope.ORDER,
            quoteItemId: quoteItem?.id ?? null,
            quoteShipmentPlanId: quoteShipmentPlan?.id ?? null,
            amountMinor: BigInt(component.amountMinor),
            allocation: jsonNullable(component.allocation),
            createdAt: issuedAt,
          } satisfies Prisma.PriceSnapshotComponentCreateManyInput;
        });
        for (const batch of batchesOf(priceComponents)) {
          await transaction.priceSnapshotComponent.createMany({ data: batch });
        }
        await transaction.paymentSchedule.createMany({
          data: [
            {
              id: randomUUID(),
              priceSnapshotId: snapshotId,
              sequence: 0,
              role: PaymentRole.DEPOSIT,
              grossAmountMinor: BigInt(offer.depositMinor),
              feeRateBasisPoints:
                offer.paymentPolicy.deposit.feeRateBasisPoints,
              feeFixedMinor: BigInt(offer.paymentPolicy.deposit.feeFixedMinor),
              providerConfig: jsonInput(
                offer.paymentPolicy.deposit.providerConfig,
              )!,
              createdAt: issuedAt,
            },
            {
              id: randomUUID(),
              priceSnapshotId: snapshotId,
              sequence: 1,
              role: PaymentRole.BALANCE,
              grossAmountMinor: BigInt(
                offer.contractTotalMinor - offer.depositMinor,
              ),
              feeRateBasisPoints:
                offer.paymentPolicy.balance.feeRateBasisPoints,
              feeFixedMinor: BigInt(offer.paymentPolicy.balance.feeFixedMinor),
              providerConfig: jsonInput(
                offer.paymentPolicy.balance.providerConfig,
              )!,
              createdAt: issuedAt,
            },
          ],
        });
        await this.audit.recordOperator(transaction, operator, {
          quoteRequestId: requestId,
          quoteId,
          nodeId,
          createdAt: issuedAt,
          eventType: "quote_offer.issued",
          idempotencyKey: commandKey,
          correlationId: resultId,
          payload: { operation: "issue_offer", status: "QUOTED", version: 1 },
        });
        await transaction.outboxMessage.create({
          data: {
            deduplicationKey: `quote-offer-issued:${quoteId}:1`,
            aggregateType: "Quote",
            aggregateId: quoteId,
            messageType: "email.quote-offer-issued",
            schemaVersion: 1,
            payload: jsonInput({
              requestId,
              quoteId,
              version: 1,
              recipient: contactFrom(request.contactSnapshot, undefined).email,
              offerTokenDerivation: {
                quoteId,
                issuanceCommandKey: commandKey,
                capabilityKeyId: offerCapabilityKey.id,
              },
              expiresAt: offer.expiresAt.toISOString(),
            })!,
            createdAt: issuedAt,
            updatedAt: issuedAt,
          },
        });

        return {
          quoteId,
          version: 1,
          termsRevision,
          offerToken,
          expiresAt: offer.expiresAt.toISOString(),
        } satisfies OfferIssuedDto;
      },
      {
        responseStatusCode: HttpStatus.CREATED,
        responseCodec: {
          toStoredResponse: (response) => ({
            quoteId: response.quoteId,
            version: response.version,
            termsRevision: response.termsRevision,
            expiresAt: response.expiresAt,
            capabilityKeyId: offerCapabilityKey.id,
          }),
          fromStoredResponse: (stored) => {
            const { capabilityKeyId, ...response } =
              stored as unknown as StoredOfferIssuedResponse;
            return {
              ...response,
              offerToken: capabilityToken(
                this.capabilityKeyForId(capabilityKeyId),
                "quote-offer",
                response.quoteId,
                commandKey,
              ),
            };
          },
        },
        beforeReplay: async () => {
          requireOperatorPermission(
            operator,
            OPERATOR_PERMISSIONS.QUOTES_WRITE,
          );
          operatorNode(operator);
        },
      },
    );
  }

  async previewOffer(
    quoteId: string,
    authorization?: string,
  ): Promise<OfferPreviewDto> {
    quoteId = normalizedUuid(quoteId, "quoteId");
    const token = bearerCapability(authorization);
    const observedAt = await databaseNow(this.prisma);
    const quote = await this.offerForToken(quoteId, token);
    if (quote.expiresAt.getTime() <= observedAt.getTime()) {
      await this.expireOverdueOffer(quoteId);
      throw new GoneException("Offer is no longer available");
    }
    if (quote.quoteRequest.status !== QuoteRequestStatus.QUOTED) {
      throw new GoneException("Offer is no longer available");
    }
    const snapshot = quote.priceBinding?.priceSnapshot;
    if (!snapshot) throw new ConflictException("Offer price is unavailable");
    const itemOrdinals = new Map(
      quote.items.map((item) => [item.id, item.ordinal]),
    );
    const shipmentPlanOrdinals = new Map(
      quote.shipmentPlans.map((plan) => [plan.id, plan.ordinal]),
    );
    const components = snapshot.components
      .map((component) => {
        if (
          !ITEM_COMPONENTS.has(component.kind) &&
          !ORDER_COMPONENTS.has(component.kind) &&
          component.kind !== PriceComponentKind.SHIPMENT &&
          component.kind !== PriceComponentKind.PAYMENT_FEE &&
          component.kind !== PriceComponentKind.VAT
        ) {
          throw new ConflictException("Offer price component kind is invalid");
        }
        if (
          component.scope !== PriceComponentScope.ORDER &&
          component.scope !== PriceComponentScope.QUOTE_ITEM &&
          component.scope !== PriceComponentScope.QUOTE_SHIPMENT_PLAN
        ) {
          throw new ConflictException("Offer price component scope is invalid");
        }
        const quoteItemOrdinal = component.quoteItemId
          ? itemOrdinals.get(component.quoteItemId)
          : undefined;
        const shipmentPlanOrdinal = component.quoteShipmentPlanId
          ? shipmentPlanOrdinals.get(component.quoteShipmentPlanId)
          : undefined;
        if (
          component.scope === PriceComponentScope.QUOTE_ITEM &&
          quoteItemOrdinal === undefined
        ) {
          throw new ConflictException(
            "Offer price component item is unavailable",
          );
        }
        if (
          component.scope === PriceComponentScope.QUOTE_SHIPMENT_PLAN &&
          shipmentPlanOrdinal === undefined
        ) {
          throw new ConflictException(
            "Offer price component shipment plan is unavailable",
          );
        }
        return {
          kind: component.kind as OfferPreviewPriceComponentDto["kind"],
          scope: component.scope as OfferPreviewPriceComponentDto["scope"],
          quoteItemOrdinal: quoteItemOrdinal ?? null,
          shipmentPlanOrdinal: shipmentPlanOrdinal ?? null,
          amountMinor: safeNumber(component.amountMinor),
          allocation: nullableJsonObject(component.allocation),
        };
      })
      .sort(
        (left, right) =>
          (left.quoteItemOrdinal ?? Number.MAX_SAFE_INTEGER) -
            (right.quoteItemOrdinal ?? Number.MAX_SAFE_INTEGER) ||
          (left.shipmentPlanOrdinal ?? Number.MAX_SAFE_INTEGER) -
            (right.shipmentPlanOrdinal ?? Number.MAX_SAFE_INTEGER) ||
          OFFER_COMPONENT_ORDER.indexOf(left.kind) -
            OFFER_COMPONENT_ORDER.indexOf(right.kind),
      );
    return {
      quoteId: quote.id,
      version: quote.version,
      termsRevision: quote.termsRevision,
      summary: quote.summary,
      termsSnapshot: jsonObject(quote.termsSnapshot),
      currency: snapshot.currency,
      contractTotalMinor: safeNumber(snapshot.contractTotalMinor),
      taxRegime: snapshot.taxRegime,
      vatRateBasisPoints: snapshot.vatRateBasisPoints,
      netAmountMinor: safeNumber(snapshot.netAmountMinor),
      vatAmountMinor: safeNumber(snapshot.vatAmountMinor),
      items: quote.items.map((item) => ({
        ordinal: item.ordinal,
        kind: "MODEL" as const,
        sourceModelFileId: item.sourceModelFileId,
        modelGeometryId: item.modelGeometryId,
        printConfigRevisionId: item.printConfigRevisionId,
        primaryReferenceSliceResultId: item.primaryReferenceSliceResultId,
        tailReferenceSliceResultId: item.tailReferenceSliceResultId,
        referencePartsPerPlate: item.referencePartsPerPlate,
        material: item.material,
        color: item.color,
        quantity: item.quantity,
      })),
      deliveryDestination: offerDeliveryDestinationDto(
        quote.deliveryDestination,
      ),
      shipmentPlans: quote.shipmentPlans.map(offerShipmentPlanDto),
      components,
      paymentSchedules: snapshot.paymentSchedules.map((schedule) => {
        if (
          schedule.role !== PaymentRole.DEPOSIT &&
          schedule.role !== PaymentRole.BALANCE
        ) {
          throw new ConflictException("Offer payment schedule is invalid");
        }
        return {
          sequence: schedule.sequence,
          role: schedule.role,
          grossAmountMinor: safeNumber(schedule.grossAmountMinor),
          feeRateBasisPoints: schedule.feeRateBasisPoints,
          feeFixedMinor: safeNumber(schedule.feeFixedMinor),
        } satisfies OfferPaymentScheduleDto;
      }),
      expiresAt: quote.expiresAt.toISOString(),
      promisedDate: dateOnly(quote.promisedDate),
    };
  }

  async acceptOffer(
    quoteId: string,
    input: AcceptOfferDto,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AcceptedOfferDto> {
    quoteId = normalizedUuid(quoteId, "quoteId");
    const token = bearerCapability(authorization);
    const expected = validateExpectedOffer(input);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    await this.offerForToken(quoteId, token);
    assertBindingQuoteFlowsEnabled();
    const result = await this.idempotent<ExpiringResult<AcceptedOfferDto>>(
      "quote-offer.accept",
      commandKey,
      fingerprintOf({ quoteId, ...expected }),
      async (transaction) => {
        const quote = await lockedOffer(transaction, quoteId);
        assertOfferCapability(quote, token);
        assertExpectedOffer(quote, expected);
        if (quote.quoteRequest.status === QuoteRequestStatus.ACCEPTED) {
          throw new ConflictException("Offer was already accepted");
        }
        if (quote.quoteRequest.status !== QuoteRequestStatus.QUOTED) {
          throw new GoneException("Offer is no longer available");
        }
        if (!quote.priceBinding?.priceSnapshot.sealedAt) {
          throw new ConflictException("Offer price is not sealed");
        }
        if (!quote.deliveryDestination || quote.shipmentPlans.length < 1) {
          throw new ConflictException("Offer shipment topology is unavailable");
        }

        const orderId = randomUUID();
        const resultId = randomUUID();
        const publicReference = `I-${orderId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
        const acceptance = await acceptLockedQuoteRequest(
          transaction,
          quote.quoteRequestId,
          commandKey,
          resultId,
        );
        if (!acceptance.accepted_at) {
          await expireLockedOffer(transaction, quote, acceptance.evaluated_at);
          return { kind: "expired" };
        }
        const observedAt = acceptance.accepted_at;
        const approvals = this.requiredLegalApprovals().evaluateAt(observedAt);
        assertEffectiveLegalDocuments(approvals, [
          "terms",
          "claims",
          "privacy",
          "prohibitedContent",
          "retention",
        ]);
        if (quote.termsRevision !== approvals.documents.terms.revision) {
          throw new ConflictException(
            "Offer terms revision is no longer approved",
          );
        }
        await applyAcceptanceTransition(quote, {
          commandKey,
          orderId,
          resultId,
          evaluatedAt: observedAt,
        });

        await transaction.order.create({
          data: {
            id: orderId,
            customerId: quote.customerId,
            publicReference,
            createdAt: observedAt,
            updatedAt: observedAt,
          },
        });
        await transaction.individualOrderOrigin.create({
          data: { orderId, quoteId },
        });
        const orderItemsByQuoteOrdinal = new Map<
          number,
          { id: string; quantity: number }
        >();
        const orderItems = quote.items.map((quoteItem) => {
          const orderItemId = randomUUID();
          orderItemsByQuoteOrdinal.set(quoteItem.ordinal, {
            id: orderItemId,
            quantity: quoteItem.quantity,
          });
          return {
            id: orderItemId,
            orderId,
            ordinal: quoteItem.ordinal,
            sourceModelFileId: quoteItem.sourceModelFileId,
            modelGeometryId: quoteItem.modelGeometryId,
            printConfigRevisionId: quoteItem.printConfigRevisionId,
            primaryReferenceSliceResultId:
              quoteItem.primaryReferenceSliceResultId,
            tailReferenceSliceResultId: quoteItem.tailReferenceSliceResultId,
            referencePartsPerPlate: quoteItem.referencePartsPerPlate,
            material: quoteItem.material,
            color: quoteItem.color,
            quantity: quoteItem.quantity,
            createdAt: observedAt,
          } satisfies Prisma.OrderItemCreateManyInput;
        });
        for (const batch of batchesOf(orderItems)) {
          await transaction.orderItem.createMany({ data: batch });
        }
        const individualSources = quote.items.map((quoteItem) => ({
          orderItemId: orderItemsByQuoteOrdinal.get(quoteItem.ordinal)!.id,
          quoteItemId: quoteItem.id,
        }));
        for (const batch of batchesOf(individualSources)) {
          await transaction.individualOrderItemSource.createMany({
            data: batch,
          });
        }
        const orderPhaseId = randomUUID();
        const deliveryDestinationId = randomUUID();
        const orderPriceBindingId = randomUUID();
        await transaction.orderPhase.create({
          data: {
            id: orderPhaseId,
            orderId,
            kind: "SINGLE",
            status: "QUOTED",
            createdAt: observedAt,
            updatedAt: observedAt,
          },
        });
        const fulfilmentSlotsByPackingUnit = new Map<string, string>();
        const fulfilmentSlots: Prisma.FulfilmentSlotCreateManyInput[] = [];
        for (const [quoteItemOrdinal, orderItem] of orderItemsByQuoteOrdinal) {
          for (
            let quantityOrdinal = 1;
            quantityOrdinal <= orderItem.quantity;
            quantityOrdinal += 1
          ) {
            const slotId = randomUUID();
            fulfilmentSlots.push({
              id: slotId,
              orderId,
              orderPhaseId,
              orderItemId: orderItem.id,
              quantityOrdinal,
              packingUnitKey: `${orderItem.id}:single:${quantityOrdinal}`,
              settlementAmountMinor: BigInt(0),
              createdAt: observedAt,
              updatedAt: observedAt,
            });
            fulfilmentSlotsByPackingUnit.set(
              `${quoteItemOrdinal}:${quantityOrdinal}`,
              slotId,
            );
          }
        }
        for (const batch of batchesOf(fulfilmentSlots)) {
          await transaction.fulfilmentSlot.createMany({ data: batch });
        }
        await transaction.deliveryDestination.create({
          data: {
            id: deliveryDestinationId,
            orderId,
            providerEndpointId: quote.deliveryDestination.providerEndpointId,
            endpointType: quote.deliveryDestination.endpointType,
            addressSnapshot: jsonInput(
              quote.deliveryDestination.addressSnapshot,
            )!,
            capabilitySnapshot: jsonInput(
              quote.deliveryDestination.capabilitySnapshot,
            )!,
            createdAt: observedAt,
          },
        });
        await transaction.orderPriceBinding.create({
          data: {
            id: orderPriceBindingId,
            orderId,
            priceSnapshotId: quote.priceBinding.priceSnapshot.id,
            deliveryDestinationId,
            createdAt: observedAt,
          },
        });
        const shipmentPlans: Prisma.ShipmentPlanCreateManyInput[] = [];
        const shipmentPlanSlots: Prisma.ShipmentPlanFulfilmentSlotCreateManyInput[] =
          [];
        for (const quoteShipmentPlan of quote.shipmentPlans) {
          const shipmentPlanId = randomUUID();
          shipmentPlans.push({
            id: shipmentPlanId,
            orderId,
            orderPhaseId,
            priceSnapshotId: quote.priceBinding.priceSnapshot.id,
            orderPriceBindingId,
            deliveryDestinationId,
            quoteShipmentPlanId: quoteShipmentPlan.id,
            ordinal: quoteShipmentPlan.ordinal,
            category: quoteShipmentPlan.category,
            plannedVolumeCubicMm: quoteShipmentPlan.plannedVolumeCubicMm,
            plannedWeightMilligrams: quoteShipmentPlan.plannedWeightMilligrams,
            shippingAmountMinor: quoteShipmentPlan.shippingAmountMinor,
            packagingAmountMinor: quoteShipmentPlan.packagingAmountMinor,
            handlingAmountMinor: quoteShipmentPlan.handlingAmountMinor,
            allocationSnapshot: jsonInput(
              quoteShipmentPlan.allocationSnapshot,
            )!,
            createdAt: observedAt,
          });
          for (const packingUnit of offerShipmentPlanDto(quoteShipmentPlan)
            .packingUnits) {
            const fulfilmentSlotId = fulfilmentSlotsByPackingUnit.get(
              `${packingUnit.quoteItemOrdinal}:${packingUnit.quantityOrdinal}`,
            );
            if (!fulfilmentSlotId) {
              throw new ConflictException(
                "Offer shipment allocation is unavailable",
              );
            }
            shipmentPlanSlots.push({
              shipmentPlanId,
              orderPriceBindingId,
              fulfilmentSlotId,
            });
          }
        }
        for (const batch of batchesOf(shipmentPlans)) {
          await transaction.shipmentPlan.createMany({ data: batch });
        }
        for (const batch of batchesOf(shipmentPlanSlots)) {
          await transaction.shipmentPlanFulfilmentSlot.createMany({
            data: batch,
          });
        }
        await transaction.orderActivePriceBinding.create({
          data: { orderId, orderPriceBindingId },
        });
        const sourceModelFileIds = [
          ...new Set(
            quote.items.flatMap((item) =>
              item.sourceModelFileId ? [item.sourceModelFileId] : [],
            ),
          ),
        ];
        if (sourceModelFileIds.length > 0) {
          await transaction.modelFile.updateMany({
            where: {
              id: { in: sourceModelFileIds },
              deletedAt: null,
              retentionHold: RetentionHold.NONE,
            },
            data: { retentionHold: RetentionHold.ACTIVE_ORDER },
          });
        }
        if (quote.quoteRequest.quoteSessionId) {
          await transaction.quoteSession.updateMany({
            where: {
              id: quote.quoteRequest.quoteSessionId,
              status: QuoteSessionStatus.OPEN,
            },
            data: {
              status: QuoteSessionStatus.CONVERTED,
              updatedAt: observedAt,
            },
          });
        }
        await transaction.photoAsset.updateMany({
          where: {
            scopeKind: PhotoScopeKind.QUOTE_REQUEST,
            scopeId: quote.quoteRequestId,
            deletedAt: null,
            retentionHold: RetentionHold.NONE,
          },
          data: { retentionHold: RetentionHold.ACTIVE_ORDER },
        });
        await transaction.auditEvent.create({
          data: {
            quoteId,
            orderId,
            eventType: "quote_offer.accepted",
            actorKind: AuditActorKind.CUSTOMER,
            actorId: quote.customerId,
            idempotencyKey: commandKey,
            correlationId: resultId,
            payload: jsonInput({
              quoteId,
              requestId: quote.quoteRequestId,
              orderId,
              version: quote.version,
              termsRevision: quote.termsRevision,
            })!,
            createdAt: observedAt,
          },
        });
        await transaction.outboxMessage.create({
          data: {
            deduplicationKey: `quote-offer-accepted:${quoteId}`,
            aggregateType: "Quote",
            aggregateId: quoteId,
            messageType: "email.quote-offer-accepted",
            schemaVersion: 1,
            payload: jsonInput({ quoteId, orderId, publicReference })!,
            createdAt: observedAt,
            updatedAt: observedAt,
          },
        });
        return {
          kind: "ok",
          value: { orderId, publicReference, status: "DRAFT" },
        };
      },
      {
        responseStatusCode: (response) =>
          response.kind === "expired" ? HttpStatus.GONE : HttpStatus.OK,
      },
    );
    if (result.kind === "expired") {
      throw new GoneException("Offer is no longer available");
    }
    return result.value;
  }

  async rejectOffer(
    quoteId: string,
    input: RejectOfferDto,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestStatusDto> {
    quoteId = normalizedUuid(quoteId, "quoteId");
    const token = bearerCapability(authorization);
    const expected = validateExpectedOffer(input);
    const reason = optionalText(input.reason, "reason", 2_000);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    await this.offerForToken(quoteId, token);
    const result = await this.idempotent<ExpiringResult<QuoteRequestStatusDto>>(
      "quote-offer.reject",
      commandKey,
      fingerprintOf({ quoteId, ...expected, reason }),
      async (transaction) => {
        const quote = await lockedOffer(transaction, quoteId);
        assertOfferCapability(quote, token);
        assertExpectedOffer(quote, expected);
        const observedAt = await databaseNow(transaction);
        if (
          quote.quoteRequest.status === QuoteRequestStatus.QUOTED &&
          quote.expiresAt.getTime() <= observedAt.getTime()
        ) {
          await expireLockedOffer(transaction, quote, observedAt);
          return { kind: "expired" };
        }
        if (quote.quoteRequest.status !== QuoteRequestStatus.QUOTED) {
          throw new GoneException("Offer is no longer available");
        }
        await applyTransition(
          quote.quoteRequest,
          QuoteRequestStatus.REJECTED,
          commandKey,
          undefined,
        );
        const resultId = randomUUID();
        await transaction.quoteRequest.update({
          where: { id: quote.quoteRequestId },
          data: {
            status: QuoteRequestStatus.REJECTED,
            rejectedAt: observedAt,
            rejectionReason: reason ?? null,
            currentStateCommandKey: commandKey,
            currentStateResultId: resultId,
            updatedAt: observedAt,
          },
        });
        await transaction.auditEvent.create({
          data: {
            quoteId,
            eventType: "quote_offer.rejected",
            actorKind: AuditActorKind.CUSTOMER,
            actorId: quote.customerId,
            idempotencyKey: commandKey,
            correlationId: resultId,
            payload: jsonInput({ quoteId, reason })!,
            createdAt: observedAt,
          },
        });
        await transaction.outboxMessage.create({
          data: {
            deduplicationKey: `quote-offer-rejected:${quoteId}`,
            aggregateType: "Quote",
            aggregateId: quoteId,
            messageType: "email.quote-offer-rejected",
            schemaVersion: 1,
            payload: jsonInput({ quoteId, reason })!,
            createdAt: observedAt,
            updatedAt: observedAt,
          },
        });
        return {
          kind: "ok",
          value: {
            requestId: quote.quoteRequestId,
            status: "REJECTED",
          },
        };
      },
      {
        responseStatusCode: (response) =>
          response.kind === "expired" ? HttpStatus.GONE : HttpStatus.OK,
      },
    );
    if (result.kind === "expired") {
      throw new GoneException("Offer is no longer available");
    }
    return result.value;
  }

  async expireOffer(
    operator: OperatorContext,
    requestId: string,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestStatusDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.QUOTES_WRITE);
    const nodeId = operatorNode(operator);
    requestId = normalizedUuid(requestId, "requestId");
    const commandKey = requireIdempotencyKey(idempotencyKey);
    return this.idempotent(
      "quote-request.expire",
      commandKey,
      fingerprintOf({ requestId }),
      async (transaction) => {
        const request = await lockedRequest(transaction, requestId);
        if (!request)
          throw new NotFoundException("Quote request was not found");
        const quote = await transaction.quote.findUnique({
          where: { quoteRequestId: requestId },
          include: { quoteRequest: true },
        });
        if (!quote || request.status !== QuoteRequestStatus.QUOTED) {
          throw new ConflictException("Quote request has no active offer");
        }
        const observedAt = await databaseNow(transaction);
        if (quote.expiresAt.getTime() > observedAt.getTime()) {
          throw new ConflictException("Offer has not expired");
        }
        await expireLockedOffer(transaction, quote, observedAt, commandKey, {
          audit: this.audit,
          operator,
          nodeId,
        });
        return { requestId, status: "EXPIRED" };
      },
      {
        beforeReplay: async () => {
          requireOperatorPermission(
            operator,
            OPERATOR_PERMISSIONS.QUOTES_WRITE,
          );
          operatorNode(operator);
        },
      },
    );
  }

  private async offerForToken(quoteId: string, token: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        quoteRequest: true,
        items: { orderBy: { ordinal: "asc" } },
        deliveryDestination: true,
        shipmentPlans: { orderBy: { ordinal: "asc" } },
        priceBinding: {
          include: {
            priceSnapshot: {
              include: {
                components: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
                paymentSchedules: { orderBy: { sequence: "asc" } },
              },
            },
          },
        },
      },
    });
    assertOfferCapability(quote, token);
    return quote;
  }

  private async expireOverdueOffer(quoteId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const quote = await lockedOffer(transaction, quoteId);
      if (!quote || quote.quoteRequest.status !== QuoteRequestStatus.QUOTED) {
        return;
      }
      const observedAt = await databaseNow(transaction);
      if (quote.expiresAt.getTime() <= observedAt.getTime()) {
        await expireLockedOffer(transaction, quote, observedAt);
      }
    });
  }

  private async requestDetail(
    request: Awaited<
      ReturnType<PrismaService["quoteRequest"]["findUniqueOrThrow"]>
    > & {
      customer?: {
        email: string;
        displayName: string | null;
        phone: string | null;
      } | null;
      quote?: { issuedAt: Date } | null;
    },
    observedAt: Date,
    attachments?: RequestAttachments,
  ): Promise<QuoteRequestDetailDto> {
    const requestAttachments =
      attachments ??
      (await this.prisma.photoAsset.findMany({
        where: {
          scopeKind: PhotoScopeKind.QUOTE_REQUEST,
          scopeId: request.id,
          deletedAt: null,
        },
        orderBy: { uploadedAt: "asc" },
      }));
    const respondedAt =
      slaResponseEvidenceAt(
        request.slaRespondedAt,
        request.quote?.issuedAt,
      )?.getTime() ?? observedAt.getTime();
    return {
      requestId: request.id,
      publicReference: request.publicReference,
      status: request.status,
      description: request.description,
      purpose: request.purpose,
      photoPublicationConsentGranted:
        request.photoPublicationConsentGrantedAt !== null,
      measurements: nullableJsonObject(request.measurements),
      requestedDate: dateOnly(request.requestedDate),
      contact: contactFrom(request.contactSnapshot, request.customer),
      attribution: nullableJsonObject(request.attribution),
      slaDueAt: request.slaDueAt.toISOString(),
      slaBreached: respondedAt > request.slaDueAt.getTime(),
      attachments: requestAttachments.map((attachment) => ({
        id: attachment.id,
        mediaType: attachment.mediaType,
        sizeBytes: safeNumber(attachment.sizeBytes),
        uploadedAt: attachment.uploadedAt.toISOString(),
        deleteAfter: attachment.photoDeleteAfter.toISOString(),
      })),
    };
  }

  private async operatorRequestDetail(
    request: Awaited<
      ReturnType<PrismaService["quoteRequest"]["findUniqueOrThrow"]>
    > & {
      customer?: {
        email: string;
        displayName: string | null;
        phone: string | null;
      } | null;
      automaticQuoteHandoff?: {
        sourceQuoteSessionId: string;
        reasons: string[];
        modelFileIds: string[];
        itemSelections: Prisma.JsonValue;
      } | null;
      quote?: { issuedAt: Date } | null;
    },
    observedAt: Date,
    attachments?: RequestAttachments,
  ): Promise<OperatorQuoteRequestDetailDto> {
    const detail = await this.requestDetail(request, observedAt, attachments);
    const handoff = request.automaticQuoteHandoff;
    return {
      ...detail,
      automaticQuoteHandoff: handoff
        ? {
            automaticQuoteSessionId: handoff.sourceQuoteSessionId,
            reasons: handoff.reasons,
            modelFileIds: handoff.modelFileIds,
            itemSelections: handoffItemSelections(handoff.itemSelections),
          }
        : null,
    };
  }

  private currentCapabilityKey(): QuoteCapabilityKey {
    return quoteCapabilityKeyRing().current;
  }

  private capabilityKeyForId(keyId: string): string {
    const key = quoteCapabilityKeyRing().byId.get(keyId);
    if (!key) {
      throw new Error(
        `Quote capability key ${keyId || "<missing>"} is unavailable`,
      );
    }
    return key;
  }

  private async idempotent<T>(
    namespace: string,
    idempotencyKey: string,
    requestFingerprint: string | readonly string[],
    operation: (transaction: Transaction, generation: number) => Promise<T>,
    options?: IdempotencyOptions<T>,
  ): Promise<T> {
    const acceptedFingerprints =
      typeof requestFingerprint === "string"
        ? [requestFingerprint]
        : requestFingerprint;
    const primaryFingerprint = acceptedFingerprints[0];
    if (!primaryFingerprint) {
      throw new Error("At least one idempotency fingerprint is required");
    }
    return this.prisma.$transaction(async (transaction) => {
      const lockKey = `${namespace}:${idempotencyKey}`;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text
      `;
      await options?.beforeReplay?.(transaction);
      const observedAt = await databaseNow(transaction);
      const existing = await transaction.idempotencyRecord.findFirst({
        where: { namespace, idempotencyKey },
        orderBy: { generation: "desc" },
      });
      if (existing && existing.expiresAt.getTime() > observedAt.getTime()) {
        if (!acceptedFingerprints.includes(existing.requestFingerprint)) {
          throw new ConflictException(
            "Idempotency key was already used with different input",
          );
        }
        if (
          existing.status !== IdempotencyStatus.COMPLETED ||
          existing.responseBody === null
        ) {
          throw new ConflictException("Idempotent command is incomplete");
        }
        return options?.responseCodec
          ? options.responseCodec.fromStoredResponse(
              existing.responseBody,
              existing.requestFingerprint,
              existing.generation,
            )
          : (existing.responseBody as T);
      }

      const record = await transaction.idempotencyRecord.create({
        data: {
          namespace,
          idempotencyKey,
          generation: (existing?.generation ?? 0) + 1,
          requestFingerprint: primaryFingerprint,
          expiresAt: addDays(observedAt, IDEMPOTENCY_DAYS),
        },
      });
      const response = await operation(transaction, record.generation);
      const storedResponse = jsonInput(
        options?.responseCodec
          ? options.responseCodec.toStoredResponse(response, record.generation)
          : response,
      );
      if (storedResponse === undefined) {
        throw new Error("Idempotent response is not JSON serializable");
      }
      const responseStatusCode =
        typeof options?.responseStatusCode === "function"
          ? options.responseStatusCode(response)
          : (options?.responseStatusCode ?? HttpStatus.OK);
      if (
        !Number.isInteger(responseStatusCode) ||
        responseStatusCode < 100 ||
        responseStatusCode > 599
      ) {
        throw new Error("Idempotent response status code is invalid");
      }
      await transaction.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          status: IdempotencyStatus.COMPLETED,
          responseStatusCode,
          responseBody: storedResponse,
        },
      });
      return response;
    });
  }
}

async function lockedRequest(transaction: Transaction, requestId: string) {
  await transaction.$queryRaw`
    SELECT "id" FROM "quote_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE
  `;
  return transaction.quoteRequest.findUnique({ where: { id: requestId } });
}

async function consumeAutomaticQuoteHandoff(
  transaction: Transaction,
  token: string,
  quoteRequestId: string,
): Promise<void> {
  const tokenHash = hashToken(token);
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "automatic_quote_handoff_capabilities"
    WHERE "token_hash" = ${tokenHash}
    FOR UPDATE
  `;
  if (!rows[0]) {
    throw new UnauthorizedException(
      "Automatic quote handoff capability is invalid",
    );
  }
  const observedAt = await databaseNow(transaction);
  const capability =
    await transaction.automaticQuoteHandoffCapability.findUnique({
      where: { id: rows[0].id },
    });
  if (
    !capability ||
    capability.scope !== AutomaticQuoteHandoffScope.ASSISTED_QUOTE_REQUEST ||
    capability.consumedAt !== null ||
    capability.expiresAt.getTime() <= observedAt.getTime()
  ) {
    throw new UnauthorizedException(
      "Automatic quote handoff capability is invalid",
    );
  }
  await transaction.automaticQuoteRequestHandoff.create({
    data: {
      quoteRequestId,
      capabilityId: capability.id,
      sourceQuoteSessionId: capability.sourceQuoteSessionId,
      reasons: capability.reasons,
      modelFileIds: capability.modelFileIds,
      itemSelections: jsonInput(capability.itemSelections)!,
      createdAt: observedAt,
    },
  });
  await transaction.automaticQuoteHandoffCapability.update({
    where: { id: capability.id },
    data: { consumedAt: observedAt },
  });
}

async function lockedOffer(transaction: Transaction, quoteId: string) {
  await transaction.$queryRaw`
    SELECT request."id"
    FROM "quote_requests" request
    JOIN "quotes" quote ON quote."quote_request_id" = request."id"
    WHERE quote."id" = ${quoteId}::uuid
    FOR UPDATE OF request
  `;
  return transaction.quote.findUnique({
    where: { id: quoteId },
    include: {
      quoteRequest: true,
      items: { orderBy: { ordinal: "asc" } },
      deliveryDestination: true,
      shipmentPlans: { orderBy: { ordinal: "asc" } },
      priceBinding: { include: { priceSnapshot: true } },
    },
  });
}

async function acceptLockedQuoteRequest(
  transaction: Transaction,
  requestId: string,
  commandKey: string,
  resultId: string,
): Promise<QuoteAcceptanceRow> {
  const rows = await transaction.$queryRaw<QuoteAcceptanceRow[]>`
    WITH evaluation AS MATERIALIZED (
      SELECT statement_timestamp() AS evaluated_at
    ), accepted AS (
      UPDATE quote_requests request
      SET status = 'ACCEPTED',
          accepted_at = evaluation.evaluated_at,
          current_state_command_key = ${commandKey},
          current_state_result_id = ${resultId}::uuid,
          updated_at = evaluation.evaluated_at
      FROM evaluation
      WHERE request.id = ${requestId}::uuid
        AND request.status = 'QUOTED'
        AND EXISTS (
          SELECT 1
          FROM quotes quote
          WHERE quote.quote_request_id = request.id
            AND quote.expires_at > evaluation.evaluated_at
        )
      RETURNING request.accepted_at
    )
    SELECT evaluation.evaluated_at, accepted.accepted_at
    FROM evaluation
    LEFT JOIN accepted ON true
  `;
  const acceptance = rows[0];
  if (!acceptance) throw new Error("Quote acceptance clock is unavailable");
  return acceptance;
}

async function expireLockedOffer(
  transaction: Transaction,
  quote:
    | NonNullable<Awaited<ReturnType<typeof lockedOffer>>>
    | {
        id: string;
        quoteRequestId: string;
        quoteRequest: Awaited<ReturnType<typeof lockedRequest>> & object;
        issuedAt: Date;
        expiresAt: Date;
        issuanceCommandKey: string;
        issuanceResultId: string;
      },
  observedAt: Date,
  commandKey = `system:quote-expiry:${quote.id}`,
  operatorAudit?: Readonly<{
    audit: AuditService;
    operator: OperatorContext;
    nodeId: string;
  }>,
): Promise<void> {
  if (!quote.quoteRequest) return;
  await applyExpirationTransition(quote, commandKey, observedAt);
  const resultId = randomUUID();
  await transaction.quoteRequest.update({
    where: { id: quote.quoteRequestId },
    data: {
      status: QuoteRequestStatus.EXPIRED,
      expiredAt: observedAt,
      currentStateCommandKey: commandKey,
      currentStateResultId: resultId,
      updatedAt: observedAt,
    },
  });
  if (operatorAudit) {
    await operatorAudit.audit.recordOperator(
      transaction,
      operatorAudit.operator,
      {
        quoteRequestId: quote.quoteRequestId,
        quoteId: quote.id,
        nodeId: operatorAudit.nodeId,
        createdAt: observedAt,
        eventType: "quote_offer.expired",
        idempotencyKey: commandKey,
        correlationId: resultId,
        payload: { operation: "expire_offer", status: "EXPIRED" },
      },
    );
  } else {
    await transaction.auditEvent.create({
      data: {
        quoteId: quote.id,
        eventType: "quote_offer.expired",
        actorKind: AuditActorKind.SYSTEM,
        idempotencyKey: commandKey,
        correlationId: resultId,
        payload: jsonInput({ quoteId: quote.id })!,
        createdAt: observedAt,
      },
    });
  }
  await transaction.outboxMessage.upsert({
    where: { deduplicationKey: `quote-offer-expired:${quote.id}` },
    create: {
      deduplicationKey: `quote-offer-expired:${quote.id}`,
      aggregateType: "Quote",
      aggregateId: quote.id,
      messageType: "email.quote-offer-expired",
      schemaVersion: 1,
      payload: jsonInput({ quoteId: quote.id })!,
      createdAt: observedAt,
      updatedAt: observedAt,
    },
    update: {},
  });
}

export async function applyTransition(
  request: {
    id: string;
    status: QuoteRequestStatus;
    currentStateCommandKey: string;
    currentStateResultId: string;
  },
  target: QuoteRequestStatus,
  commandKey: string,
  context: Readonly<Record<string, unknown>> | undefined,
): Promise<void> {
  const core = await coreModule();
  try {
    core.transition(core.quoteRequestPolicy, {
      aggregateId: request.id,
      current: domainStatus(request.status),
      target: domainStatus(target),
      idempotencyKey: commandKey,
      currentStateCommandKey: request.currentStateCommandKey,
      currentStateResultId: request.currentStateResultId,
      ...(context ? { context } : {}),
    });
  } catch (error) {
    if (
      error instanceof core.InvalidTransitionError ||
      error instanceof core.TransitionGuardError
    ) {
      throw new ConflictException(error.message);
    }
    throw error;
  }
}

async function applyIssuanceTransition(
  request: Parameters<typeof applyTransition>[0],
  evidence: {
    commandKey: string;
    quoteId: string;
    resultId: string;
    issuedAt: Date;
    expiresAt: Date;
  },
): Promise<void> {
  const { Instant } = await coreModule();
  const issuedAt = Instant.fromEpochMilliseconds(evidence.issuedAt.getTime());
  const expiresAt = Instant.fromEpochMilliseconds(evidence.expiresAt.getTime());
  await applyTransition(
    request,
    QuoteRequestStatus.QUOTED,
    evidence.commandKey,
    {
      quoteRequestId: request.id,
      issuedQuoteId: evidence.quoteId,
      issuedQuoteRequestId: request.id,
      issuedQuoteIssuedAt: issuedAt,
      issuedQuoteExpiresAt: expiresAt,
      quoteIssuanceResultId: evidence.resultId,
      quoteIssuancePreviousQuoteRequestResultId: request.currentStateResultId,
      quoteIssuanceCurrentStateCommandKey: request.currentStateCommandKey,
      quoteIssuanceQuoteRequestId: request.id,
      quoteIssuanceQuoteRequestPreviousStatus: "in_review",
      quoteIssuanceQuoteRequestTargetStatus: "quoted",
      quoteIssuanceIssuedQuoteId: evidence.quoteId,
      quoteIssuanceIssuedQuoteRequestId: request.id,
      quoteIssuanceRequestResultId: evidence.resultId,
      quoteIssuanceQuoteResultId: evidence.resultId,
      quoteIssuanceExpectedQuoteRequest: {
        id: request.id,
        status: "in_review",
        resultId: request.currentStateResultId,
        currentStateCommandKey: request.currentStateCommandKey,
        immutable: true,
      },
      quoteIssuanceIssuedQuote: {
        id: evidence.quoteId,
        quoteRequestId: request.id,
        issuedAt,
        expiresAt,
        resultId: evidence.resultId,
        immutable: true,
      },
      quoteIssuanceCompleted: true,
      quoteIssuanceAtomic: true,
    },
  );
}

async function applyAcceptanceTransition(
  quote: NonNullable<Awaited<ReturnType<typeof lockedOffer>>>,
  evidence: {
    commandKey: string;
    orderId: string;
    resultId: string;
    evaluatedAt: Date;
  },
): Promise<void> {
  const { Instant } = await coreModule();
  const issuedAt = Instant.fromEpochMilliseconds(quote.issuedAt.getTime());
  const expiresAt = Instant.fromEpochMilliseconds(quote.expiresAt.getTime());
  const evaluatedAt = Instant.fromEpochMilliseconds(
    evidence.evaluatedAt.getTime(),
  );
  await applyTransition(
    quote.quoteRequest,
    QuoteRequestStatus.ACCEPTED,
    evidence.commandKey,
    {
      quoteRequestId: quote.quoteRequestId,
      issuedQuoteId: quote.id,
      issuedQuoteRequestId: quote.quoteRequestId,
      issuedQuoteIssuedAt: issuedAt,
      issuedQuoteExpiresAt: expiresAt,
      quoteIssuanceResultId: quote.issuanceResultId,
      quoteIssuanceQuoteRequestId: quote.quoteRequestId,
      quoteIssuanceQuoteRequestPreviousStatus: "in_review",
      quoteIssuanceQuoteRequestTargetStatus: "quoted",
      quoteIssuanceIssuedQuoteId: quote.id,
      quoteIssuanceIssuedQuoteRequestId: quote.quoteRequestId,
      quoteIssuanceRequestResultId: quote.issuanceResultId,
      quoteIssuanceQuoteResultId: quote.issuanceResultId,
      quoteIssuanceIssuedQuote: {
        id: quote.id,
        quoteRequestId: quote.quoteRequestId,
        issuedAt,
        expiresAt,
        resultId: quote.issuanceResultId,
        immutable: true,
      },
      quoteIssuanceCompleted: true,
      quoteIssuanceAtomic: true,
      quoteAcceptanceResultId: evidence.resultId,
      quoteAcceptancePreviousQuoteRequestResultId:
        quote.quoteRequest.currentStateResultId,
      quoteAcceptanceCurrentStateCommandKey:
        quote.quoteRequest.currentStateCommandKey,
      quoteAcceptanceExpectedQuoteRequest: {
        id: quote.quoteRequestId,
        status: "quoted",
        resultId: quote.quoteRequest.currentStateResultId,
        currentStateCommandKey: quote.quoteRequest.currentStateCommandKey,
        immutable: true,
      },
      quoteAcceptanceQuoteRequestId: quote.quoteRequestId,
      quoteAcceptanceIssuedQuoteId: quote.id,
      quoteAcceptanceIssuedQuoteRequestId: quote.quoteRequestId,
      quoteAcceptanceIssuedQuoteCreationResultId: quote.issuanceResultId,
      quoteAcceptanceIssuedQuote: {
        id: quote.id,
        quoteRequestId: quote.quoteRequestId,
        issuedAt,
        expiresAt,
        resultId: quote.issuanceResultId,
        immutable: true,
      },
      quoteAcceptanceIssuedAt: issuedAt,
      quoteAcceptanceExpiresAt: expiresAt,
      quoteAcceptanceEvaluatedAt: evaluatedAt,
      quoteAcceptanceAvailabilityResultId: evidence.resultId,
      quoteAcceptanceOrderResultId: evidence.resultId,
      quoteAcceptanceRequestResultId: evidence.resultId,
      quoteAcceptanceQuoteRequestPreviousStatus: "quoted",
      quoteAcceptanceQuoteRequestTargetStatus: "accepted",
      orderId: evidence.orderId,
      acceptedOrderId: evidence.orderId,
      createdOrderQuoteRequestId: quote.quoteRequestId,
      createdOrderSourceQuoteId: quote.id,
      createdOrderStatus: "draft",
      createdOrderResultId: evidence.resultId,
      orderCreated: true,
      quoteAcceptanceOrderCreationAtomic: true,
    },
  );
}

async function applyExpirationTransition(
  quote: {
    id: string;
    quoteRequestId: string;
    quoteRequest: NonNullable<Awaited<ReturnType<typeof lockedRequest>>>;
    issuedAt: Date;
    expiresAt: Date;
    issuanceResultId: string;
  },
  commandKey: string,
  observedAt: Date,
): Promise<void> {
  const { Instant } = await coreModule();
  const issuedAt = Instant.fromEpochMilliseconds(quote.issuedAt.getTime());
  const expiresAt = Instant.fromEpochMilliseconds(quote.expiresAt.getTime());
  await applyTransition(
    quote.quoteRequest,
    QuoteRequestStatus.EXPIRED,
    commandKey,
    {
      quoteRequestId: quote.quoteRequestId,
      issuedQuoteId: quote.id,
      issuedQuoteRequestId: quote.quoteRequestId,
      issuedQuoteIssuedAt: issuedAt,
      issuedQuoteExpiresAt: expiresAt,
      quoteIssuanceResultId: quote.issuanceResultId,
      quoteIssuanceQuoteRequestId: quote.quoteRequestId,
      quoteIssuanceQuoteRequestPreviousStatus: "in_review",
      quoteIssuanceQuoteRequestTargetStatus: "quoted",
      quoteIssuanceIssuedQuoteId: quote.id,
      quoteIssuanceIssuedQuoteRequestId: quote.quoteRequestId,
      quoteIssuanceRequestResultId: quote.issuanceResultId,
      quoteIssuanceQuoteResultId: quote.issuanceResultId,
      quoteIssuanceIssuedQuote: {
        id: quote.id,
        quoteRequestId: quote.quoteRequestId,
        issuedAt,
        expiresAt,
        resultId: quote.issuanceResultId,
        immutable: true,
      },
      quoteIssuanceCompleted: true,
      quoteIssuanceAtomic: true,
      quoteExpirationPreviousQuoteRequestResultId:
        quote.quoteRequest.currentStateResultId,
      quoteExpirationCurrentStateCommandKey:
        quote.quoteRequest.currentStateCommandKey,
      quoteExpirationExpectedQuoteRequest: {
        id: quote.quoteRequestId,
        status: "quoted",
        resultId: quote.quoteRequest.currentStateResultId,
        currentStateCommandKey: quote.quoteRequest.currentStateCommandKey,
        immutable: true,
      },
      quoteExpirationQuoteRequestId: quote.quoteRequestId,
      quoteExpirationIssuedQuoteId: quote.id,
      quoteExpirationEvaluatedAt: Instant.fromEpochMilliseconds(
        observedAt.getTime(),
      ),
    },
  );
}

function validateCreateRequest(input: CreateQuoteRequestDto) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("Quote request input is required");
  }
  const contact = validateContact(input.contact);
  return {
    description: requiredText(input.description, "description", 10_000, 10),
    purpose: optionalText(input.purpose, "purpose", 2_000),
    measurements: optionalObject(input.measurements, "measurements"),
    requestedDate: optionalDate(input.requestedDate, "requestedDate"),
    contact,
    photoPublicationConsent: optionalBoolean(
      input.photoPublicationConsent,
      "photoPublicationConsent",
    ),
    automaticQuoteHandoffToken: optionalCapabilityToken(
      input.automaticQuoteHandoffToken,
      "automaticQuoteHandoffToken",
    ),
    attribution: normalizeAttribution(input.attribution),
  };
}

function optionalCapabilityToken(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    throw new BadRequestException(`${name} is invalid`);
  return value;
}

function validateContact(input: QuoteContactDto | undefined): QuoteContactDto {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("contact is required");
  }
  const email = requiredText(input.email, "contact.email", 320).toLowerCase();
  if (Array.from(email).length > 320) {
    throw new BadRequestException(
      "contact.email must contain between 1 and 320 characters",
    );
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new BadRequestException("contact.email is invalid");
  }
  const phone = optionalText(input.phone, "contact.phone", 50);
  return {
    name: requiredText(input.name, "contact.name", 200),
    email,
    ...(phone ? { phone } : {}),
  };
}

function validateOffer(input: IssueOfferDto) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("Offer input is required");
  }
  const priceListId = normalizedUuid(input.priceListId, "priceListId");
  const contractTotalMinor = money(
    input.contractTotalMinor,
    "contractTotalMinor",
  );
  const tax = validateOfferTax(input, contractTotalMinor);
  const depositMinor = money(input.depositMinor, "depositMinor");
  if (
    contractTotalMinor < 2 ||
    depositMinor < 1 ||
    depositMinor >= contractTotalMinor
  ) {
    throw new BadRequestException(
      "depositMinor must be positive and lower than contractTotalMinor",
    );
  }
  if (!Array.isArray(input.items) || input.items.length < 1) {
    throw new BadRequestException("items must contain at least one item");
  }
  const items = input.items.map(validateOfferItem);
  const deliveryDestination = validateOfferDeliveryDestination(
    input.deliveryDestination,
  );
  const shipmentPlans = validateOfferShipmentPlans(input.shipmentPlans, items);
  const paymentPolicy = validateOfferPaymentPolicy(input.paymentPolicy);
  if (!Array.isArray(input.components) || input.components.length < 1) {
    throw new BadRequestException("components must not be empty");
  }
  const componentKeys = new Set<string>();
  const suppliedComponents = input.components.map((component) => {
    if (!component || typeof component !== "object") {
      throw new BadRequestException("components contain an invalid value");
    }
    if (!Object.values(PriceComponentKind).includes(component.kind)) {
      throw new BadRequestException("component kind is invalid");
    }
    const kind = component.kind as PriceComponentKind;
    if (kind === PriceComponentKind.PAYMENT_FEE) {
      throw new BadRequestException(
        "PAYMENT_FEE components are not supported for individual offers",
      );
    }
    const amountMinor = money(
      component.amountMinor,
      "component amountMinor",
      true,
    );
    const quoteItemOrdinal = component.quoteItemOrdinal;
    if (ITEM_COMPONENTS.has(kind)) {
      if (
        !Number.isInteger(quoteItemOrdinal) ||
        quoteItemOrdinal! < 0 ||
        quoteItemOrdinal! >= items.length
      ) {
        throw new BadRequestException(
          "Item components require a valid quoteItemOrdinal",
        );
      }
    } else if (ORDER_COMPONENTS.has(kind)) {
      if (quoteItemOrdinal !== undefined) {
        throw new BadRequestException(
          "Order components cannot identify a quote item",
        );
      }
    } else {
      throw new BadRequestException("component kind is not valid for an offer");
    }
    const key = `${quoteItemOrdinal ?? "order"}:${kind}`;
    if (componentKeys.has(key)) {
      throw new BadRequestException(`Duplicate component ${key}`);
    }
    componentKeys.add(key);
    return {
      kind,
      amountMinor,
      quoteItemOrdinal,
      allocation: optionalObject(component.allocation, "component allocation"),
    };
  });
  for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
    for (const kind of REQUIRED_ITEM_COMPONENTS) {
      if (!componentKeys.has(`${ordinal}:${kind}`)) {
        throw new BadRequestException(`Item ${ordinal} is missing ${kind}`);
      }
    }
  }
  const shipmentComponents = shipmentPlans.map((plan, ordinal) => ({
    kind: PriceComponentKind.SHIPMENT,
    amountMinor: safeMoneyAggregate(
      BigInt(plan.shippingAmountMinor) +
        BigInt(plan.packagingAmountMinor) +
        BigInt(plan.handlingAmountMinor),
      `shipmentPlans[${ordinal}] charge total`,
    ),
    quoteItemOrdinal: undefined,
    quoteShipmentPlanOrdinal: ordinal,
    allocation: undefined,
  }));
  const paymentFeeMinor = safeMoneyAggregate(
    paymentCaptureFeeMinor(depositMinor, paymentPolicy.deposit) +
      paymentCaptureFeeMinor(
        contractTotalMinor - depositMinor,
        paymentPolicy.balance,
      ),
    "payment fee total",
  );
  const paymentFeeComponents =
    paymentFeeMinor === 0
      ? []
      : [
          {
            kind: PriceComponentKind.PAYMENT_FEE,
            amountMinor: paymentFeeMinor,
            quoteItemOrdinal: undefined,
            quoteShipmentPlanOrdinal: undefined,
            allocation: undefined,
          },
        ];
  const netComponents = [
    ...suppliedComponents.map((component) => ({
      ...component,
      quoteShipmentPlanOrdinal: undefined,
    })),
    ...shipmentComponents,
    ...paymentFeeComponents,
  ];
  const netComponentTotal = netComponents.reduce(
    (total, component) => total + BigInt(component.amountMinor),
    BigInt(0),
  );
  if (netComponentTotal !== BigInt(tax.netAmountMinor)) {
    throw new BadRequestException(
      "Price components before VAT must sum to netAmountMinor",
    );
  }
  const components = [
    ...netComponents,
    ...(tax.vatAmountMinor === 0
      ? []
      : [
          {
            kind: PriceComponentKind.VAT,
            amountMinor: tax.vatAmountMinor,
            quoteItemOrdinal: undefined,
            quoteShipmentPlanOrdinal: undefined,
            allocation: undefined,
          },
        ]),
  ];
  const expiresAt = requiredInstant(input.expiresAt, "expiresAt");
  const promisedDate = optionalDate(input.promisedDate, "promisedDate");
  const termsSnapshot = requiredObject(input.termsSnapshot, "termsSnapshot");
  const inputSnapshot = requiredObject(input.inputSnapshot, "inputSnapshot");
  const summary = requiredText(input.summary, "summary", 4_000, 3);
  return {
    summary,
    expiresAt,
    promisedDate,
    priceListId,
    contractTotalMinor,
    ...tax,
    depositMinor,
    termsSnapshot,
    inputSnapshot,
    deliveryDestination,
    shipmentPlans,
    paymentPolicy,
    items,
    components,
    fingerprint: {
      summary,
      expiresAt: expiresAt.toISOString(),
      promisedDate: dateOnly(promisedDate),
      priceListId,
      contractTotalMinor,
      ...tax,
      depositMinor,
      termsSnapshot,
      inputSnapshot,
      deliveryDestination,
      shipmentPlans,
      paymentPolicy,
      items: items.map(serializableItem),
      components,
    },
  };
}

function validateOfferTax(
  input: IssueOfferDto,
  contractTotalMinor: number,
): {
  taxRegime: SellerTaxRegime;
  vatRateBasisPoints: number;
  netAmountMinor: number;
  vatAmountMinor: number;
} {
  if (
    input.taxRegime !== SellerTaxRegime.NON_VAT_PAYER &&
    input.taxRegime !== SellerTaxRegime.VAT_PAYER
  ) {
    throw new BadRequestException("taxRegime is invalid");
  }
  const vatRateBasisPoints = money(
    input.vatRateBasisPoints,
    "vatRateBasisPoints",
    true,
  );
  if (vatRateBasisPoints > 10_000) {
    throw new BadRequestException("vatRateBasisPoints must not exceed 10000");
  }
  const netAmountMinor = money(input.netAmountMinor, "netAmountMinor", true);
  const vatAmountMinor = money(input.vatAmountMinor, "vatAmountMinor", true);
  if (netAmountMinor + vatAmountMinor !== contractTotalMinor) {
    throw new BadRequestException(
      "netAmountMinor plus vatAmountMinor must equal contractTotalMinor",
    );
  }
  if (
    input.taxRegime === SellerTaxRegime.NON_VAT_PAYER &&
    (vatRateBasisPoints !== 0 || vatAmountMinor !== 0)
  ) {
    throw new BadRequestException(
      "NON_VAT_PAYER offers must use zero VAT rate and amount",
    );
  }
  if (input.taxRegime === SellerTaxRegime.VAT_PAYER) {
    if (vatRateBasisPoints === 0) {
      throw new BadRequestException(
        "VAT_PAYER offers require a positive VAT rate",
      );
    }
    const numerator = BigInt(contractTotalMinor) * BigInt(vatRateBasisPoints);
    const denominator = BigInt(10_000 + vatRateBasisPoints);
    const expectedVat = Number(
      (2n * numerator + denominator) / (2n * denominator),
    );
    if (vatAmountMinor !== expectedVat) {
      throw new BadRequestException(
        "vatAmountMinor must be the half-up VAT extraction from contractTotalMinor",
      );
    }
  }
  return {
    taxRegime: input.taxRegime,
    vatRateBasisPoints,
    netAmountMinor,
    vatAmountMinor,
  };
}

function validateOfferItem(input: ModelOfferItemDto, ordinal: number) {
  if (!input || typeof input !== "object") {
    throw new BadRequestException(`Item ${ordinal} is invalid`);
  }
  if (input.kind !== "MODEL") {
    throw new BadRequestException(`items[${ordinal}].kind is invalid`);
  }
  const sourceModelFileId = normalizedUuid(
    input.sourceModelFileId,
    `items[${ordinal}].sourceModelFileId`,
  );
  const modelGeometryId = normalizedUuid(
    input.modelGeometryId,
    `items[${ordinal}].modelGeometryId`,
  );
  const printConfigRevisionId = normalizedUuid(
    input.printConfigRevisionId,
    `items[${ordinal}].printConfigRevisionId`,
  );
  const primaryReferenceSliceResultId =
    input.primaryReferenceSliceResultId === undefined
      ? undefined
      : normalizedUuid(
          input.primaryReferenceSliceResultId,
          `items[${ordinal}].primaryReferenceSliceResultId`,
        );
  const tailReferenceSliceResultId =
    input.tailReferenceSliceResultId === undefined
      ? undefined
      : normalizedUuid(
          input.tailReferenceSliceResultId,
          `items[${ordinal}].tailReferenceSliceResultId`,
        );
  if (!input.material || !Object.values(Material).includes(input.material)) {
    throw new BadRequestException(`items[${ordinal}].material is invalid`);
  }
  const quantity = positiveInteger(
    input.quantity ?? 1,
    `items[${ordinal}].quantity`,
    OFFER_PACKING_UNIT_MAX,
  );
  const referencePartsPerPlate = input.referencePartsPerPlate;
  if (
    referencePartsPerPlate !== undefined &&
    (!Number.isSafeInteger(referencePartsPerPlate) ||
      referencePartsPerPlate < 1 ||
      referencePartsPerPlate > POSTGRES_INTEGER_MAX)
  ) {
    throw new BadRequestException(
      `items[${ordinal}].referencePartsPerPlate is invalid`,
    );
  }
  return {
    kind: "MODEL" as const,
    sourceModelFileId,
    modelGeometryId,
    printConfigRevisionId,
    primaryReferenceSliceResultId,
    tailReferenceSliceResultId,
    referencePartsPerPlate,
    material: input.material as Material,
    color: optionalText(input.color, `items[${ordinal}].color`, 100),
    quantity,
  };
}

function validateOfferDeliveryDestination(
  input: OfferDeliveryDestinationDto | undefined,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("deliveryDestination is required");
  }
  return {
    providerEndpointId: requiredText(
      input.providerEndpointId,
      "deliveryDestination.providerEndpointId",
      255,
    ),
    endpointType: requiredText(
      input.endpointType,
      "deliveryDestination.endpointType",
      100,
    ),
    addressSnapshot: requiredObject(
      input.addressSnapshot,
      "deliveryDestination.addressSnapshot",
    ),
    capabilitySnapshot: requiredObject(
      input.capabilitySnapshot,
      "deliveryDestination.capabilitySnapshot",
    ),
  };
}

function validateOfferShipmentPlans(
  input: OfferShipmentPlanDto[] | undefined,
  items: Array<ReturnType<typeof validateOfferItem>>,
) {
  if (!Array.isArray(input) || input.length < 1) {
    throw new BadRequestException("shipmentPlans must not be empty");
  }
  const expectedPackingUnitCount = items.reduce(
    (total, item) => total + item.quantity,
    0,
  );
  if (expectedPackingUnitCount > OFFER_PACKING_UNIT_MAX) {
    throw new BadRequestException(
      `Offer items may contain at most ${OFFER_PACKING_UNIT_MAX} packing units`,
    );
  }
  const allocatedPackingUnits = new Set<string>();
  const plans = input.map((plan, planOrdinal) => {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      throw new BadRequestException(`shipmentPlans[${planOrdinal}] is invalid`);
    }
    if (!Array.isArray(plan.packingUnits) || plan.packingUnits.length < 1) {
      throw new BadRequestException(
        `shipmentPlans[${planOrdinal}].packingUnits must not be empty`,
      );
    }
    const packingUnits = plan.packingUnits.map((unit, unitOrdinal) => {
      if (!unit || typeof unit !== "object" || Array.isArray(unit)) {
        throw new BadRequestException(
          `shipmentPlans[${planOrdinal}].packingUnits[${unitOrdinal}] is invalid`,
        );
      }
      const quoteItemOrdinal = nonNegativeInteger(
        unit.quoteItemOrdinal,
        `shipmentPlans[${planOrdinal}].packingUnits[${unitOrdinal}].quoteItemOrdinal`,
        items.length - 1,
      );
      const quantityOrdinal = positiveInteger(
        unit.quantityOrdinal,
        `shipmentPlans[${planOrdinal}].packingUnits[${unitOrdinal}].quantityOrdinal`,
        items[quoteItemOrdinal]!.quantity,
      );
      const key = `${quoteItemOrdinal}:${quantityOrdinal}`;
      if (allocatedPackingUnits.has(key)) {
        throw new BadRequestException(
          `Packing unit ${key} appears in more than one shipment plan`,
        );
      }
      allocatedPackingUnits.add(key);
      return { quoteItemOrdinal, quantityOrdinal };
    });
    return {
      category: requiredText(
        plan.category,
        `shipmentPlans[${planOrdinal}].category`,
        100,
      ),
      plannedVolumeCubicMm: nonNegativeInteger(
        plan.plannedVolumeCubicMm,
        `shipmentPlans[${planOrdinal}].plannedVolumeCubicMm`,
      ),
      plannedWeightMilligrams: nonNegativeInteger(
        plan.plannedWeightMilligrams,
        `shipmentPlans[${planOrdinal}].plannedWeightMilligrams`,
      ),
      shippingAmountMinor: money(
        plan.shippingAmountMinor,
        `shipmentPlans[${planOrdinal}].shippingAmountMinor`,
        true,
      ),
      packagingAmountMinor: money(
        plan.packagingAmountMinor,
        `shipmentPlans[${planOrdinal}].packagingAmountMinor`,
        true,
      ),
      handlingAmountMinor: money(
        plan.handlingAmountMinor,
        `shipmentPlans[${planOrdinal}].handlingAmountMinor`,
        true,
      ),
      packingUnits,
      allocationSnapshot: optionalObject(
        plan.allocationSnapshot,
        `shipmentPlans[${planOrdinal}].allocationSnapshot`,
      ),
    };
  });
  for (const [itemOrdinal, item] of items.entries()) {
    for (
      let quantityOrdinal = 1;
      quantityOrdinal <= item.quantity;
      quantityOrdinal += 1
    ) {
      const key = `${itemOrdinal}:${quantityOrdinal}`;
      if (!allocatedPackingUnits.has(key)) {
        throw new BadRequestException(
          `Packing unit ${key} is missing from shipmentPlans`,
        );
      }
    }
  }
  return plans;
}

function validateOfferPaymentPolicy(
  input: IssueOfferDto["paymentPolicy"] | undefined,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("paymentPolicy is required");
  }
  return {
    deposit: validateOfferPaymentCapturePolicy(input.deposit, "deposit"),
    balance: validateOfferPaymentCapturePolicy(input.balance, "balance"),
  };
}

function validateOfferPaymentCapturePolicy(
  input: OfferPaymentCapturePolicyDto | undefined,
  role: "deposit" | "balance",
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException(`paymentPolicy.${role} is required`);
  }
  return {
    feeRateBasisPoints: nonNegativeInteger(
      input.feeRateBasisPoints,
      `paymentPolicy.${role}.feeRateBasisPoints`,
      9_999,
    ),
    feeFixedMinor: money(
      input.feeFixedMinor,
      `paymentPolicy.${role}.feeFixedMinor`,
      true,
    ),
    providerConfig: requiredObject(
      input.providerConfig,
      `paymentPolicy.${role}.providerConfig`,
    ),
  };
}

function paymentCaptureFeeMinor(
  grossAmountMinor: number,
  policy: ReturnType<typeof validateOfferPaymentCapturePolicy>,
): bigint {
  return (
    (BigInt(grossAmountMinor) * BigInt(policy.feeRateBasisPoints) +
      BigInt(9_999)) /
      BigInt(10_000) +
    BigInt(policy.feeFixedMinor)
  );
}

function safeMoneyAggregate(value: bigint, name: string): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BadRequestException(
      `${name} must be a non-negative safe integer`,
    );
  }
  return Number(value);
}

async function validateOfferItemReferences(
  transaction: Transaction,
  items: Array<ReturnType<typeof validateOfferItem>>,
  observedAt: Date,
): Promise<void> {
  const geometryIds = [...new Set(items.map((item) => item.modelGeometryId))];
  const printConfigIds = [
    ...new Set(items.map((item) => item.printConfigRevisionId)),
  ];
  const sliceIds = [
    ...new Set(
      items.flatMap((item) => [
        ...(item.primaryReferenceSliceResultId
          ? [item.primaryReferenceSliceResultId]
          : []),
        ...(item.tailReferenceSliceResultId
          ? [item.tailReferenceSliceResultId]
          : []),
      ]),
    ),
  ];
  const [geometries, printConfigs, slices] = await Promise.all([
    Promise.all(
      batchesOf(geometryIds).map((ids) =>
        transaction.modelGeometry.findMany({
          where: { id: { in: ids } },
          include: { sourceModelFile: true },
        }),
      ),
    ).then((batches) => batches.flat()),
    Promise.all(
      batchesOf(printConfigIds).map((ids) =>
        transaction.printConfigRevision.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        }),
      ),
    ).then((batches) => batches.flat()),
    Promise.all(
      batchesOf(sliceIds).map((ids) =>
        transaction.sliceResult.findMany({
          where: { id: { in: ids } },
          include: { referenceProfile: true },
        }),
      ),
    ).then((batches) => batches.flat()),
  ]);
  const geometryById = new Map(
    geometries.map((geometry) => [geometry.id, geometry]),
  );
  const printConfigIdsFound = new Set(
    printConfigs.map((printConfig) => printConfig.id),
  );
  const sliceById = new Map(slices.map((slice) => [slice.id, slice]));

  for (const [ordinal, item] of items.entries()) {
    const geometry = geometryById.get(item.modelGeometryId);
    const primarySlice = item.primaryReferenceSliceResultId
      ? sliceById.get(item.primaryReferenceSliceResultId)
      : undefined;
    const tailSlice = item.tailReferenceSliceResultId
      ? sliceById.get(item.tailReferenceSliceResultId)
      : undefined;
    const source = geometry?.sourceModelFile;
    if (
      !geometry ||
      !source ||
      geometry.sourceModelFileId !== item.sourceModelFileId ||
      geometry.deletedAt !== null ||
      source.deletedAt !== null ||
      (source.retentionHold === RetentionHold.NONE &&
        source.sourceDeleteAfter.getTime() <= observedAt.getTime()) ||
      !printConfigIdsFound.has(item.printConfigRevisionId)
    ) {
      throw invalidOfferItemReferences(ordinal);
    }

    if (!item.primaryReferenceSliceResultId) {
      if (
        item.tailReferenceSliceResultId !== undefined ||
        item.referencePartsPerPlate !== undefined
      ) {
        throw invalidOfferItemReferences(ordinal);
      }
      continue;
    }

    const partsPerPlate = item.referencePartsPerPlate;
    if (
      !primarySlice ||
      !primarySlice.referenceProfile ||
      !partsPerPlate ||
      primarySlice.kind !== SliceKind.REFERENCE ||
      primarySlice.modelGeometryId !== item.modelGeometryId ||
      primarySlice.printConfigRevisionId !== item.printConfigRevisionId ||
      primarySlice.referenceProfile.material !== item.material
    ) {
      throw invalidOfferItemReferences(ordinal);
    }

    const fullPlateCount = Math.floor(item.quantity / partsPerPlate);
    const tailPartCount = item.quantity % partsPerPlate;
    if (fullPlateCount === 0) {
      if (
        primarySlice.partsPerPlate !== item.quantity ||
        item.tailReferenceSliceResultId !== undefined
      ) {
        throw invalidOfferItemReferences(ordinal);
      }
      continue;
    }
    if (primarySlice.partsPerPlate !== partsPerPlate) {
      throw invalidOfferItemReferences(ordinal);
    }
    if (tailPartCount === 0) {
      if (item.tailReferenceSliceResultId !== undefined) {
        throw invalidOfferItemReferences(ordinal);
      }
      continue;
    }
    if (
      !tailSlice ||
      !tailSlice.referenceProfile ||
      tailSlice.id === primarySlice.id ||
      tailSlice.kind !== SliceKind.REFERENCE ||
      tailSlice.modelGeometryId !== item.modelGeometryId ||
      tailSlice.printConfigRevisionId !== item.printConfigRevisionId ||
      tailSlice.referenceProfileId !== primarySlice.referenceProfileId ||
      tailSlice.referenceProfile.material !== item.material ||
      tailSlice.partsPerPlate !== tailPartCount
    ) {
      throw invalidOfferItemReferences(ordinal);
    }
  }
}

function invalidOfferItemReferences(ordinal: number): BadRequestException {
  return new BadRequestException(
    `items[${ordinal}] references unavailable or incompatible model topology`,
  );
}

function serializableItem(item: ReturnType<typeof validateOfferItem>) {
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined),
  );
}

function validateExpectedOffer(input: AcceptOfferDto) {
  if (!input || typeof input !== "object") {
    throw new BadRequestException("Offer version evidence is required");
  }
  return {
    version: positiveInteger(input.version, "version", POSTGRES_INTEGER_MAX),
    termsRevision: requiredText(input.termsRevision, "termsRevision", 100),
  };
}

function assertExpectedOffer(
  quote: { version: number; termsRevision: string },
  expected: ReturnType<typeof validateExpectedOffer>,
): void {
  if (
    quote.version !== expected.version ||
    quote.termsRevision !== expected.termsRevision
  ) {
    throw new ConflictException("Offer version or terms revision changed");
  }
}

function assertOfferCapability(
  quote: { publicTokenHash: string | null } | null | undefined,
  token: string,
): asserts quote is NonNullable<typeof quote> & { publicTokenHash: string } {
  if (
    !quote?.publicTokenHash ||
    !matchesTokenHash(token, quote.publicTokenHash)
  ) {
    throw new UnauthorizedException("Offer capability is invalid");
  }
}

function anonymousQuoteClientSubject(
  capabilityKey: string,
  clientAddress: string,
): string {
  return createHmac("sha256", capabilityKey)
    .update(`anonymous-quote-request\0${normalizeClientAddress(clientAddress)}`)
    .digest("hex");
}

function contactFrom(
  snapshot: Prisma.JsonValue | null,
  customer:
    | { email: string; displayName: string | null; phone: string | null }
    | null
    | undefined,
): QuoteContactDto {
  const object = nullableJsonObject(snapshot);
  if (
    object &&
    typeof object.name === "string" &&
    typeof object.email === "string"
  ) {
    const phone = typeof object.phone === "string" ? object.phone : undefined;
    return {
      name: object.name,
      email: object.email,
      ...(phone ? { phone } : {}),
    };
  }
  const phone = customer?.phone ?? undefined;
  return {
    name: customer?.displayName ?? "Customer",
    email: customer?.email ?? "unknown@example.invalid",
    ...(phone ? { phone } : {}),
  };
}

function offerDeliveryDestinationDto(
  destination:
    | {
        providerEndpointId: string;
        endpointType: string;
        addressSnapshot: Prisma.JsonValue;
        capabilitySnapshot: Prisma.JsonValue;
      }
    | null
    | undefined,
): OfferDeliveryDestinationDto {
  if (!destination) {
    throw new ConflictException("Offer delivery destination is unavailable");
  }
  return {
    providerEndpointId: destination.providerEndpointId,
    endpointType: destination.endpointType,
    addressSnapshot: jsonObject(destination.addressSnapshot),
    capabilitySnapshot: jsonObject(destination.capabilitySnapshot),
  };
}

function offerShipmentPlanDto(plan: {
  category: string;
  plannedVolumeCubicMm: bigint;
  plannedWeightMilligrams: bigint;
  shippingAmountMinor: bigint;
  packagingAmountMinor: bigint;
  handlingAmountMinor: bigint;
  allocationSnapshot: Prisma.JsonValue;
}): OfferShipmentPlanDto {
  const allocation = jsonObject(plan.allocationSnapshot);
  if (!Array.isArray(allocation.packingUnits)) {
    throw new ConflictException("Offer shipment allocation is unavailable");
  }
  const packingUnits = allocation.packingUnits.map((unit) => {
    if (
      !unit ||
      typeof unit !== "object" ||
      Array.isArray(unit) ||
      !Number.isInteger((unit as Record<string, unknown>).quoteItemOrdinal) ||
      !Number.isInteger((unit as Record<string, unknown>).quantityOrdinal)
    ) {
      throw new ConflictException("Offer shipment allocation is invalid");
    }
    return {
      quoteItemOrdinal: (unit as Record<string, number>).quoteItemOrdinal!,
      quantityOrdinal: (unit as Record<string, number>).quantityOrdinal!,
    };
  });
  const details = nullableJsonObject(
    allocation.details as Prisma.JsonValue | undefined,
  );
  return {
    category: plan.category,
    plannedVolumeCubicMm: safeNumber(plan.plannedVolumeCubicMm),
    plannedWeightMilligrams: safeNumber(plan.plannedWeightMilligrams),
    shippingAmountMinor: safeNumber(plan.shippingAmountMinor),
    packagingAmountMinor: safeNumber(plan.packagingAmountMinor),
    handlingAmountMinor: safeNumber(plan.handlingAmountMinor),
    packingUnits,
    ...(details && Object.keys(details).length > 0
      ? { allocationSnapshot: details }
      : {}),
  };
}

function domainStatus(status: QuoteRequestStatus): DomainQuoteRequestStatus {
  return status.toLowerCase() as DomainQuoteRequestStatus;
}

function parseStatus(value: string): QuoteRequestStatus {
  const normalized = value.trim().toUpperCase();
  if (
    !Object.values(QuoteRequestStatus).includes(
      normalized as QuoteRequestStatus,
    )
  ) {
    throw new BadRequestException("status is invalid");
  }
  return normalized as QuoteRequestStatus;
}

function parseOperatorQueueSla(value: string): OperatorQueueSla {
  const normalized = value.trim().toUpperCase();
  if (
    normalized !== "PENDING" &&
    normalized !== "MET" &&
    normalized !== "BREACHED"
  ) {
    throw new BadRequestException("sla is invalid");
  }
  return normalized;
}

function operatorQueuePageLimit(value: number | undefined): number {
  if (value === undefined) return OPERATOR_QUEUE_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > OPERATOR_QUEUE_MAX_LIMIT
  ) {
    throw new BadRequestException("limit is invalid");
  }
  return value;
}

function operatorQueueSlaFilter(
  sla: OperatorQueueSla | undefined,
  observedAt: Date,
): Prisma.Sql {
  const respondedAt = Prisma.sql`LEAST(request.sla_responded_at, quote.issued_at)`;
  switch (sla) {
    case "PENDING":
      return Prisma.sql`AND ${respondedAt} IS NULL`;
    case "MET":
      return Prisma.sql`
        AND ${respondedAt} IS NOT NULL
        AND ${respondedAt} <= request.sla_due_at
      `;
    case "BREACHED":
      return Prisma.sql`
        AND (
          ${respondedAt} > request.sla_due_at
          OR (
            ${respondedAt} IS NULL
            AND request.sla_due_at < ${observedAt}::timestamptz
          )
        )
      `;
    default:
      return Prisma.empty;
  }
}

function slaResponseEvidenceAt(
  slaRespondedAt: Date | null,
  quoteIssuedAt: Date | null | undefined,
): Date | null {
  const timestamps = [slaRespondedAt, quoteIssuedAt].filter(
    (value): value is Date => value !== null && value !== undefined,
  );
  if (timestamps.length === 0) return null;
  return timestamps.reduce((earliest, candidate) =>
    candidate.getTime() < earliest.getTime() ? candidate : earliest,
  );
}

function parseOperatorQueueCursor(
  value: string,
  filterHash: string,
): OperatorQueueCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    const cursor = parsed as Record<string, unknown>;
    if (
      Object.keys(cursor).length !== 4 ||
      typeof cursor.slaDueAt !== "string" ||
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      typeof cursor.filterHash !== "string" ||
      !UUID_PATTERN.test(cursor.id) ||
      cursor.filterHash !== filterHash
    ) {
      throw new Error();
    }
    strictOperatorQueueInstant("cursor slaDueAt", cursor.slaDueAt);
    strictOperatorQueueInstant("cursor createdAt", cursor.createdAt);
    return cursor as OperatorQueueCursor;
  } catch {
    throw new BadRequestException("cursor is invalid");
  }
}

function encodeOperatorQueueCursor(value: OperatorQueueCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function strictOperatorQueueInstant(name: string, value: string): Date {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) throw new BadRequestException(`${name} is an ISO instant`);
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute =
    offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${name} is an ISO instant`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException(`${name} is an ISO instant`);
  }
  return date;
}

async function databaseNow(
  database: Pick<Transaction, "$queryRaw">,
): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now
  `;
  const observedAt = rows[0]?.now;
  if (!observedAt) throw new Error("database clock is unavailable");
  return observedAt;
}

async function individualSplitPaymentPolicyIsValid(
  database: Pick<Transaction, "$queryRaw">,
  priceListId: string,
): Promise<boolean> {
  const rows = await database.$queryRaw<Array<{ valid: boolean }>>`
    SELECT
      CASE
        WHEN jsonb_typeof("parameters" -> 'balance_payment_days') = 'number'
         AND ("parameters" ->> 'balance_payment_days') ~ '^[1-9][0-9]*$'
        THEN ("parameters" ->> 'balance_payment_days')::numeric <= 36500
        ELSE false
      END
      AND CASE
        WHEN jsonb_typeof(
          "parameters" -> 'balance_timeout_earned_component_kinds'
        ) = 'array'
        THEN jsonb_array_length(
          "parameters" -> 'balance_timeout_earned_component_kinds'
        ) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            "parameters" -> 'balance_timeout_earned_component_kinds'
          ) AS policy_kind("value")
          WHERE jsonb_typeof(policy_kind."value") <> 'string'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            "parameters" -> 'balance_timeout_earned_component_kinds'
          ) AS policy_kind("kind")
          WHERE policy_kind."kind" NOT IN (
            'ITEM_PRODUCTION', 'ITEM_QUANTITY', 'ITEM_POSTPROCESSING',
            'ORDER_MIN_PRINT', 'ORDER_SMALL_SURCHARGE', 'SHIPMENT',
            'EXPRESS', 'PAYMENT_FEE', 'VAT'
          )
        )
        AND NOT EXISTS (
          SELECT policy_kind."kind"
          FROM jsonb_array_elements_text(
            "parameters" -> 'balance_timeout_earned_component_kinds'
          ) AS policy_kind("kind")
          GROUP BY policy_kind."kind"
          HAVING count(*) > 1
        )
        ELSE false
      END AS valid
    FROM "price_lists"
    WHERE "id" = ${priceListId}::uuid
  `;
  return rows[0]?.valid === true;
}

type CoreModule = typeof import("@taven/core", {
  with: { "resolution-mode": "import" },
});

let loadedCore: Promise<CoreModule> | undefined;

function coreModule(): Promise<CoreModule> {
  loadedCore ??= import("@taven/core");
  return loadedCore;
}

function quoteCapabilityKeyRing(): {
  current: QuoteCapabilityKey;
  all: readonly QuoteCapabilityKey[];
  byId: ReadonlyMap<string, string>;
} {
  const currentKey = process.env.TAVEN_QUOTE_CAPABILITY_KEY;
  if (!currentKey || currentKey.length < 32) {
    throw new Error(
      "TAVEN_QUOTE_CAPABILITY_KEY must contain at least 32 characters",
    );
  }
  const previousKeys = previousQuoteCapabilityKeys();
  const keys = [currentKey, ...previousKeys].map((key) => {
    if (key.length < 32) {
      throw new Error(
        "Every TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS entry must contain at least 32 characters",
      );
    }
    return { id: quoteCapabilityKeyId(key), key } satisfies QuoteCapabilityKey;
  });
  return {
    current: keys[0]!,
    all: keys,
    byId: new Map(keys.map(({ id, key }) => [id, key])),
  };
}

function previousQuoteCapabilityKeys(): string[] {
  const serialized = process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS;
  if (!serialized) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(
      "TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS must be a JSON array of strings",
    );
  }
  if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== "string")) {
    throw new Error(
      "TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS must be a JSON array of strings",
    );
  }
  return parsed;
}

function quoteCapabilityKeyId(key: string): string {
  return createHash("sha256")
    .update("taven-quote-capability-key\0")
    .update(key)
    .digest("hex");
}

function capabilityToken(secret: string, ...scope: readonly string[]): string {
  return createHmac("sha256", secret)
    .update(scope.join("\0"))
    .digest("base64url");
}

function normalizeClientAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized || "unknown";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function matchesTokenHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bearerCapability(authorization?: string): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match?.[1]) {
    throw new UnauthorizedException("Capability is invalid");
  }
  return match[1];
}

function requireIdempotencyKey(value?: string): string {
  if (!value || value.trim().length < 8 || value.trim().length > 255) {
    throw new BadRequestException(
      "Idempotency-Key must contain between 8 and 255 characters",
    );
  }
  return value.trim();
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function batchesOf<T>(values: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += QUOTE_WRITE_BATCH_SIZE
  ) {
    batches.push(values.slice(offset, offset + QUOTE_WRITE_BATCH_SIZE));
  }
  return batches;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000);
}

export function addBusinessHours(value: Date, hours: number): Date {
  const result = new Date(value);
  let remainingMilliseconds = hours * 60 * 60 * 1_000;
  while (remainingMilliseconds > 0) {
    const day = result.getUTCDay();
    if (day === 0 || day === 6) {
      result.setUTCDate(result.getUTCDate() + (day === 6 ? 2 : 1));
      result.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const nextDay = new Date(result);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    nextDay.setUTCHours(0, 0, 0, 0);
    const consumed = Math.min(
      remainingMilliseconds,
      nextDay.getTime() - result.getTime(),
    );
    result.setTime(result.getTime() + consumed);
    remainingMilliseconds -= consumed;
  }
  return result;
}

function groupAttachmentsByRequest(
  attachments: RequestAttachments,
): Map<string, RequestAttachments> {
  const byRequest = new Map<string, RequestAttachments>();
  for (const attachment of attachments) {
    const requestAttachments = byRequest.get(attachment.scopeId) ?? [];
    requestAttachments.push(attachment);
    byRequest.set(attachment.scopeId, requestAttachments);
  }
  return byRequest;
}

function dateOnly(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function requiredInstant(value: unknown, name: string): Date {
  if (typeof value !== "string") {
    throw new BadRequestException(`${name} must be a date-time string`);
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !isValidDateTimeParts(match)) {
    throw new BadRequestException(`${name} must be an RFC 3339 date-time`);
  }
  const leapSecond = match[6] === "60";
  const parseableValue = leapSecond
    ? `${value.slice(0, 17)}59${value.slice(19)}`
    : value;
  const epochMilliseconds = Date.parse(parseableValue);
  if (!Number.isFinite(epochMilliseconds)) {
    throw new BadRequestException(`${name} must be an RFC 3339 date-time`);
  }
  return new Date(epochMilliseconds + (leapSecond ? 1_000 : 0));
}

function isValidDateTimeParts(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function optionalDate(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${name} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateOnly(parsed) !== value) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return parsed;
}

function requiredText(
  value: unknown,
  name: string,
  maximum: number,
  minimum = 1,
): string {
  if (typeof value !== "string") {
    throw new BadRequestException(`${name} must be a string`);
  }
  const normalized = value.trim();
  const characterCount = Array.from(normalized).length;
  if (characterCount < minimum || characterCount > maximum) {
    throw new BadRequestException(
      `${name} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  return normalized;
}

function optionalText(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, name, maximum);
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  const result = optionalObject(value, name);
  if (!result) throw new BadRequestException(`${name} is required`);
  return result;
}

function optionalObject(
  value: unknown,
  name: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException(`${name} must be an object`);
  }
  assertJsonDepth(value, name);
  return value as Record<string, unknown>;
}

function assertJsonDepth(value: object, name: string): void {
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 1, value },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > JSON_MAXIMUM_DEPTH) {
      throw new BadRequestException(
        `${name} must not exceed ${JSON_MAXIMUM_DEPTH} levels`,
      );
    }
    if (current.value === null || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === "object") {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }
}

function positiveInteger(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new BadRequestException(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new BadRequestException(
      `${name} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function money(value: unknown, name: string, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? (value as number) < 0 : (value as number) < 1)
  ) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value as number;
}

function normalizedUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function safeNumber(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error("Stored integer cannot be represented safely in JSON");
  }
  return converted;
}

function jsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonNullable(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return jsonInput(value) ?? Prisma.DbNull;
}

function nullableJsonObject(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function handoffItemSelections(
  value: Prisma.JsonValue,
): AutomaticQuoteRequestHandoffItemDto[] {
  if (!Array.isArray(value)) {
    throw new Error("Stored automatic quote handoff selections are invalid");
  }
  return value.map((value) => {
    const item = nullableJsonObject(value);
    if (
      !item ||
      typeof item.ordinal !== "number" ||
      !Number.isSafeInteger(item.ordinal) ||
      typeof item.modelFileId !== "string" ||
      !Array.isArray(item.bodyIds) ||
      !item.bodyIds.every((bodyId) => typeof bodyId === "string") ||
      typeof item.material !== "string" ||
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      typeof item.fitSensitive !== "boolean"
    ) {
      throw new Error("Stored automatic quote handoff selections are invalid");
    }
    return {
      ordinal: item.ordinal,
      modelFileId: item.modelFileId,
      bodyIds: item.bodyIds,
      material: item.material,
      quantity: item.quantity,
      fitSensitive: item.fitSensitive,
    };
  });
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return nullableJsonObject(value) ?? {};
}
