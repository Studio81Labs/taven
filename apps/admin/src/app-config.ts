export function adminTitle(environment: string | undefined): string {
  return environment ? `Taven Admin · ${environment}` : "Taven Admin";
}
