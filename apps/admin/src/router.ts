import { createRouter, createWebHistory } from "vue-router";
import {
  bootstrapSession,
  hasOperationalNode,
  hasPermission,
  session,
  type OperatorPermission,
} from "./session";

export const navigation: readonly {
  path: string;
  label: string;
  permission: OperatorPermission;
}[] = [
  { path: "/", label: "Přehled", permission: "operations:read" },
  {
    path: "/objednavky",
    label: "Objednávky a úlohy",
    permission: "operations:read",
  },
  {
    path: "/poptavky",
    label: "Poptávky a nabídky",
    permission: "operations:read",
  },
  { path: "/zdroje", label: "Stroje a sklad", permission: "operations:read" },
  { path: "/katalog", label: "Katalog a ceny", permission: "operations:read" },
  { path: "/metriky", label: "Měření", permission: "metrics:read" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/prihlaseni", component: () => import("./views/LoginView.vue") },
    {
      path: "/bez-uzlu",
      component: () => import("./views/ScopeUnavailableView.vue"),
    },
    {
      path: "/nedostupne",
      component: () => import("./views/UnavailableView.vue"),
    },
    {
      path: "/zakazano",
      component: () => import("./views/ForbiddenView.vue"),
    },
    ...navigation.map((item) => ({
      path: item.path,
      component: () => import("./views/ShellSectionView.vue"),
      meta: { label: item.label, permission: item.permission },
    })),
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  if (session.phase === "loading") await bootstrapSession();
  if (session.phase === "unavailable") {
    return to.path === "/nedostupne" ? true : "/nedostupne";
  }
  if (session.phase === "anonymous") {
    return to.path === "/prihlaseni" ? true : "/prihlaseni";
  }
  if (to.path === "/prihlaseni" || to.path === "/nedostupne") return "/";
  if (!hasOperationalNode()) {
    return to.path === "/bez-uzlu" ? true : "/bez-uzlu";
  }
  if (to.path === "/bez-uzlu") return "/";
  const permission = to.meta.permission as OperatorPermission | undefined;
  if (permission && !hasPermission(permission)) {
    return to.path === "/zakazano" ? true : "/zakazano";
  }
  return true;
});
