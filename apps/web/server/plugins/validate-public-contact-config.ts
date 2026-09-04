import { resolvePublicContacts } from "../../utils/public-contact-config";

export default defineNitroPlugin(() => {
  const config = useRuntimeConfig();

  resolvePublicContacts({
    customerContactEmail: config.public.customerContactEmail,
    dataControllerEmail: config.public.dataControllerEmail,
  });
});
