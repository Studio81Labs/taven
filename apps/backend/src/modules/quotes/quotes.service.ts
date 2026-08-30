import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AuditActorKind,
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
import { PrismaService } from "../../prisma/prisma.service";
import type {
  AcceptOfferDto,
  AcceptedOfferDto,
  CreateQuoteRequestDto,
  IssueOfferDto,
  ModelOfferItemDto,
  OfferIssuedDto,
  OfferPaymentScheduleDto,
  OfferPreviewDto,
  OfferPreviewPriceComponentDto,
  QuoteContactDto,
  QuoteRequestCreatedDto,
  QuoteRequestDetailDto,
  QuoteRequestStatusDto,
  RejectOfferDto,
} from "./quotes.dto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_SESSION_DAYS = 30;
const IDEMPOTENCY_DAYS = 7;
const ANONYMOUS_QUOTE_WINDOW_MILLISECONDS = 15 * 60 * 1_000;
const ANONYMOUS_QUOTE_CLIENT_MAX_ISSUED = 5;
const ANONYMOUS_QUOTE_GLOBAL_MAX_ISSUED = 100;
const ANONYMOUS_QUOTE_GLOBAL_SUBJECT = "global";
const ANONYMOUS_QUOTE_LIMIT_CLEANUP_BATCH = 100;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const JSON_MAXIMUM_DEPTH = 64;
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
  PriceComponentKind.EXPRESS,
] as const;

type Transaction = Prisma.TransactionClient;
type AnonymousQuoteLimitRow = {
  subject_hash: string;
  window_started_at: Date;
  window_expires_at: Date;
  issued_count: number;
};
type ExpiringResult<T> =
  Readonly<{ kind: "ok"; value: T }> | Readonly<{ kind: "expired" }>;
type IdempotencyResponseCodec<T> = Readonly<{
  toStoredResponse: (response: T) => unknown;
  fromStoredResponse: (response: Prisma.JsonValue) => T;
}>;

@Injectable()
export class QuotesService {
  constructor(private readonly prisma: PrismaService) {}

  async createRequest(
    input: CreateQuoteRequestDto,
    clientAddress: string,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestCreatedDto> {
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const request = validateCreateRequest(input);
    const clientSubjectHash = anonymousQuoteClientSubject(
      this.capabilityKey(),
      clientAddress,
    );
    const fingerprint = fingerprintOf({
      request: {
        ...request,
        requestedDate: request.requestedDate
          ? dateOnly(request.requestedDate)
          : undefined,
      },
      clientSubjectHash,
    });
    const requestToken = capabilityToken(
      this.capabilityKey(),
      "quote-request",
      commandKey,
      fingerprint,
    );

    return this.idempotent<QuoteRequestCreatedDto>(
      "quote-request.create",
      commandKey,
      fingerprint,
      async (transaction) => {
        await this.reserveAnonymousQuote(transaction, clientSubjectHash);
        const observedAt = await databaseNow(transaction);
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
            attribution: jsonNullable(request.attribution),
            slaDueAt,
            currentStateCommandKey: commandKey,
            currentStateResultId: resultId,
            createdAt: observedAt,
            updatedAt: observedAt,
          },
        });
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

        return {
          requestId,
          publicReference,
          requestToken,
          status: "NEW",
          slaDueAt: slaDueAt.toISOString(),
        } satisfies QuoteRequestCreatedDto;
      },
      {
        toStoredResponse: (response) => ({
          requestId: response.requestId,
          publicReference: response.publicReference,
          status: response.status,
          slaDueAt: response.slaDueAt,
        }),
        fromStoredResponse: (stored) => {
          const response = stored as unknown as Omit<
            QuoteRequestCreatedDto,
            "requestToken"
          >;
          return { ...response, requestToken };
        },
      },
    );
  }

  async getRequest(
    requestId: string,
    authorization?: string,
  ): Promise<QuoteRequestDetailDto> {
    assertUuid(requestId, "requestId");
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

  async listRequests(status?: string): Promise<QuoteRequestDetailDto[]> {
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
      include: { quoteSession: true, customer: true },
      orderBy: [{ slaDueAt: "asc" }, { createdAt: "asc" }],
      take: 100,
    });
    return Promise.all(
      requests.map((request) => this.requestDetail(request, observedAt)),
    );
  }

  async getOperatorRequest(requestId: string): Promise<QuoteRequestDetailDto> {
    assertUuid(requestId, "requestId");
    const observedAt = await databaseNow(this.prisma);
    const request = await this.prisma.quoteRequest.findUnique({
      where: { id: requestId },
      include: { quoteSession: true, customer: true },
    });
    if (!request) throw new NotFoundException("Quote request was not found");
    return this.requestDetail(request, observedAt);
  }

  async beginReview(
    requestId: string,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestStatusDto> {
    assertUuid(requestId, "requestId");
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
        await transaction.auditEvent.create({
          data: {
            quoteRequestId: requestId,
            eventType: "quote_request.review_started",
            actorKind: AuditActorKind.SYSTEM,
            idempotencyKey: commandKey,
            correlationId: resultId,
            payload: jsonInput({ requestId, operatorAuthenticated: true })!,
            createdAt: observedAt,
          },
        });
        return { requestId, status: "IN_REVIEW" };
      },
    );
  }

  async issueOffer(
    requestId: string,
    input: IssueOfferDto,
    idempotencyKey: string | undefined,
  ): Promise<OfferIssuedDto> {
    assertUuid(requestId, "requestId");
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const offer = validateOffer(input);
    const fingerprint = fingerprintOf({ requestId, ...offer.fingerprint });

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
        if (priceList.currency !== "CZK") {
          throw new BadRequestException("Individual v0 offers must use CZK");
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
          this.capabilityKey(),
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
        const snapshotId = randomUUID();
        const snapshotHash = fingerprintOf({
          quoteId,
          priceListId: priceList.id,
          pricingRevision: priceList.revision,
          inputSnapshot: offer.inputSnapshot,
          items: offer.fingerprint.items,
          components: offer.fingerprint.components,
          contractTotalMinor: offer.contractTotalMinor,
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
            version: 1,
            summary: offer.summary,
            termsRevision: priceList.termsRevision,
            termsSnapshot: jsonInput(offer.termsSnapshot)!,
            promisedDate: offer.promisedDate ?? null,
            issuanceCommandKey: commandKey,
            issuanceResultId: resultId,
            expiresAt: offer.expiresAt,
            issuedAt,
            createdAt: issuedAt,
          },
        });
        for (const item of quoteItems) {
          await transaction.quoteItem.create({
            data: {
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
            },
          });
        }
        await transaction.priceSnapshot.create({
          data: {
            id: snapshotId,
            priceListId: priceList.id,
            currency: priceList.currency,
            contractTotalMinor: BigInt(offer.contractTotalMinor),
            pricingRevision: priceList.revision,
            inputSnapshot: jsonInput({
              ...offer.inputSnapshot,
              quoteRequestId: requestId,
              quoteVersion: 1,
            })!,
            snapshotHash,
            createdAt: issuedAt,
          },
        });
        await transaction.quotePriceBinding.create({
          data: { quoteId, priceSnapshotId: snapshotId },
        });
        for (const component of offer.components) {
          const quoteItem =
            component.quoteItemOrdinal === undefined
              ? undefined
              : quoteItems[component.quoteItemOrdinal];
          await transaction.priceSnapshotComponent.create({
            data: {
              id: randomUUID(),
              priceSnapshotId: snapshotId,
              kind: component.kind,
              scope: quoteItem
                ? PriceComponentScope.QUOTE_ITEM
                : PriceComponentScope.ORDER,
              quoteItemId: quoteItem?.id ?? null,
              amountMinor: BigInt(component.amountMinor),
              allocation: jsonNullable(component.allocation),
              createdAt: issuedAt,
            },
          });
        }
        await transaction.paymentSchedule.createMany({
          data: [
            {
              id: randomUUID(),
              priceSnapshotId: snapshotId,
              sequence: 0,
              role: PaymentRole.DEPOSIT,
              grossAmountMinor: BigInt(offer.depositMinor),
              feeRateBasisPoints: 0,
              feeFixedMinor: BigInt(0),
              providerConfig: jsonInput({ mode: "provider-neutral" })!,
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
              feeRateBasisPoints: 0,
              feeFixedMinor: BigInt(0),
              providerConfig: jsonInput({ mode: "provider-neutral" })!,
              createdAt: issuedAt,
            },
          ],
        });
        await transaction.auditEvent.create({
          data: {
            quoteRequestId: requestId,
            quoteId,
            eventType: "quote_offer.issued",
            actorKind: AuditActorKind.SYSTEM,
            idempotencyKey: commandKey,
            correlationId: resultId,
            payload: jsonInput({
              requestId,
              quoteId,
              version: 1,
              termsRevision: priceList.termsRevision,
              priceSnapshotId: snapshotId,
              operatorAuthenticated: true,
            })!,
            createdAt: issuedAt,
          },
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
          termsRevision: priceList.termsRevision,
          offerToken,
          expiresAt: offer.expiresAt.toISOString(),
        } satisfies OfferIssuedDto;
      },
      {
        toStoredResponse: (response) => ({
          quoteId: response.quoteId,
          version: response.version,
          termsRevision: response.termsRevision,
          expiresAt: response.expiresAt,
        }),
        fromStoredResponse: (stored) => {
          const response = stored as unknown as Omit<
            OfferIssuedDto,
            "offerToken"
          >;
          return {
            ...response,
            offerToken: capabilityToken(
              this.capabilityKey(),
              "quote-offer",
              response.quoteId,
              commandKey,
            ),
          };
        },
      },
    );
  }

  async previewOffer(
    quoteId: string,
    authorization?: string,
  ): Promise<OfferPreviewDto> {
    assertUuid(quoteId, "quoteId");
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
    const components = snapshot.components
      .map((component) => {
        if (
          !ITEM_COMPONENTS.has(component.kind) &&
          !ORDER_COMPONENTS.has(component.kind)
        ) {
          throw new ConflictException("Offer price component kind is invalid");
        }
        if (
          component.scope !== PriceComponentScope.ORDER &&
          component.scope !== PriceComponentScope.QUOTE_ITEM
        ) {
          throw new ConflictException("Offer price component scope is invalid");
        }
        const quoteItemOrdinal = component.quoteItemId
          ? itemOrdinals.get(component.quoteItemId)
          : undefined;
        if (
          component.scope === PriceComponentScope.QUOTE_ITEM &&
          quoteItemOrdinal === undefined
        ) {
          throw new ConflictException(
            "Offer price component item is unavailable",
          );
        }
        return {
          kind: component.kind as OfferPreviewPriceComponentDto["kind"],
          scope: component.scope,
          quoteItemOrdinal: quoteItemOrdinal ?? null,
          amountMinor: safeNumber(component.amountMinor),
          allocation: nullableJsonObject(component.allocation),
        };
      })
      .sort(
        (left, right) =>
          (left.quoteItemOrdinal ?? Number.MAX_SAFE_INTEGER) -
            (right.quoteItemOrdinal ?? Number.MAX_SAFE_INTEGER) ||
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
    assertUuid(quoteId, "quoteId");
    const token = bearerCapability(authorization);
    const expected = validateExpectedOffer(input);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    await this.offerForToken(quoteId, token);
    const result = await this.idempotent<ExpiringResult<AcceptedOfferDto>>(
      "quote-offer.accept",
      commandKey,
      fingerprintOf({ quoteId, ...expected }),
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
        if (quote.quoteRequest.status === QuoteRequestStatus.ACCEPTED) {
          throw new ConflictException("Offer was already accepted");
        }
        if (quote.quoteRequest.status !== QuoteRequestStatus.QUOTED) {
          throw new GoneException("Offer is no longer available");
        }
        if (!quote.priceBinding?.priceSnapshot.sealedAt) {
          throw new ConflictException("Offer price is not sealed");
        }

        const orderId = randomUUID();
        const resultId = randomUUID();
        const publicReference = `I-${orderId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
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
        await transaction.quoteRequest.update({
          where: { id: quote.quoteRequestId },
          data: {
            status: QuoteRequestStatus.ACCEPTED,
            acceptedAt: observedAt,
            currentStateCommandKey: commandKey,
            currentStateResultId: resultId,
            updatedAt: observedAt,
          },
        });
        await transaction.individualOrderOrigin.create({
          data: { orderId, quoteId },
        });
        for (const quoteItem of quote.items) {
          const orderItemId = randomUUID();
          await transaction.orderItem.create({
            data: {
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
            },
          });
          await transaction.individualOrderItemSource.create({
            data: { orderItemId, quoteItemId: quoteItem.id },
          });
        }
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
    assertUuid(quoteId, "quoteId");
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
    );
    if (result.kind === "expired") {
      throw new GoneException("Offer is no longer available");
    }
    return result.value;
  }

  async expireOffer(
    requestId: string,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestStatusDto> {
    assertUuid(requestId, "requestId");
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
        await expireLockedOffer(transaction, quote, observedAt, commandKey);
        return { requestId, status: "EXPIRED" };
      },
    );
  }

  private async offerForToken(quoteId: string, token: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        quoteRequest: true,
        items: { orderBy: { ordinal: "asc" } },
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
    },
    observedAt: Date,
  ): Promise<QuoteRequestDetailDto> {
    const attachments = await this.prisma.photoAsset.findMany({
      where: {
        scopeKind: PhotoScopeKind.QUOTE_REQUEST,
        scopeId: request.id,
        deletedAt: null,
      },
      orderBy: { uploadedAt: "asc" },
    });
    const respondedAt =
      request.slaRespondedAt?.getTime() ?? observedAt.getTime();
    return {
      requestId: request.id,
      publicReference: request.publicReference,
      status: request.status,
      description: request.description,
      purpose: request.purpose,
      measurements: nullableJsonObject(request.measurements),
      requestedDate: dateOnly(request.requestedDate),
      contact: contactFrom(request.contactSnapshot, request.customer),
      attribution: nullableJsonObject(request.attribution),
      slaDueAt: request.slaDueAt.toISOString(),
      slaBreached: respondedAt > request.slaDueAt.getTime(),
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        mediaType: attachment.mediaType,
        sizeBytes: safeNumber(attachment.sizeBytes),
        uploadedAt: attachment.uploadedAt.toISOString(),
        deleteAfter: attachment.photoDeleteAfter.toISOString(),
      })),
    };
  }

  private capabilityKey(): string {
    const key = process.env.TAVEN_QUOTE_CAPABILITY_KEY;
    if (!key || key.length < 32) {
      throw new Error(
        "TAVEN_QUOTE_CAPABILITY_KEY must contain at least 32 characters",
      );
    }
    return key;
  }

  private async reserveAnonymousQuote(
    transaction: Transaction,
    subjectHash: string,
  ): Promise<void> {
    const observedAt = await databaseNow(transaction);
    const windowExpiresAt = new Date(
      observedAt.getTime() + ANONYMOUS_QUOTE_WINDOW_MILLISECONDS,
    );
    const global = await lockAnonymousQuoteLimit(
      transaction,
      ANONYMOUS_QUOTE_GLOBAL_SUBJECT,
      observedAt,
      windowExpiresAt,
    );
    const subject = await lockAnonymousQuoteLimit(
      transaction,
      subjectHash,
      observedAt,
      windowExpiresAt,
    );
    const currentGlobal = await resetExpiredQuoteLimit(
      transaction,
      global,
      observedAt,
      windowExpiresAt,
    );
    const currentSubject = await resetExpiredQuoteLimit(
      transaction,
      subject,
      observedAt,
      windowExpiresAt,
    );
    if (
      currentGlobal.issued_count >= ANONYMOUS_QUOTE_GLOBAL_MAX_ISSUED ||
      currentSubject.issued_count >= ANONYMOUS_QUOTE_CLIENT_MAX_ISSUED
    ) {
      throw new HttpException(
        "Anonymous quote-submission limit is exhausted",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await transaction.anonymousQuoteLimit.update({
      where: { subjectHash: ANONYMOUS_QUOTE_GLOBAL_SUBJECT },
      data: { issuedCount: { increment: 1 } },
    });
    await transaction.anonymousQuoteLimit.update({
      where: { subjectHash },
      data: { issuedCount: { increment: 1 } },
    });
    await transaction.$executeRaw`
      WITH expired AS (
        SELECT subject_hash
        FROM anonymous_quote_limits
        WHERE subject_hash <> ${ANONYMOUS_QUOTE_GLOBAL_SUBJECT}
          AND window_expires_at <= ${observedAt}
        ORDER BY window_expires_at, subject_hash
        FOR UPDATE SKIP LOCKED
        LIMIT ${ANONYMOUS_QUOTE_LIMIT_CLEANUP_BATCH}
      )
      DELETE FROM anonymous_quote_limits limits
      USING expired
      WHERE limits.subject_hash = expired.subject_hash
    `;
  }

  private async idempotent<T>(
    namespace: string,
    idempotencyKey: string,
    requestFingerprint: string,
    operation: (transaction: Transaction) => Promise<T>,
    responseCodec?: IdempotencyResponseCodec<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      const lockKey = `${namespace}:${idempotencyKey}`;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text
      `;
      const existing = await transaction.idempotencyRecord.findUnique({
        where: {
          namespace_idempotencyKey: { namespace, idempotencyKey },
        },
      });
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
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
        return responseCodec
          ? responseCodec.fromStoredResponse(existing.responseBody)
          : (existing.responseBody as T);
      }

      const observedAt = await databaseNow(transaction);
      const record = await transaction.idempotencyRecord.create({
        data: {
          namespace,
          idempotencyKey,
          requestFingerprint,
          expiresAt: addDays(observedAt, IDEMPOTENCY_DAYS),
        },
      });
      const response = await operation(transaction);
      const storedResponse = jsonInput(
        responseCodec ? responseCodec.toStoredResponse(response) : response,
      );
      if (storedResponse === undefined) {
        throw new Error("Idempotent response is not JSON serializable");
      }
      await transaction.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          status: IdempotencyStatus.COMPLETED,
          responseStatusCode: 200,
          responseBody: storedResponse,
        },
      });
      return response;
    });
  }
}

async function lockAnonymousQuoteLimit(
  transaction: Transaction,
  subjectHash: string,
  windowStartedAt: Date,
  windowExpiresAt: Date,
): Promise<AnonymousQuoteLimitRow> {
  await transaction.$executeRaw`
    INSERT INTO anonymous_quote_limits (
      subject_hash, window_started_at, window_expires_at,
      issued_count, updated_at
    ) VALUES (
      ${subjectHash}, ${windowStartedAt}, ${windowExpiresAt}, 0,
      clock_timestamp()
    )
    ON CONFLICT (subject_hash) DO NOTHING
  `;
  const rows = await transaction.$queryRaw<AnonymousQuoteLimitRow[]>`
    SELECT subject_hash, window_started_at, window_expires_at, issued_count
    FROM anonymous_quote_limits
    WHERE subject_hash = ${subjectHash}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error("anonymous quote limit row is unavailable");
  return row;
}

async function resetExpiredQuoteLimit(
  transaction: Transaction,
  row: AnonymousQuoteLimitRow,
  observedAt: Date,
  windowExpiresAt: Date,
): Promise<AnonymousQuoteLimitRow> {
  if (row.window_expires_at.getTime() > observedAt.getTime()) return row;
  await transaction.anonymousQuoteLimit.update({
    where: { subjectHash: row.subject_hash },
    data: {
      windowStartedAt: observedAt,
      windowExpiresAt,
      issuedCount: 0,
    },
  });
  return {
    ...row,
    window_started_at: observedAt,
    window_expires_at: windowExpiresAt,
    issued_count: 0,
  };
}

async function lockedRequest(transaction: Transaction, requestId: string) {
  await transaction.$queryRaw`
    SELECT "id" FROM "quote_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE
  `;
  return transaction.quoteRequest.findUnique({ where: { id: requestId } });
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
      priceBinding: { include: { priceSnapshot: true } },
    },
  });
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
    attribution: optionalObject(input.attribution, "attribution"),
  };
}

function validateContact(input: QuoteContactDto | undefined): QuoteContactDto {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestException("contact is required");
  }
  const email = requiredText(input.email, "contact.email", 320).toLowerCase();
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
  assertUuid(input.priceListId, "priceListId");
  const contractTotalMinor = money(
    input.contractTotalMinor,
    "contractTotalMinor",
  );
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
  if (!Array.isArray(input.components) || input.components.length < 1) {
    throw new BadRequestException("components must not be empty");
  }
  const componentKeys = new Set<string>();
  const components = input.components.map((component) => {
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
  const componentTotal = components.reduce(
    (total, component) => total + component.amountMinor,
    0,
  );
  if (componentTotal !== contractTotalMinor) {
    throw new BadRequestException(
      "Price components must sum to contractTotalMinor",
    );
  }
  const expiresAt = requiredInstant(input.expiresAt, "expiresAt");
  const promisedDate = optionalDate(input.promisedDate, "promisedDate");
  const termsSnapshot = requiredObject(input.termsSnapshot, "termsSnapshot");
  const inputSnapshot = requiredObject(input.inputSnapshot, "inputSnapshot");
  const summary = requiredText(input.summary, "summary", 4_000, 3);
  return {
    summary,
    expiresAt,
    promisedDate,
    priceListId: input.priceListId,
    contractTotalMinor,
    depositMinor,
    termsSnapshot,
    inputSnapshot,
    items,
    components,
    fingerprint: {
      summary,
      expiresAt: expiresAt.toISOString(),
      promisedDate: dateOnly(promisedDate),
      priceListId: input.priceListId,
      contractTotalMinor,
      depositMinor,
      termsSnapshot,
      inputSnapshot,
      items: items.map(serializableItem),
      components,
    },
  };
}

function validateOfferItem(input: ModelOfferItemDto, ordinal: number) {
  if (!input || typeof input !== "object") {
    throw new BadRequestException(`Item ${ordinal} is invalid`);
  }
  if (input.kind !== "MODEL") {
    throw new BadRequestException(`items[${ordinal}].kind is invalid`);
  }
  assertUuid(input.sourceModelFileId, `items[${ordinal}].sourceModelFileId`);
  assertUuid(input.modelGeometryId, `items[${ordinal}].modelGeometryId`);
  assertUuid(
    input.printConfigRevisionId,
    `items[${ordinal}].printConfigRevisionId`,
  );
  if (input.primaryReferenceSliceResultId) {
    assertUuid(
      input.primaryReferenceSliceResultId,
      `items[${ordinal}].primaryReferenceSliceResultId`,
    );
  }
  if (input.tailReferenceSliceResultId) {
    assertUuid(
      input.tailReferenceSliceResultId,
      `items[${ordinal}].tailReferenceSliceResultId`,
    );
  }
  if (!input.material || !Object.values(Material).includes(input.material)) {
    throw new BadRequestException(`items[${ordinal}].material is invalid`);
  }
  const quantity = positiveInteger(
    input.quantity ?? 1,
    `items[${ordinal}].quantity`,
    POSTGRES_INTEGER_MAX,
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
    sourceModelFileId: input.sourceModelFileId,
    modelGeometryId: input.modelGeometryId,
    printConfigRevisionId: input.printConfigRevisionId,
    primaryReferenceSliceResultId: input.primaryReferenceSliceResultId,
    tailReferenceSliceResultId: input.tailReferenceSliceResultId,
    referencePartsPerPlate,
    material: input.material as Material,
    color: optionalText(input.color, `items[${ordinal}].color`, 100),
    quantity,
  };
}

async function validateOfferItemReferences(
  transaction: Transaction,
  items: Array<ReturnType<typeof validateOfferItem>>,
  observedAt: Date,
): Promise<void> {
  for (const [ordinal, item] of items.entries()) {
    const [geometry, printConfig, primarySlice, tailSlice] = await Promise.all([
      transaction.modelGeometry.findUnique({
        where: { id: item.modelGeometryId },
        include: { sourceModelFile: true },
      }),
      transaction.printConfigRevision.findUnique({
        where: { id: item.printConfigRevisionId },
        select: { id: true },
      }),
      item.primaryReferenceSliceResultId
        ? transaction.sliceResult.findUnique({
            where: { id: item.primaryReferenceSliceResultId },
            include: { referenceProfile: true },
          })
        : undefined,
      item.tailReferenceSliceResultId
        ? transaction.sliceResult.findUnique({
            where: { id: item.tailReferenceSliceResultId },
            include: { referenceProfile: true },
          })
        : undefined,
    ]);
    const source = geometry?.sourceModelFile;
    if (
      !geometry ||
      !source ||
      geometry.sourceModelFileId !== item.sourceModelFileId ||
      geometry.deletedAt !== null ||
      source.deletedAt !== null ||
      (source.retentionHold === RetentionHold.NONE &&
        source.sourceDeleteAfter.getTime() <= observedAt.getTime()) ||
      !printConfig
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
            'EXPRESS', 'PAYMENT_FEE'
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
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
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
  if (normalized.length < minimum || normalized.length > maximum) {
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

function money(value: unknown, name: string, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? (value as number) < 0 : (value as number) < 1)
  ) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value as number;
}

function assertUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${name} must be a lowercase UUID`);
  }
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

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return nullableJsonObject(value) ?? {};
}
