interface HealthResult {
  data?: { status?: string };
  error?: unknown;
}

export async function resolveApiHealthStatus(
  getHealth: () => Promise<unknown>,
): Promise<string> {
  try {
    const result = (await getHealth()) as HealthResult;
    return result.error
      ? "API unavailable"
      : `API ${result.data?.status ?? "unknown"}`;
  } catch {
    return "API unavailable";
  }
}
