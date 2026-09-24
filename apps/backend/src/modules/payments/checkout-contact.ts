import { BadRequestException } from "@nestjs/common";
import type { CheckoutBillingDto } from "./payments.dto";

export type CheckoutContactInput = Readonly<{
  email: string;
  fullName: string;
  billing: CheckoutBillingDto;
}>;

/** Normalize the contact once, before either accepted-offer or checkout evidence is written. */
export function normalizeCheckoutContact(value: unknown): CheckoutContactInput {
  const input = asRecord(value);
  if (!input) throw new BadRequestException("checkout contact is invalid");
  const email = requiredText(input.email, "email", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BadRequestException("email is invalid");
  }
  const billing = asRecord(input.billing);
  if (!billing) throw new BadRequestException("billing is invalid");
  const countryCode = requiredText(
    billing.countryCode,
    "billing.countryCode",
    2,
  ).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new BadRequestException("billing.countryCode is invalid");
  }
  const addressLine2 = optionalText(
    billing.addressLine2,
    "billing.addressLine2",
    200,
  );
  const companyName = optionalText(
    billing.companyName,
    "billing.companyName",
    200,
  );
  const companyId = optionalText(billing.companyId, "billing.companyId", 50);
  const vatId = optionalText(billing.vatId, "billing.vatId", 50);
  return {
    email,
    fullName: requiredText(input.fullName, "fullName", 200),
    billing: {
      name: requiredText(billing.name, "billing.name", 200),
      addressLine1: requiredText(
        billing.addressLine1,
        "billing.addressLine1",
        200,
      ),
      ...(addressLine2 ? { addressLine2 } : {}),
      city: requiredText(billing.city, "billing.city", 100),
      postalCode: requiredText(billing.postalCode, "billing.postalCode", 20),
      countryCode,
      ...(companyName ? { companyName } : {}),
      ...(companyId ? { companyId } : {}),
      ...(vatId ? { vatId } : {}),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function optionalText(
  value: unknown,
  name: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, maximum);
}
