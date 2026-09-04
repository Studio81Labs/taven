const PUBLIC_EMAIL_PATTERN =
  /^[A-Z0-9.!#$%&'*+/=_~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

export interface PublicContactRuntimeConfig {
  customerContactEmail: unknown;
  dataControllerEmail: unknown;
}

export interface PublicEmailContact {
  email: string;
  href: string;
}

export interface PublicContacts {
  customer: PublicEmailContact;
  dataController: PublicEmailContact;
}

function resolvePublicEmail(value: unknown, environmentName: string): string {
  const email = typeof value === "string" ? value.trim() : "";
  const localPart = email.slice(0, email.lastIndexOf("@"));

  if (
    !PUBLIC_EMAIL_PATTERN.test(email) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    throw new TypeError(`${environmentName} must be a valid email address.`);
  }

  return email;
}

function emailContact(email: string): PublicEmailContact {
  const encodedAddress = encodeURIComponent(email).replace(/%40/gi, "@");

  return { email, href: `mailto:${encodedAddress}` };
}

export function resolvePublicContacts(
  config: PublicContactRuntimeConfig,
): PublicContacts {
  const customerEmail = resolvePublicEmail(
    config.customerContactEmail,
    "NUXT_PUBLIC_CUSTOMER_CONTACT_EMAIL",
  );
  const dataControllerEmail = resolvePublicEmail(
    config.dataControllerEmail,
    "NUXT_PUBLIC_DATA_CONTROLLER_EMAIL",
  );

  return {
    customer: emailContact(customerEmail),
    dataController: emailContact(dataControllerEmail),
  };
}
