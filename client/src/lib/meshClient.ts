/**
 * Web mesh client — REST helpers around the relay's mesh endpoints.
 *
 * The web tier doesn't participate in BLE mesh directly (Web Bluetooth is
 * Chrome-only and crippled — see §6.3 of `MESH_INTEGRATION_PLAN.md`).
 * Instead the web client:
 *   - reads the relay's mesh config (relay attestation pubkey, TTLs);
 *   - displays a status indicator when our other-platform companion
 *     announces it's online via mesh;
 *   - looks up other users' mesh identities so we can pre-cache them
 *     for when we move to the WebRTC bridge in v2.0.
 *
 * Heavy crypto (Noise XX, SAS, packet codec) lives in `meshCrypto.ts`
 * — added later. This file is plumbing only and does not require
 * `@noble/curves` to be loaded.
 *
 * All endpoints respect the existing JWT-bearer auth pattern and use
 * `await authedFetch(...)` semantics implemented in this file (kept
 * tiny so we don't import the rest of the auth machinery here).
 */

import type { MeshConfig, MeshIdentityRecord } from "../types";

export interface MeshLookupOk {
  ok: true;
  found: true;
  identity: MeshIdentityRecord;
}

export interface MeshLookupMiss {
  ok: true;
  found: false;
}

export interface MeshLookupErr {
  ok: false;
  reason: string;
}

export type MeshLookupResult = MeshLookupOk | MeshLookupMiss | MeshLookupErr;

/**
 * Fetch the mesh portion of `/api/config` — relay attestation pubkey,
 * register/window TTLs and bridge payload caps.
 *
 * Cached for `cacheTtlMs` ms (default 60s) to avoid hammering the
 * relay during reconnect storms.
 */
let cachedConfig: { value: MeshConfig | null; fetchedAt: number } | null = null;
export async function fetchMeshConfig(
  baseUrl: string,
  options: { cacheTtlMs?: number; signal?: AbortSignal } = {},
): Promise<MeshConfig | null> {
  const ttl = options.cacheTtlMs ?? 60_000;
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.fetchedAt < ttl) return cachedConfig.value;
  try {
    const res = await fetch(`${baseUrl}/api/config`, { signal: options.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const value: MeshConfig | null = body?.mesh ?? null;
    cachedConfig = { value, fetchedAt: now };
    return value;
  } catch {
    return null;
  }
}

/** Look up a peer's mesh identity (Ed25519 + X25519 pubs) by NFT number. */
export async function lookupMeshIdentity(
  baseUrl: string,
  token: string,
  number: string,
  signal?: AbortSignal,
): Promise<MeshLookupResult> {
  try {
    const res = await fetch(`${baseUrl}/api/mesh/identity/${encodeURIComponent(number)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (res.status === 404) return { ok: true, found: false };
    if (!res.ok) {
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = await res.json();
    if (!body?.identity) return { ok: true, found: false };
    return { ok: true, found: true, identity: body.identity as MeshIdentityRecord };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Bulk-verify a set of mesh identities. Used at app start to fast-check
 * that every contact's `mesh_signing_pub` we have cached locally still
 * matches what the relay sees — diverging pubs mean a key rotation we
 * haven't observed yet, and we should drop the stale Noise session.
 */
export async function bulkVerifyMeshIdentities(
  baseUrl: string,
  token: string,
  queries: Array<{ number: string; expectedMeshSigningPub: string }>,
  signal?: AbortSignal,
): Promise<Array<{ number: string; verified: boolean; actual?: string }> | null> {
  if (queries.length === 0) return [];
  try {
    const res = await fetch(`${baseUrl}/api/mesh/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ queries }),
      signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.results) ? body.results : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the current relay attestation pubkey separately — used during
 * onboarding to pin the key in local storage so we can detect rotation
 * later.
 */
export async function fetchRelayAttestationPubkey(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/mesh/relay-pubkey`);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.relayPubkey === "string" ? body.relayPubkey : null;
  } catch {
    return null;
  }
}
