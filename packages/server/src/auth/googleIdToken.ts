import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";

/**
 * Verifies Google ID tokens (the GIS `credential` JWT) and nothing else:
 * decode, RS256 signature against Google's published JWKS, and iss/aud/exp
 * claims. Hand-rolled on node:crypto so sign-in adds no dependency.
 * The JWKS fetcher is injectable so tests never touch the network.
 */

export interface GoogleIdentity {
  sub: string;
  email?: string;
  name?: string;
}

export interface Jwks {
  keys: (JsonWebKey & { kid?: string })[];
  /** Cache lifetime from the response's Cache-Control max-age, if present. */
  maxAgeMs: number | null;
}

export type JwksFetcher = () => Promise<Jwks>;

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const DEFAULT_KEYS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const VALID_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * Returns a verifier bound to one OAuth client id. Keys are cached in the
 * closure for the JWKS response's max-age (1h fallback) and refetched once
 * when an unknown kid appears (Google rotates keys).
 */
export function createGoogleIdTokenVerifier(
  clientId: string,
  fetchJwks: JwksFetcher = fetchGoogleJwks,
): (credential: string) => Promise<GoogleIdentity> {
  let cached: { jwks: Jwks; expiresAt: number } | null = null;

  const keyForKid = async (kid: string): Promise<JsonWebKey> => {
    const fresh = cached === null || cached.expiresAt <= Date.now();
    if (fresh || !findKey(cached!.jwks, kid)) {
      const jwks = await fetchJwks();
      cached = { jwks, expiresAt: Date.now() + (jwks.maxAgeMs ?? DEFAULT_KEYS_TTL_MS) };
    }
    const key = findKey(cached!.jwks, kid);
    if (!key) throw new Error(`no Google signing key for kid ${kid}`);
    return key;
  };

  return async (credential) => {
    const [headerPart, payloadPart, signaturePart] = credential.split(".");
    if (!headerPart || !payloadPart || !signaturePart) throw new Error("not a JWT");
    const header = decodeSegment(headerPart) as { alg?: string; kid?: string };
    // Pinning the algorithm forecloses alg-confusion attacks.
    if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
    if (!header.kid) throw new Error("missing kid");

    const key = createPublicKey({ key: await keyForKid(header.kid), format: "jwk" });
    const valid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, "base64url"),
    );
    if (!valid) throw new Error("bad signature");

    const payload = decodeSegment(payloadPart) as {
      iss?: string;
      aud?: string;
      exp?: number;
      sub?: string;
      email?: string;
      name?: string;
    };
    if (!payload.iss || !VALID_ISSUERS.includes(payload.iss)) {
      throw new Error(`bad issuer ${payload.iss}`);
    }
    if (payload.aud !== clientId) throw new Error("token is for another client");
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now() - CLOCK_SKEW_MS) {
      throw new Error("token expired");
    }
    if (!payload.sub) throw new Error("missing sub");
    return { sub: payload.sub, email: payload.email, name: payload.name };
  };
}

function findKey(jwks: Jwks, kid: string): JsonWebKey | undefined {
  return jwks.keys.find((key) => key.kid === kid);
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
}

async function fetchGoogleJwks(): Promise<Jwks> {
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwks["keys"] };
  const maxAge = /(?:^|[,\s])max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  return { keys: body.keys, maxAgeMs: maxAge ? Number(maxAge[1]) * 1000 : null };
}
