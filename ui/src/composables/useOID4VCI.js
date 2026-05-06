/**
 * useOID4VCI.js
 *
 * OpenID for Verifiable Credential Issuance (OID4VCI) draft-13 client.
 * Handles the "pre-authorized code" flow used by most education issuers.
 *
 * Flow:
 *   1. Issuer provides a credential_offer URI (QR code or deep link)
 *   2. We fetch the issuer's OpenID configuration
 *   3. Exchange pre-authorized_code for access_token
 *   4. Request credential using holder's DID as subject
 *   5. Store received VC in IndexedDB
 */

import { ref } from "vue";
import { useKeyVault } from "./useKeyVault.js";
import { useCredentialStore } from "./useCredentialStore.js";
import { sha256 } from "@noble/hashes/sha256";

const status = ref("idle"); // idle | fetching | receiving | done | error
const errorMsg = ref(null);

export function useOID4VCI() {
  const vault = useKeyVault();
  const store = useCredentialStore();

  /**
   * Parse a credential_offer URI.
   * Supports both inline JSON and credential_offer_uri redirect.
   */
  async function parseOffer(offerUriOrJson) {
    let offer;
    if (typeof offerUriOrJson === "string" && offerUriOrJson.startsWith("{")) {
      offer = JSON.parse(offerUriOrJson);
    } else if (typeof offerUriOrJson === "string") {
      const url = new URL(offerUriOrJson);
      const inline = url.searchParams.get("credential_offer");
      const offerUri = url.searchParams.get("credential_offer_uri");
      if (inline) {
        offer = JSON.parse(decodeURIComponent(inline));
      } else if (offerUri) {
        const r = await fetch(offerUri);
        offer = await r.json();
      } else {
        throw new Error("No credential_offer or credential_offer_uri in URI");
      }
    } else {
      offer = offerUriOrJson;
    }
    return offer;
  }

  /**
   * Fetch the issuer's OpenID credential issuer metadata.
   */
  async function fetchIssuerMetadata(issuerUrl) {
    const metaUrl = `${issuerUrl.replace(/\/$/, "")}/.well-known/openid-credential-issuer`;
    const r = await fetch(metaUrl);
    if (!r.ok) throw new Error(`Metadata fetch failed: ${r.status}`);
    return r.json();
  }

  /**
   * Build a JWT proof of possession (holder binding).
   * Uses the holder's secp256k1 key — ES256K algorithm.
   * This proves to the issuer that we control the DID we're claiming.
   */
  async function buildProofJwt(issuerUrl, nonce) {
    const { did, publicKeyHex } = vault.getHolderInfo();

    const header = {
      alg: "ES256K",
      typ: "openid4vci-proof+jwt",
      jwk: {
        kty: "EC",
        crv: "secp256k1",
        x: _pubKeyX(publicKeyHex),
        y: _pubKeyY(publicKeyHex),
      },
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: did,
      aud: issuerUrl,
      iat: now,
      nonce: nonce || undefined,
    };

    const headerB64 = _b64url(JSON.stringify(header));
    const payloadB64 = _b64url(JSON.stringify(payload));
    const sigInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigHex = await vault.sign(sigInput);

    // Convert DER hex to compact R||S base64url for JWT
    const compactSig = _derToCompact(sigHex);
    return `${headerB64}.${payloadB64}.${compactSig}`;
  }

  /**
   * Main entry point: receive a credential from an offer URI.
   * pin is needed to sign the proof-of-possession JWT.
   */
  async function receiveCredential(offerUriOrJson, txCode = null) {
    status.value = "fetching";
    errorMsg.value = null;
    try {
      const offer = await parseOffer(offerUriOrJson);
      const issuerUrl = offer.credential_issuer;
      const grants = offer.grants || {};
      const preAuth =
        grants["urn:ietf:params:oauth:grant-type:pre-authorized_code"];

      if (!preAuth) {
        throw new Error("Only pre-authorized_code flow is currently supported");
      }

      const meta = await fetchIssuerMetadata(issuerUrl);
      const tokenEndpoint = meta.token_endpoint || `${issuerUrl}/token`;
      const credentialEndpoint =
        meta.credential_endpoint || `${issuerUrl}/credential`;

      // Step 1: get access token
      const tokenBody = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:pre-authorized_code",
        "pre-authorized_code": preAuth["pre-authorized_code"],
      });
      if (txCode) tokenBody.set("tx_code", txCode);

      status.value = "receiving";
      const tokenResp = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      });
      if (!tokenResp.ok) {
        const err = await tokenResp.json().catch(() => ({}));
        throw new Error(
          err.error_description || `Token error: ${tokenResp.status}`,
        );
      }
      const { access_token, c_nonce } = await tokenResp.json();

      // Step 2: request each offered credential
      const credentialConfigs = offer.credential_configuration_ids || [];
      const received = [];

      for (const configId of credentialConfigs) {
        const proof = await buildProofJwt(issuerUrl, c_nonce);
        const credResp = await fetch(credentialEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${access_token}`,
          },
          body: JSON.stringify({
            credential_configuration_id: configId,
            proof: { proof_type: "jwt", jwt: proof },
          }),
        });
        if (!credResp.ok) {
          const err = await credResp.json().catch(() => ({}));
          throw new Error(
            err.error_description || `Credential error: ${credResp.status}`,
          );
        }
        const { credential } = await credResp.json();

        // credential may be a JWT string or JSON-LD object
        const vc =
          typeof credential === "string" ? _parseJwtVc(credential) : credential;

        await store.saveCredential(vc);
        received.push(vc);
      }

      status.value = "done";
      return received;
    } catch (e) {
      status.value = "error";
      errorMsg.value = e.message;
      throw e;
    }
  }

  return { status, errorMsg, receiveCredential, parseOffer };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function _hexDecode(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function _pubKeyX(pubKeyHex) {
  const pubBytes = _hexDecode(pubKeyHex);
  const { x, y } = _decompressPubKey(pubBytes);
  return _b64url(String.fromCharCode(...x));
}

function _pubKeyY(pubKeyHex) {
  const pubBytes = _hexDecode(pubKeyHex);
  const { x, y } = _decompressPubKey(pubBytes);
  return _b64url(String.fromCharCode(...y));
}

/**
 * Decompress a 33-byte secp256k1 compressed public key into (x, y) Uint8Arrays.
 * Uses the curve equation y² = x³ + 7 (mod p) with p = secp256k1 prime.
 */
function _decompressPubKey(compressed) {
  const p = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const xHex = Array.from(compressed.slice(1))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const x = BigInt("0x" + xHex);
  const ySquared = (x ** 3n + 7n) % p;
  let y = modPow(ySquared, (p + 1n) / 4n, p);
  const prefix = compressed[0];
  if ((y % 2n === 0n) !== (prefix === 0x02)) y = p - y;
  const xBytes = hexToBytes(xHex);
  const yBytes = bigIntToBytes(y);
  return { x: xBytes, y: yBytes };
}

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bigIntToBytes(n) {
  const hex = n.toString(16).padStart(64, "0");
  return hexToBytes(hex);
}

function _derToCompact(derHex) {
  // Parse DER signature to extract R and S, return base64url R||S (64 bytes)
  const der = _hexDecode(derHex);
  let i = 2; // skip 0x30, length
  i++; // skip 0x02
  const rLen = der[i++];
  const r = der.slice(i, i + rLen);
  i += rLen;
  i++; // skip 0x02
  const sLen = der[i++];
  const s = der.slice(i, i + sLen);

  // Pad/trim to 32 bytes each
  const rPad = new Uint8Array(32);
  const sPad = new Uint8Array(32);
  rPad.set(r.slice(-32), 32 - Math.min(r.length, 32));
  sPad.set(s.slice(-32), 32 - Math.min(s.length, 32));

  const compact = new Uint8Array(64);
  compact.set(rPad, 0);
  compact.set(sPad, 32);
  return _b64url(String.fromCharCode(...compact));
}

function _parseJwtVc(jwtStr) {
  const parts = jwtStr.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");
  const payload = JSON.parse(
    atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
  );
  return payload.vc || payload; // JWT-VC puts the credential in the 'vc' claim
}
