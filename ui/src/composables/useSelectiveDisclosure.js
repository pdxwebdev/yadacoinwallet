/**
 * useSelectiveDisclosure.js
 *
 * Selective disclosure support for OID4VP presentations.
 *
 * Handles two credential formats:
 *
 * 1. SD-JWT (IETF SD-JWT VC draft-12)
 *    Format: "<header>.<payload>.<sig>~<disc1>~<disc2>~"
 *    Each disclosure is base64url([salt, claim_name, claim_value]).
 *    Presentation appends a Key Binding JWT (KB-JWT) bound to the
 *    verifier nonce + audience.
 *
 * 2. Plain W3C VC 2.0
 *    No cryptographic selective disclosure — we filter credentialSubject
 *    to only the holder-selected claims before including the VC in the VP.
 *    The VP JWT signature covers the filtered structure.
 *    This provides claim-level privacy but not cryptographic unlinkability.
 */

import { sha256 } from "@noble/hashes/sha256";
import { useKeyVault } from "./useKeyVault.js";

// ── SD-JWT detection ──────────────────────────────────────────────────────────

/**
 * Returns true if the raw credential value is an SD-JWT string.
 * SD-JWTs contain "~" separators after the JWS compact serialisation.
 */
export function isSdJwt(raw) {
  if (typeof raw === "string") return raw.includes("~");
  if (raw && typeof raw.sd_jwt === "string") return true;
  return false;
}

// ── SD-JWT parsing ────────────────────────────────────────────────────────────

/**
 * Parse an SD-JWT string into its constituent parts.
 *
 * Returns:
 *   issuanceJwt  — the <header>.<payload>.<sig> token issued by the issuer
 *   disclosures  — array of { encoded, salt, name, value }
 *   payload      — decoded JWT payload object (claims)
 */
export function parseSdJwt(raw) {
  const str = typeof raw === "string" ? raw : raw.sd_jwt;
  // Split on ~ and filter empty strings (trailing ~ leaves one empty part)
  const parts = str.split("~");
  const issuanceJwt = parts[0];
  const encodedDisclosures = parts.slice(1).filter(Boolean);

  // Decode JWT payload (verification already done at issuance time)
  const jwtParts = issuanceJwt.split(".");
  if (jwtParts.length < 2) throw new Error("Malformed SD-JWT");
  const payloadJson = _b64urlDecode(jwtParts[1]);
  const payload = JSON.parse(payloadJson);

  const disclosures = encodedDisclosures.map((enc) => {
    let decoded;
    try {
      decoded = JSON.parse(_b64urlDecode(enc));
    } catch {
      throw new Error(`Cannot decode disclosure: ${enc}`);
    }
    if (!Array.isArray(decoded) || decoded.length < 3) {
      throw new Error("Disclosure must be [salt, name, value]");
    }
    return {
      encoded: enc,
      salt: decoded[0],
      name: decoded[1],
      value: decoded[2],
    };
  });

  return { issuanceJwt, disclosures, payload };
}

/**
 * Extract all selectively-disclosable claims from an SD-JWT credential.
 *
 * Returns:
 *   disclosableClaims — [{ name, value, encoded, hash, required }]
 *     required is always false here — the caller must match against
 *     presentation_definition field constraints to determine required claims.
 *   alwaysClaims — { [name]: value } claims always disclosed (in payload, not _sd)
 *   payload — full decoded JWT payload
 */
export function getSdJwtClaims(raw) {
  const { disclosures, payload } = parseSdJwt(raw);

  // The payload contains an "_sd" array of base64url(sha256(encoded_disclosure))
  // hashes for each selectively-disclosable claim.
  const sdHashes = new Set(payload._sd || []);

  const disclosableClaims = [];
  for (const disc of disclosures) {
    const hash = _sha256B64url(disc.encoded);
    // Only include disclosures that are actually committed to in this token
    if (sdHashes.has(hash)) {
      disclosableClaims.push({
        name: disc.name,
        value: disc.value,
        encoded: disc.encoded,
        hash,
        required: false,
      });
    }
  }

  // Always-disclosed claims: present in payload body but not behind _sd
  const skip = new Set([
    "_sd",
    "_sd_alg",
    "iss",
    "iat",
    "exp",
    "nbf",
    "vct",
    "cnf",
    "status",
    "jti",
    "sub",
  ]);
  const alwaysClaims = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!skip.has(k)) alwaysClaims[k] = v;
  }

  return { disclosableClaims, alwaysClaims, payload };
}

/**
 * Build an SD-JWT VP: the issuance JWT + selected disclosures + KB-JWT.
 *
 * selectedClaimNames — Set<string> of claim names the holder wants to reveal
 * nonce             — verifier-provided nonce
 * audience          — verifier client_id or response_uri
 *
 * Returns the full SD-JWT VP string for use as vp_token.
 */
export async function buildSdJwtPresentation(
  raw,
  selectedClaimNames,
  nonce,
  audience,
) {
  const vault = useKeyVault();
  const { issuanceJwt, disclosures } = parseSdJwt(raw);

  // Include only the disclosures the holder chose to reveal
  const selected = disclosures.filter((d) => selectedClaimNames.has(d.name));
  const encodedSelected = selected.map((d) => d.encoded);

  // SD-JWT presentation body (trailing ~ required by spec)
  const sdJwtBody = issuanceJwt + "~" + encodedSelected.join("~") + "~";

  // Key Binding JWT bound to this exact presentation string
  const kbJwt = await _buildKbJwt(sdJwtBody, nonce, audience, vault);

  return sdJwtBody + kbJwt;
}

// ── Plain W3C VC claim selection ──────────────────────────────────────────────

/**
 * Extract claim names and values from a plain W3C VC's credentialSubject.
 * Used to present claim checkboxes in the UI.
 *
 * Returns [{ name, value, displayValue, required }]
 *   required is always false — caller sets required based on
 *   presentation_definition field constraints.
 */
export function getVcClaims(vc) {
  const subject = vc.credentialSubject || {};
  return Object.entries(subject)
    .filter(([k]) => k !== "id")
    .map(([name, value]) => ({
      name,
      value,
      displayValue:
        value === null || value === undefined
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value),
      required: false,
    }));
}

/**
 * Build a filtered copy of a plain W3C VC with only the selected claims.
 * The holder's VP JWT signature will cover this derived structure.
 *
 * NOTE: The original issuer signature is no longer valid after filtering.
 * This is a known limitation of plain W3C VCs without SD-JWT —
 * the verifier trusts the holder's VP signature to attest the claims came
 * from a credentialed source. For full cryptographic selective disclosure,
 * credentials must be issued as SD-JWTs or with BBS+ signatures.
 */
export function buildFilteredVc(vc, selectedClaimNames) {
  const subject = vc.credentialSubject || {};
  const filtered = {};

  // Always preserve the subject id if present
  if (subject.id) filtered.id = subject.id;

  for (const name of selectedClaimNames) {
    if (name in subject) filtered[name] = subject[name];
  }

  return {
    ...vc,
    credentialSubject: filtered,
  };
}

// ── Presentation definition helpers ──────────────────────────────────────────

/**
 * Given a presentation_definition and a credential, return the set of
 * claim names that the verifier requires for that credential.
 *
 * Returns a Set<string> of required claim names (empty if not constrained).
 */
export function getRequiredClaims(presentationDefinition, vc) {
  if (!presentationDefinition?.input_descriptors) return new Set();

  const required = new Set();
  for (const desc of presentationDefinition.input_descriptors) {
    const fields = desc.constraints?.fields || [];
    for (const field of fields) {
      // field.path is an array of JSONPath strings like ["$.credentialSubject.givenName"]
      for (const path of field.path || []) {
        const match = path.match(/\$\.credentialSubject\.(\w+)/);
        if (match) required.add(match[1]);
      }
    }
  }
  return required;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _b64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return atob(padded + "=".repeat(padLen));
}

function _b64urlEncode(data) {
  const str =
    data instanceof Uint8Array
      ? String.fromCharCode(...data)
      : typeof data === "string"
        ? data
        : JSON.stringify(data);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function _sha256B64url(str) {
  const bytes = new TextEncoder().encode(str);
  const hash = sha256(bytes);
  return _b64urlEncode(hash);
}

/**
 * Key Binding JWT (KB-JWT) — binds the SD-JWT presentation to a specific
 * verifier nonce and audience, preventing replay attacks.
 *
 * typ: "kb+jwt"
 * sd_hash: SHA-256 of the SD-JWT presentation string (without KB-JWT)
 */
async function _buildKbJwt(sdJwtPresentation, nonce, audience, vault) {
  const { did } = vault.getHolderInfo();
  const now = Math.floor(Date.now() / 1000);

  // sd_hash covers the exact SD-JWT presentation the holder is committing to
  const presentationBytes = new TextEncoder().encode(sdJwtPresentation);
  const sdHash = _b64urlEncode(sha256(presentationBytes));

  const header = { alg: "ES256K", typ: "kb+jwt" };
  const payload = {
    iat: now,
    aud: audience,
    nonce,
    sd_hash: sdHash,
  };

  const h = _b64urlEncode(JSON.stringify(header));
  const p = _b64urlEncode(JSON.stringify(payload));
  const sigInput = new TextEncoder().encode(`${h}.${p}`);
  const sigHex = await vault.sign(sigInput);
  return `${h}.${p}.${_derToCompact(sigHex)}`;
}

function _derToCompact(derHex) {
  const der = new Uint8Array(derHex.length / 2);
  for (let i = 0; i < der.length; i++)
    der[i] = parseInt(derHex.slice(i * 2, i * 2 + 2), 16);
  let i = 2;
  i++; // INTEGER tag for r
  const rLen = der[i++];
  const r = der.slice(i, i + rLen);
  i += rLen;
  i++; // INTEGER tag for s
  const sLen = der[i++];
  const s = der.slice(i, i + sLen);
  const rPad = new Uint8Array(32);
  const sPad = new Uint8Array(32);
  rPad.set(r.slice(-32), 32 - Math.min(r.length, 32));
  sPad.set(s.slice(-32), 32 - Math.min(s.length, 32));
  const compact = new Uint8Array(64);
  compact.set(rPad, 0);
  compact.set(sPad, 32);
  return _b64urlEncode(compact);
}
