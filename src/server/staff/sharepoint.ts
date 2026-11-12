/**
 * Microsoft SharePoint document library integration (Microsoft Graph, app-only).
 *
 * Status: INTEGRATION BOUNDARY. It is inactive until the bank provides an Entra ID app registration
 * with least-privilege access to one document library (Sites.Selected, granted to the target site
 * only) and sets SHAREPOINT_* variables. No credentials exist in this repository and nothing is
 * reported as delivered unless Graph confirms the upload and the downloaded bytes match.
 *
 *  - Upload by path into <root>/<staff folder>/ARAF-STAFF-<ref>.zip with conflictBehavior=fail
 *    (a file is never silently overwritten; a retry that finds the same bytes already there is accepted).
 *  - Small files: one PUT. Larger files: an upload session in 3.75 MiB chunks (multiples of 320 KiB).
 *  - Verification: download the stored item and compare SHA-256 and size with the archive.
 *  - No sharing links are created; the file inherits the library's permissions.
 */
import { createHash } from "node:crypto";
import { config } from "../config";

export interface UploadedItem {
  itemId: string;
  webUrl: string | null;
}

export interface DocumentLibrary {
  readonly name: string;
  /** Missing settings; empty when the integration is configured. */
  missingSettings(): string[];
  upload(path: string, data: Buffer): Promise<UploadedItem>;
  /** True only when the stored item's bytes match exactly. */
  verify(itemId: string, sha256: string, size: number): Promise<boolean>;
}

export class SharePointError extends Error {
  constructor(message: string, public status?: number, public retryable = true) {
    super(message);
    this.name = "SharePointError";
  }
}

const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const CHUNK = 12 * 320 * 1024; // 3.75 MiB

export const encodeGraphPath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

class GraphDocumentLibrary implements DocumentLibrary {
  readonly name = "Microsoft Graph (SharePoint)";
  private token: { value: string; exp: number } | null = null;
  constructor(private fetchImpl: typeof fetch = fetch) {}

  missingSettings() {
    const s = config.sharepoint;
    const m: string[] = [];
    if (!s.enabled) m.push("SHAREPOINT_ENABLED=true");
    if (!s.tenantId) m.push("SHAREPOINT_TENANT_ID");
    if (!s.clientId) m.push("SHAREPOINT_CLIENT_ID");
    if (!s.clientSecret) m.push("SHAREPOINT_CLIENT_SECRET");
    if (!s.driveId) m.push("SHAREPOINT_DRIVE_ID");
    return m;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const s = config.sharepoint;
    const res = await this.fetchImpl(`${s.authorityHost}/${encodeURIComponent(s.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new SharePointError(`Microsoft identity platform refused the app credentials (HTTP ${res.status}).`, res.status, res.status >= 500 || res.status === 429);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new SharePointError("No access token was returned.");
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  private async graph(path: string, init: RequestInit = {}) {
    const t = await this.accessToken();
    return this.fetchImpl(`${config.sharepoint.graphBaseUrl}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t}` } });
  }

  private async fail(res: Response, what: string): Promise<never> {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      detail = j.error?.code ? ` (${j.error.code})` : "";
    } catch {
      /* body not JSON */
    }
    throw new SharePointError(`${what} failed: HTTP ${res.status}${detail}.`, res.status, res.status >= 500 || res.status === 429 || res.status === 408);
  }

  private async existing(path: string): Promise<UploadedItem | null> {
    const res = await this.graph(`/drives/${encodeURIComponent(config.sharepoint.driveId)}/root:/${encodeGraphPath(path)}`);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, "Looking up the existing file");
    const j = (await res.json()) as { id: string; webUrl?: string };
    return { itemId: j.id, webUrl: j.webUrl ?? null };
  }

  async upload(path: string, data: Buffer): Promise<UploadedItem> {
    const drive = encodeURIComponent(config.sharepoint.driveId);
    const p = encodeGraphPath(path);
    let res: Response;
    if (data.length <= SIMPLE_UPLOAD_MAX) {
      res = await this.graph(`/drives/${drive}/root:/${p}:/content?@microsoft.graph.conflictBehavior=fail`, {
        method: "PUT",
        headers: { "Content-Type": "application/zip" },
        body: new Uint8Array(data),
      });
    } else {
      const s = await this.graph(`/drives/${drive}/root:/${p}:/createUploadSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "fail" } }),
      });
      if (s.status === 409) return (await this.existing(path)) ?? this.fail(s, "Creating the upload session");
      if (!s.ok) await this.fail(s, "Creating the upload session");
      const { uploadUrl } = (await s.json()) as { uploadUrl: string };
      res = new Response(null, { status: 500 });
      for (let start = 0; start < data.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, data.length);
        // The pre-authenticated upload URL must not receive the bearer token.
        res = await this.fetchImpl(uploadUrl, {
          method: "PUT",
          headers: { "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${data.length}` },
          body: new Uint8Array(data.subarray(start, end)),
        });
        if (!res.ok && res.status !== 202) await this.fail(res, "Uploading a chunk");
      }
    }
    if (res.status === 409) {
      const ex = await this.existing(path);
      if (ex) return ex;
    }
    if (!res.ok) await this.fail(res, "Uploading the archive");
    const j = (await res.json()) as { id: string; webUrl?: string };
    return { itemId: j.id, webUrl: j.webUrl ?? null };
  }

  async verify(itemId: string, sha256: string, size: number): Promise<boolean> {
    const res = await this.graph(`/drives/${encodeURIComponent(config.sharepoint.driveId)}/items/${encodeURIComponent(itemId)}/content`, { redirect: "follow" });
    if (!res.ok) await this.fail(res, "Downloading the stored file for verification");
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length === size && createHash("sha256").update(buf).digest("hex") === sha256;
  }
}

let library: DocumentLibrary | null = null;

export function documentLibrary(): DocumentLibrary {
  if (!library) library = new GraphDocumentLibrary();
  return library;
}

/** Tests (and only tests) substitute a library double that behaves like Graph. */
export function setDocumentLibraryForTests(lib: DocumentLibrary | null) {
  library = lib;
}

export function sharePointConfigured(): boolean {
  return documentLibrary().missingSettings().length === 0;
}

export { GraphDocumentLibrary };
