import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "../generated/schema";

export type TavenApiClient = Client<paths>;
export type TavenApiClientOptions = ClientOptions;

export function createTavenApiClient(
  options: TavenApiClientOptions = {},
): TavenApiClient {
  return createClient<paths>(options);
}
