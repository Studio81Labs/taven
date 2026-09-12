export default defineNuxtRouteMiddleware(() => {
  if (useAutomaticQuoteEnabled().value) return;

  return navigateTo(
    {
      path: "/cenik",
      query: { stav: "ceka-na-schvaleni-cen" },
    },
    { redirectCode: 302 },
  );
});
