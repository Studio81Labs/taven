import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { IdempotencyStatus, PaymentStatus, Prisma } from "@prisma/client";
import { assertCheckoutPaymentFlowsEnabled } from "../../launch-approval-gates";
import { PrismaService } from "../../prisma/prisma.service";
import {
  DELIVERY_CAPABILITY,
  type DeliveryCapabilityPort,
  type ResolvedDeliveryCapability,
} from "../automatic-quotes/delivery-capability.port";
import { EligibilityPlanService } from "../resources/eligibility-plan.service";
import { ResourceReservationService } from "../resources/resource-reservation.service";
import type {
  CreateCheckoutPaymentDto,
  CheckoutPaymentDto,
} from "./payments.dto";
import {
  PAYMENT_PROVIDER,
  type CheckoutPaymentMethod,
  PaymentIntentCreationError,
  type PaymentProviderPort,
  type VerifiedPaymentEvent,
} from "./payment-provider.port";

const CHECKOUT_CAPTURE_MILLISECONDS = 60 * 60 * 1_000;
const IDEMPOTENCY_DAYS = 7;
type Transaction = Prisma.TransactionClient;

type CheckoutContext = Awaited<ReturnType<PaymentsService["loadContext"]>>;

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
    @Inject(DELIVERY_CAPABILITY)
    private readonly deliveryCapabilities: DeliveryCapabilityPort,
    @Inject(EligibilityPlanService)
    private readonly eligibilityPlans: EligibilityPlanService,
    @Inject(ResourceReservationService)
    private readonly reservations: ResourceReservationService,
  ) {}

  async capabilities() {
    const value = await this.provider.capabilities();
    return { provider: value.provider, methods: [...value.methods] };
  }

  async createCheckoutPayment(
    sessionIdInput: string,
    bodyInput: CreateCheckoutPaymentDto,
    authorization?: string,
    idempotencyKeyInput?: string,
  ): Promise<CheckoutPaymentDto> {
    const sessionId = normalizedUuid(sessionIdInput, "sessionId");
    const token = bearerCapability(authorization);
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyInput);
    const input = checkoutInput(bodyInput);
    const initial = await this.loadContext(sessionId);
    assertSessionCapability(initial, token);
    const fingerprint = fingerprintOf({ sessionId, ...input });
    const initialIdempotency = await this.prisma.$transaction(
      async (transaction) => {
        await lockIdempotencyKey(transaction, sessionId, idempotencyKey);
        return checkoutIdempotencyAfterLock(
          transaction,
          sessionId,
          idempotencyKey,
          fingerprint,
        );
      },
    );
    if (initialIdempotency.replay) return initialIdempotency.replay;
    const claimPolicyRevision = assertCheckoutPaymentFlowsEnabled();

    const capabilities = await this.provider.capabilities();
    if (!capabilities.methods.includes(input.method)) {
      throw new BadRequestException("Payment method is unavailable");
    }
    assertCheckoutContext(initial, token);
    const destination =
      initial.order.automaticQuoteDraft!.selectedDeliveryDestination!;
    const resolvedDestination = await this.deliveryCapabilities.resolve({
      providerEndpointId: destination.providerEndpointId,
      endpointType: destination.endpointType,
    });
    assertDestinationStillCurrent(initial, resolvedDestination);
    const returnUrls = checkoutReturnUrls(publicSiteUrl(), sessionId);

    const staged = await this.prisma.$transaction(async (transaction) => {
      await lockIdempotencyKey(transaction, sessionId, idempotencyKey);
      const idempotency = await checkoutIdempotencyAfterLock(
        transaction,
        sessionId,
        idempotencyKey,
        fingerprint,
      );
      if (idempotency.replay) return { replay: idempotency.replay } as const;

      const context = await this.loadContext(sessionId, transaction, true);
      assertCheckoutContext(context, token);
      assertDestinationStillCurrent(context, resolvedDestination);
      const binding = context.order.activePriceBinding!.orderPriceBinding;
      const schedule = binding.priceSnapshot.paymentSchedules.find(
        ({ role }) => role === "FULL",
      );
      if (!schedule)
        throw new ConflictException("Payment schedule is unavailable");

      const active = await transaction.payment.findFirst({
        where: {
          paymentScheduleId: schedule.id,
          status: { in: ["CREATED", "PENDING", "CAPTURED"] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (active?.status === PaymentStatus.CREATED) {
        throw new ConflictException(
          "Payment intent creation is still incomplete",
        );
      }
      const record = await transaction.idempotencyRecord.create({
        data: {
          namespace: checkoutNamespace(sessionId),
          idempotencyKey,
          generation: idempotency.nextGeneration,
          requestFingerprint: fingerprint,
          expiresAt: addDays(idempotency.observedAt, IDEMPOTENCY_DAYS),
        },
      });
      if (active) {
        const response = paymentDto(active);
        await completeIdempotency(transaction, record.id, response);
        return { replay: response } as const;
      }

      const observedAt = await databaseNow(transaction);
      const customer = await transaction.customer.upsert({
        where: { email: input.email },
        create: {
          email: input.email,
          displayName: input.fullName,
          ...(context.attribution === null
            ? {}
            : { firstAttribution: jsonInput(context.attribution) }),
        },
        update: { displayName: input.fullName },
      });
      if (context.customerId && context.customerId !== customer.id) {
        throw new ConflictException("Checkout customer identity changed");
      }
      if (
        context.order.customerId &&
        context.order.customerId !== customer.id
      ) {
        throw new ConflictException("Order customer identity changed");
      }
      await transaction.quoteSession.update({
        where: { id: sessionId },
        data: { customerId: customer.id },
      });
      await transaction.order.update({
        where: { id: context.order.id },
        data: {
          customerId: customer.id,
          ...(context.order.acceptedOrderPriceBindingId
            ? {}
            : { acceptedOrderPriceBindingId: binding.id }),
          ...(context.order.acceptedTermsRevision
            ? {}
            : {
                acceptedTermsRevision:
                  binding.priceSnapshot.priceList.termsRevision,
              }),
          ...(context.order.acceptedClaimPolicyRevision
            ? {}
            : {
                acceptedClaimPolicyRevision: claimPolicyRevision,
              }),
          ...(context.order.withdrawalExceptionAcknowledgedAt
            ? {}
            : { withdrawalExceptionAcknowledgedAt: observedAt }),
        },
      });
      const paymentId = randomUUID();
      const payment = await transaction.payment.create({
        data: {
          id: paymentId,
          orderId: context.order.id,
          priceSnapshotId: binding.priceSnapshotId,
          orderPriceBindingId: binding.id,
          paymentScheduleId: schedule.id,
          role: schedule.role,
          provider: capabilities.provider,
          checkoutMethod: input.method,
          merchantReference: paymentId,
          checkoutCommandId: record.id,
          requestedAmountMinor: schedule.grossAmountMinor,
          currency: binding.priceSnapshot.currency,
          checkoutCaptureExpiresAt: new Date(
            observedAt.getTime() + CHECKOUT_CAPTURE_MILLISECONDS,
          ),
          createdAt: observedAt,
        },
      });
      return {
        payment,
        idempotencyRecordId: record.id,
        orderReference: context.order.publicReference,
      } as const;
    });
    if ("replay" in staged) return staged.replay;

    let intent;
    try {
      intent = await this.provider.createIntent({
        paymentId: staged.payment.id,
        merchantReference: staged.payment.merchantReference!,
        orderReference: staged.orderReference,
        amountMinor: staged.payment.requestedAmountMinor,
        currency: staged.payment.currency,
        method: input.method,
        email: input.email,
        fullName: input.fullName,
        expiresAt: staged.payment.checkoutCaptureExpiresAt!,
        returnUrls,
      });
    } catch (error) {
      if (
        error instanceof PaymentIntentCreationError &&
        error.providerIntentId
      ) {
        const closed = await this.closeReturnedIntent(
          staged.payment.id,
          staged.idempotencyRecordId,
          error.providerIntentId,
        ).catch(() => null);
        if (closed) return closed;
        await this.provider
          .cancelIntent(error.providerIntentId)
          .catch(() => undefined);
      } else if (
        error instanceof PaymentIntentCreationError &&
        error.outcome === "DEFINITIVE_FAILURE"
      ) {
        await this.recordIntentFailure(
          staged.payment.id,
          staged.idempotencyRecordId,
          staged.idempotencyRecordId,
        );
      } else {
        const reconciled = await this.recordIntentAmbiguity(
          staged.payment.id,
          staged.idempotencyRecordId,
        );
        if (reconciled) return reconciled;
      }
      throw new BadGatewayException("Payment provider is unavailable");
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await lockPaymentEnvelope(transaction, staged.payment.id);
        const payment = await transaction.payment.findUniqueOrThrow({
          where: { id: staged.payment.id },
        });
        if (payment.status !== PaymentStatus.CREATED) {
          if (payment.providerIntentId === intent.providerIntentId) {
            const reconciled =
              payment.status === PaymentStatus.PENDING &&
              !payment.providerCheckoutUrl
                ? await transaction.payment.update({
                    where: { id: payment.id },
                    data: { providerCheckoutUrl: intent.checkoutUrl },
                  })
                : payment;
            const response = paymentDto(reconciled);
            await completeIdempotency(
              transaction,
              staged.idempotencyRecordId,
              response,
            );
            return response;
          }
          throw new ConflictException(
            "Checkout payment closed during intent creation",
          );
        }
        const pending = await transaction.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.PENDING,
            providerIntentId: intent.providerIntentId,
            providerCheckoutUrl: intent.checkoutUrl,
          },
        });
        const response = paymentDto(pending);
        await completeIdempotency(
          transaction,
          staged.idempotencyRecordId,
          response,
        );
        return response;
      });
    } catch (error) {
      const closed = await this.closeReturnedIntent(
        staged.payment.id,
        staged.idempotencyRecordId,
        intent.providerIntentId,
      ).catch(() => null);
      if (closed) return closed;
      await this.provider
        .cancelIntent(intent.providerIntentId)
        .catch(() => undefined);
      throw error;
    }
  }

  async getCheckoutPayment(
    sessionIdInput: string,
    authorization?: string,
  ): Promise<CheckoutPaymentDto> {
    const context = await this.loadContext(
      normalizedUuid(sessionIdInput, "sessionId"),
    );
    assertSessionCapability(context, bearerCapability(authorization));
    const payment = await this.prisma.payment.findFirst({
      where: { orderId: context.order.id },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) throw new NotFoundException("Checkout payment was not found");
    return paymentDto(payment);
  }

  async cancelCheckoutPayment(
    sessionIdInput: string,
    authorization?: string,
  ): Promise<CheckoutPaymentDto> {
    const context = await this.loadContext(
      normalizedUuid(sessionIdInput, "sessionId"),
    );
    assertSessionCapability(context, bearerCapability(authorization));
    const payment = await this.prisma.payment.findFirst({
      where: { orderId: context.order.id },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) throw new NotFoundException("Checkout payment was not found");
    await this.prisma.$queryRaw`
      SELECT taven_close_initial_checkout_payment(
        ${payment.id}::uuid, 'CUSTOMER_CANCELLED'
      )::text
    `;
    return paymentDto(
      await this.prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      }),
    );
  }

  async consumeProviderEvent(
    provider: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
    body: unknown,
  ): Promise<{ outcome: string }> {
    if (provider !== this.provider.providerName()) {
      throw new NotFoundException("Payment provider webhook is unavailable");
    }
    const event = await this.provider.verifyEvent({ headers, body });
    const captureContextCurrent =
      event.status === "CAPTURED"
        ? await this.isCaptureContextCurrent(event)
        : true;
    if (event.status === "CAPTURED" && captureContextCurrent) {
      await this.tryReacquireForCapture(event);
    }
    const kind =
      event.status === "CAPTURED"
        ? "PAYMENT_CAPTURED"
        : event.status === "FAILED"
          ? "PAYMENT_FAILED"
          : "PAYMENT_PENDING";
    const rows = await this.prisma.$queryRaw<Array<{ outcome: string }>>`
      SELECT taven_apply_checkout_payment_event(
        ${event.provider}, ${event.providerEventId},
        ${event.providerTransactionId},
        ${kind}::payment_provider_event_kind,
        ${event.amountMinor}, ${event.currency}::char(3),
        ${event.occurredAt}, ${jsonInput(event.evidence)}::jsonb,
        ${captureContextCurrent}, ${event.merchantReference}
      ) AS outcome
    `;
    return { outcome: rows[0]?.outcome ?? "IGNORED" };
  }

  private async isCaptureContextCurrent(
    event: VerifiedPaymentEvent,
  ): Promise<boolean> {
    try {
      const payment = await this.prisma.payment.findFirst({
        where: {
          provider: event.provider,
          OR: [
            { providerIntentId: event.providerTransactionId },
            {
              providerIntentId: null,
              merchantReference: event.merchantReference,
            },
          ],
        },
        select: {
          orderId: true,
          orderPriceBindingId: true,
        },
      });
      if (!payment) return false;
      const origin = await this.prisma.automaticOrderOrigin.findUnique({
        where: { orderId: payment.orderId },
        select: { quoteSessionId: true },
      });
      if (!origin) return false;
      const context = await this.loadContext(origin.quoteSessionId);
      assertCheckoutTopology(context);
      if (
        context.order.activePriceBinding?.orderPriceBinding.id !==
        payment.orderPriceBindingId
      ) {
        return false;
      }
      const destination =
        context.order.automaticQuoteDraft!.selectedDeliveryDestination!;
      const resolved = await this.deliveryCapabilities.resolve({
        providerEndpointId: destination.providerEndpointId,
        endpointType: destination.endpointType,
      });
      assertDestinationStillCurrent(context, resolved);
      return true;
    } catch {
      return false;
    }
  }

  private async tryReacquireForCapture(event: VerifiedPaymentEvent) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        provider: event.provider,
        OR: [
          { providerIntentId: event.providerTransactionId },
          {
            providerIntentId: null,
            merchantReference: event.merchantReference,
          },
        ],
      },
      include: {
        orderPriceBinding: true,
        reacquiredPhaseReservationSets: true,
      },
    });
    if (
      !payment ||
      (payment.status !== PaymentStatus.CREATED &&
        payment.status !== PaymentStatus.PENDING) ||
      !payment.captureAuthorized ||
      !payment.checkoutCaptureExpiresAt ||
      payment.checkoutCaptureExpiresAt.getTime() <= Date.now()
    ) {
      return;
    }
    const phase = await this.prisma.orderPhase.findUnique({
      where: { orderId: payment.orderId },
      include: {
        eligibilitySnapshots: {
          include: {
            phaseResourcePlans: { include: { reservationSets: true } },
          },
          orderBy: { calculatedAt: "desc" },
        },
      },
    });
    if (!phase) return;
    const sets = phase.eligibilitySnapshots.flatMap(({ phaseResourcePlans }) =>
      phaseResourcePlans.flatMap(({ reservationSets }) => reservationSets),
    );
    if (
      sets.some(
        (set) =>
          set.status === "RESERVED" && set.expiresAt.getTime() > Date.now(),
      )
    ) {
      return;
    }
    const previous = [...sets].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    )[0];
    const previousPlan = phase.eligibilitySnapshots
      .flatMap(({ phaseResourcePlans }) => phaseResourcePlans)
      .find((plan) => plan?.id === previous?.phaseResourcePlanId);
    if (!previous || !previousPlan) return;
    try {
      if (previous.status === "RESERVED") {
        await this.reservations.releaseBeforePrint(previous.id);
      }
      const suffix = createHash("sha256")
        .update(event.providerEventId)
        .digest("hex")
        .slice(0, 24);
      const plan = await this.eligibilityPlans.createCompletePlan({
        nodeId: previous.nodeId,
        orderPhaseId: phase.id,
        planKey: `capture-reacquire-plan:${payment.id}:${suffix}`,
      });
      await this.reservations.reacquireForCapture({
        previousPhaseReservationSetId: previous.id,
        nodeId: previous.nodeId,
        phaseResourcePlanId: plan.phaseResourcePlanId,
        reservationKey: `capture-reacquire:${payment.id}:${suffix}`,
        paymentId: payment.id,
      });
    } catch {
      // The database event transition below converts a verified capture into
      // full compensation when resources cannot be reacquired. No provider
      // evidence is discarded and no Job is created on this path.
    }
  }

  private async recordIntentFailure(
    paymentId: string,
    idempotencyRecordId: string,
    attemptKey: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockPaymentEnvelope(transaction, paymentId);
      const payment = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      if (payment.status !== PaymentStatus.CREATED) return;
      const failedAt = await databaseNow(transaction);
      const failure = await transaction.paymentIntentCreationFailure.create({
        data: {
          paymentId,
          provider: payment.provider,
          attemptKey: `checkout-intent:${createHash("sha256")
            .update(attemptKey, "utf8")
            .digest("hex")}`,
          failedAt,
        },
      });
      await transaction.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.FAILED,
          captureAuthorized: false,
          captureCutoffAt: failedAt,
          intentCreationFailureResultId: failure.id,
        },
      });
      await completeIdempotency(transaction, idempotencyRecordId, {
        paymentId,
        status: "FAILED",
      });
    });
  }

  private async recordIntentAmbiguity(
    paymentId: string,
    idempotencyRecordId: string,
  ): Promise<CheckoutPaymentDto | null> {
    return this.prisma.$transaction(async (transaction) => {
      await lockPaymentEnvelope(transaction, paymentId);
      const payment = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      if (payment.status !== PaymentStatus.CREATED) {
        const response = paymentDto(payment);
        await completeIdempotency(transaction, idempotencyRecordId, response);
        return response;
      }
      await transaction.auditEvent.create({
        data: {
          orderId: payment.orderId,
          paymentId: payment.id,
          correlationId: idempotencyRecordId,
          eventType: "checkout.payment_intent_creation_ambiguous",
          actorKind: "SYSTEM",
          payload: jsonInput({
            checkoutCommandId: idempotencyRecordId,
            merchantReference: payment.merchantReference,
            provider: payment.provider,
          }),
        },
      });
      return null;
    });
  }

  private async closeReturnedIntent(
    paymentId: string,
    idempotencyRecordId: string,
    providerIntentId: string,
  ): Promise<CheckoutPaymentDto | null> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT taven_lock_checkout_payment_envelope(${paymentId}::uuid)::text
      `;
      let payment = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      if (payment.status === PaymentStatus.CREATED) {
        await transaction.$queryRaw`
          SELECT taven_close_initial_checkout_payment(
            ${paymentId}::uuid, 'CUSTOMER_CANCELLED'
          )::text
        `;
        payment = await transaction.payment.findUniqueOrThrow({
          where: { id: paymentId },
        });
      } else if (payment.status !== PaymentStatus.VOIDED) {
        return null;
      }
      const existingOwner = await transaction.payment.findFirst({
        where: {
          provider: payment.provider,
          providerIntentId,
          id: { not: paymentId },
        },
        select: { id: true },
      });
      if (existingOwner) {
        const closed = await transaction.payment.findUniqueOrThrow({
          where: { id: paymentId },
        });
        const response = paymentDto(closed);
        await completeIdempotency(transaction, idempotencyRecordId, response);
        return response;
      }
      await transaction.outboxMessage.createMany({
        data: [
          {
            deduplicationKey: `void_payment:v1:${paymentId}`,
            aggregateType: "Payment",
            aggregateId: paymentId,
            messageType: "void_payment",
            schemaVersion: 1,
            payload: jsonInput({
              paymentId,
              provider: payment.provider,
              providerIntentId,
              action: "void_payment",
            }),
          },
        ],
        skipDuplicates: true,
      });
      const closed = await transaction.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      const response = paymentDto(closed);
      await completeIdempotency(transaction, idempotencyRecordId, response);
      return response;
    });
  }

  private loadContext(
    sessionId: string,
    client: PrismaService | Transaction = this.prisma,
    lock = false,
  ) {
    const read = async () => {
      if (lock) {
        await (client as Transaction).$queryRaw`
          SELECT session.id
          FROM quote_sessions session
          JOIN automatic_order_origins origin
            ON origin.quote_session_id = session.id
          JOIN orders target_order ON target_order.id = origin.order_id
          WHERE session.id = ${sessionId}::uuid
          FOR UPDATE OF session, target_order
        `;
      }
      return client.quoteSession.findUnique({
        where: { id: sessionId },
        include: {
          automaticOrderOrigin: {
            include: {
              order: {
                include: {
                  automaticQuoteDraft: {
                    include: { selectedDeliveryDestination: true },
                  },
                  activePriceBinding: {
                    include: {
                      orderPriceBinding: {
                        include: {
                          priceSnapshot: {
                            include: {
                              priceList: true,
                              paymentSchedules: true,
                            },
                          },
                          shipmentPlans: true,
                        },
                      },
                    },
                  },
                  phases: true,
                },
              },
            },
          },
        },
      });
    };
    return read().then((session) => {
      if (!session?.automaticOrderOrigin?.order.automaticQuoteDraft) {
        throw new NotFoundException("Automatic quote session was not found");
      }
      return { ...session, order: session.automaticOrderOrigin.order };
    });
  }
}

function assertCheckoutContext(context: CheckoutContext, token: string): void {
  assertSessionCapability(context, token);
  if (
    context.status !== "CONVERTED" ||
    context.expiresAt.getTime() <= Date.now()
  ) {
    throw new GoneException("Automatic quote session is no longer payable");
  }
  assertCheckoutTopology(context);
}

function assertCheckoutTopology(context: CheckoutContext): void {
  const order = context.order;
  const draft = order.automaticQuoteDraft;
  const binding = order.activePriceBinding?.orderPriceBinding;
  if (
    order.status !== "QUOTED" ||
    !draft?.selectedDeliveryDestination ||
    !binding ||
    binding.invalidatedAt ||
    binding.deliveryDestinationId !== draft.selectedDeliveryDestinationId ||
    order.phases.length !== 1 ||
    order.phases[0]?.status !== "QUOTED"
  ) {
    throw new ConflictException("Checkout topology is no longer current");
  }
  const automatic = asRecord(
    binding.priceSnapshot.inputSnapshot,
  )?.automaticQuote;
  const snapshot = asRecord(automatic);
  if (
    snapshot?.configurationRevision !== draft.configurationRevision ||
    snapshot.expressRequested !== draft.expressRequested
  ) {
    throw new ConflictException(
      "Price binding changed after quote preparation",
    );
  }
}

function assertDestinationStillCurrent(
  context: CheckoutContext,
  resolved: ResolvedDeliveryCapability,
): void {
  const destination =
    context.order.automaticQuoteDraft!.selectedDeliveryDestination!;
  const binding = context.order.activePriceBinding!.orderPriceBinding;
  const categories = new Set(resolved.supportedCategoryIds);
  if (
    destination.providerEndpointId !== resolved.providerEndpointId ||
    destination.endpointType !== resolved.endpointType ||
    canonicalJson(destination.addressSnapshot) !==
      canonicalJson(resolved.addressSnapshot) ||
    canonicalJson(destination.capabilitySnapshot) !==
      canonicalJson(resolved.capabilitySnapshot) ||
    binding.shipmentPlans.some((plan) => !categories.has(plan.category))
  ) {
    throw new ConflictException("Delivery capability changed before payment");
  }
}

function assertSessionCapability(
  context: { publicTokenHash: string },
  token: string,
): void {
  const actual = Buffer.from(
    createHash("sha256").update(token).digest("hex"),
    "hex",
  );
  const expected = Buffer.from(context.publicTokenHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new UnauthorizedException("Capability is invalid");
  }
}

function checkoutInput(value: CreateCheckoutPaymentDto) {
  const email = requiredText(value?.email, "email", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BadRequestException("email is invalid");
  }
  const method = value?.method;
  if (method !== "CARD" && method !== "BANK_TRANSFER") {
    throw new BadRequestException("method is invalid");
  }
  if (
    value.acceptTerms !== true ||
    value.acceptClaimPolicy !== true ||
    value.acknowledgeWithdrawalException !== true
  ) {
    throw new BadRequestException(
      "Required checkout acknowledgements are missing",
    );
  }
  return {
    email,
    fullName: requiredText(value.fullName, "fullName", 200),
    method: method as CheckoutPaymentMethod,
    acceptTerms: true,
    acceptClaimPolicy: true,
    acknowledgeWithdrawalException: true,
  } as const;
}

function paymentDto(payment: {
  id: string;
  provider: string;
  checkoutMethod: string;
  status: PaymentStatus;
  requestedAmountMinor: bigint;
  currency: string;
  providerCheckoutUrl: string | null;
  checkoutCaptureExpiresAt: Date | null;
}): CheckoutPaymentDto {
  if (
    payment.checkoutMethod !== "CARD" &&
    payment.checkoutMethod !== "BANK_TRANSFER"
  ) {
    throw new ConflictException("Payment method is unavailable");
  }
  if (!payment.checkoutCaptureExpiresAt) {
    throw new ConflictException("Checkout payment has no capture deadline");
  }
  const amountMinor = Number(payment.requestedAmountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    throw new ConflictException("Checkout amount is outside the API range");
  }
  return {
    paymentId: payment.id,
    provider: payment.provider,
    method: payment.checkoutMethod,
    status: payment.status,
    amountMinor,
    currency: payment.currency,
    checkoutUrl: payment.providerCheckoutUrl,
    expiresAt: payment.checkoutCaptureExpiresAt.toISOString(),
  };
}

async function checkoutIdempotencyAfterLock(
  transaction: Transaction,
  sessionId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<{
  replay: CheckoutPaymentDto | null;
  nextGeneration: number;
  observedAt: Date;
}> {
  const observedAt = await databaseNow(transaction);
  const existing = await transaction.idempotencyRecord.findFirst({
    where: { namespace: checkoutNamespace(sessionId), idempotencyKey },
    orderBy: { generation: "desc" },
  });
  if (!existing || existing.expiresAt.getTime() <= observedAt.getTime()) {
    return {
      replay: null,
      nextGeneration: (existing?.generation ?? 0) + 1,
      observedAt,
    };
  }
  if (existing.requestFingerprint !== fingerprint) {
    throw new ConflictException(
      "Idempotency key was used with different input",
    );
  }
  if (
    existing.status !== IdempotencyStatus.COMPLETED ||
    !existing.responseBody
  ) {
    const reconciledPayment = await transaction.payment.findUnique({
      where: { checkoutCommandId: existing.id },
    });
    if (
      reconciledPayment &&
      reconciledPayment.status !== PaymentStatus.CREATED
    ) {
      const replay = paymentDto(reconciledPayment);
      await completeIdempotency(transaction, existing.id, replay);
      return {
        replay,
        nextGeneration: existing.generation,
        observedAt,
      };
    }
    throw new ConflictException("Payment intent creation is still incomplete");
  }
  const response = existing.responseBody as Record<string, unknown>;
  if (response.status === "FAILED") {
    throw new BadGatewayException("Payment provider is unavailable");
  }
  return {
    replay: response as unknown as CheckoutPaymentDto,
    nextGeneration: existing.generation,
    observedAt,
  };
}

async function completeIdempotency(
  transaction: Transaction,
  id: string,
  response: unknown,
) {
  await transaction.idempotencyRecord.update({
    where: { id },
    data: {
      status: IdempotencyStatus.COMPLETED,
      responseStatusCode: 200,
      responseBody: JSON.parse(
        JSON.stringify(response),
      ) as Prisma.InputJsonValue,
    },
  });
}

async function lockIdempotencyKey(
  transaction: Transaction,
  sessionId: string,
  idempotencyKey: string,
) {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${checkoutNamespace(sessionId)}:${idempotencyKey}`}, 0)
    )::text
  `;
}

async function lockPaymentEnvelope(
  transaction: Transaction,
  paymentId: string,
) {
  await transaction.$queryRaw`
    SELECT taven_lock_checkout_payment_envelope(${paymentId}::uuid)::text
  `;
}

async function databaseNow(client: Transaction): Promise<Date> {
  const rows = await client.$queryRaw<Array<{ observed_at: Date }>>`
    SELECT clock_timestamp() AS observed_at
  `;
  const observedAt = rows[0]?.observed_at;
  if (!observedAt) throw new Error("Database clock is unavailable");
  return observedAt;
}

function checkoutNamespace(sessionId: string) {
  return `checkout-payment:${sessionId}`;
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000);
}

function normalizedUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function bearerCapability(authorization?: string): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match?.[1]) throw new UnauthorizedException("Capability is invalid");
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

function requiredText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximum
  ) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value.trim();
}

function publicSiteUrl(): string {
  const configured = process.env.TAVEN_PUBLIC_SITE_URL?.trim();
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new Error("TAVEN_PUBLIC_SITE_URL is required in production");
  }
  const raw = configured || "http://localhost:3000";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("TAVEN_PUBLIC_SITE_URL must be an absolute URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("TAVEN_PUBLIC_SITE_URL must be an HTTP(S) URL");
  }
  return parsed.toString().replace(/\/$/, "");
}

function checkoutReturnUrls(siteUrl: string, sessionId: string) {
  const target = (result: "success" | "cancelled" | "pending") => {
    const url = new URL(`/checkout/payment/${result}`, `${siteUrl}/`);
    url.searchParams.set("sessionId", sessionId);
    return url.toString();
  };
  return {
    success: target("success"),
    cancelled: target("cancelled"),
    pending: target("pending"),
  } as const;
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
