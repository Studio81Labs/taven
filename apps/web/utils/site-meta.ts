export function canonicalTitle(page: string | undefined): string {
  return page ? `${page} · Taven` : "Taven";
}
