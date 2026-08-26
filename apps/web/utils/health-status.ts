interface HealthResponse {
  status: string;
}

export function resolveWebHealthStatus(
  health: HealthResponse | null | undefined,
  failed: boolean,
): string {
  if (failed) return "API unavailable";
  return health ? `API ${health.status}` : "Checking API health…";
}
