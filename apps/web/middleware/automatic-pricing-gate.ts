import { publicSite } from "../content/public-site";

export default defineNuxtRouteMiddleware(() => {
  if (publicSite.commercial.automaticQuotePubliclyEnabled) return;

  return navigateTo(
    {
      path: "/cenik",
      query: { stav: "ceka-na-schvaleni-cen" },
    },
    { redirectCode: 302 },
  );
});
