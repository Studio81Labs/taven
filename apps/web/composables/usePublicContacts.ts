import { resolvePublicContacts } from "../utils/public-contact-config";

export function usePublicContacts() {
  const config = useRuntimeConfig();

  return resolvePublicContacts({
    customerContactEmail: config.public.customerContactEmail,
    dataControllerEmail: config.public.dataControllerEmail,
  });
}
