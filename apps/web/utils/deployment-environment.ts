export type DeploymentEnvironment =
  "development" | "production" | "staging" | "unknown";

export function normalizeDeploymentEnvironment(
  value: unknown,
): DeploymentEnvironment {
  return value === "development" ||
    value === "production" ||
    value === "staging"
    ? value
    : "unknown";
}

export function isProductionDeployment(value: unknown): boolean {
  return normalizeDeploymentEnvironment(value) === "production";
}
