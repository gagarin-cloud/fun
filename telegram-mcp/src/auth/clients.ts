import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Sealer } from "./sealed.js";

export const CLIENT_PURPOSE = "oauth/client";

/**
 * Dynamic client registration with nothing to store: the client_id *is* the
 * registration, sealed with the server key. That means a redeploy does not
 * invalidate every connector anyone has added, which a database-less in-memory
 * store would — and there is no registration table to grow unbounded.
 */
export class SealedClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly sealer: Sealer) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    try {
      // The id is not inside the sealed payload (it cannot contain itself), so
      // it is put back here — everything downstream identifies the client by it.
      return { ...this.sealer.unseal<OAuthClientInformationFull>(CLIENT_PURPOSE, clientId), client_id: clientId };
    } catch {
      return undefined;
    }
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const registration = { ...client, client_id_issued_at: issuedAt };
    const clientId = this.sealer.seal(CLIENT_PURPOSE, { ...registration, client_id: undefined });
    return { ...registration, client_id: clientId };
  }
}
