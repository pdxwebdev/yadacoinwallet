/**
 * useOID4VP.js
 *
 * OpenID for Verifiable Presentations (OID4VP) draft-20 client.
 * Handles same-device flow: verifier sends a request_uri, wallet
 * fetches the presentation request, user selects credentials,
 * wallet builds and signs a VP token, POSTs to response_uri.
 *
 * The VP is a W3C Verifiable Presentation signed with the holder's key.
 */

import { ref } from "vue";
import { useKeyVault } from "./useKeyVault.js";
import { sha256 } from "@noble/hashes/sha256";
import {
  isSdJwt,
  buildSdJwtPresentation,
  buildFilteredVc,
} from "./useSelectiveDisclosure.js";

const vpStatus = ref("idle"); // idle | requesting | presenting | done | error
const presentationRequest = ref(null);
const errorMsg = ref(null);

export function useOID4VP() {
  const vault = useKeyVault();

  /**
   * Parse and validate a presentation request.
   * Input: openid4vp:// URI or a request_uri to fetch from.
   */
  async function fetchRequest(uriOrObject) {
    vpStatus.value = "requesting";
    errorMsg.value = null;
    try {
      let req;
      if (typeof uriOrObject === "object") {
        req = uriOrObject;
      } else if (uriOrObject.trimStart().startsWith("{")) {
        // Raw JSON request object pasted directly
        req = JSON.parse(uriOrObject);
      } else {
        const url = new URL(uriOrObject);
        const requestUri = url.searchParams.get("request_uri");
        if (requestUri) {
          const r = await fetch(requestUri);
          if (!r.ok) throw new Error(`Request fetch failed: ${r.status}`);
          // Request may be a signed JWT or plain JSON
          const body = await r.text();
          req = _parseRequestObject(body);
        } else {
          // Inline params
          req = Object.fromEntries(url.searchParams.entries());
          if (req.presentation_definition) {
            req.presentation_definition = JSON.parse(
              req.presentation_definition,
            );
          }
        }
      }
      presentationRequest.value = req;
      return req;
    } catch (e) {
      vpStatus.value = "error";
      errorMsg.value = e.message;
      throw e;
    }
  }

  /**
   * Present credentials to the verifier with selective disclosure.
   *
   * credentialSpecs — array of:
   *   { vc, selectedClaims: Set<string>, rawSdJwt?: string }
   *
   *   vc             — the stored W3C VC object
   *   selectedClaims — claim names the holder has chosen to reveal
   *   rawSdJwt       — original SD-JWT string (if credential is SD-JWT format)
   *
   * For SD-JWT credentials: builds an SD-JWT VP with KB-JWT.
   * For plain W3C VCs: builds a VP JWT containing filtered credentialSubjects.
   *
   * Returns the verifier's response.
   */
  async function present(credentialSpecs) {
    if (!presentationRequest.value)
      throw new Error("No active presentation request");
    vpStatus.value = "presenting";
    try {
      const req = presentationRequest.value;
      const { did } = vault.getHolderInfo();
      const nonce = req.nonce || _randomHex(16);
      const now = Math.floor(Date.now() / 1000);
      const audience = req.client_id || req.response_uri;

      // Separate SD-JWT and plain VC specs
      const sdJwtSpecs = credentialSpecs.filter((s) => s.rawSdJwt);
      const plainSpecs = credentialSpecs.filter((s) => !s.rawSdJwt);

      // Build vp_token(s)
      // OID4VP allows multiple vp_tokens as a JSON array when mixing formats.
      const vpTokens = [];
      const descriptorMap = [];
      let tokenIndex = 0;

      // --- SD-JWT credentials → dc+sd-jwt format ---
      for (const spec of sdJwtSpecs) {
        const sdVp = await buildSdJwtPresentation(
          spec.rawSdJwt,
          spec.selectedClaims,
          nonce,
          audience,
        );
        vpTokens.push(sdVp);
        const descId = _matchDescriptorId(
          req.presentation_definition,
          spec.vc,
          tokenIndex,
        );
        descriptorMap.push({
          id: descId,
          format: "dc+sd-jwt",
          path: vpTokens.length > 1 ? `$[${tokenIndex}]` : "$",
        });
        tokenIndex++;
      }

      // --- Plain W3C VC credentials → jwt_vc_json in a VP JWT ---
      if (plainSpecs.length > 0) {
        const filteredVCs = plainSpecs.map((spec) =>
          buildFilteredVc(spec.vc, spec.selectedClaims),
        );

        const vp = {
          "@context": ["https://www.w3.org/ns/credentials/v2"],
          type: ["VerifiablePresentation"],
          holder: did,
          verifiableCredential: filteredVCs,
        };

        const vpJwt = await _buildVpJwt(vp, req, did, nonce, now);
        vpTokens.push(vpJwt);

        filteredVCs.forEach((_, i) => {
          const spec = plainSpecs[i];
          const descId = _matchDescriptorId(
            req.presentation_definition,
            spec.vc,
            tokenIndex,
          );
          descriptorMap.push({
            id: descId,
            format: "jwt_vc_json",
            path: vpTokens.length > 1 ? `$[${tokenIndex}]` : "$",
            path_nested: {
              format: "jwt_vc_json",
              path: `$.vp.verifiableCredential[${i}]`,
            },
          });
        });
        tokenIndex++;
      }

      const vpToken =
        vpTokens.length === 1 ? vpTokens[0] : JSON.stringify(vpTokens);

      const submission = {
        id: _randomHex(8),
        definition_id: req.presentation_definition?.id || "default",
        descriptor_map: descriptorMap,
      };

      const responseUri = req.response_uri || req.redirect_uri;
      if (!responseUri)
        throw new Error("No response_uri in presentation request");

      const body = new URLSearchParams({
        vp_token: vpToken,
        presentation_submission: JSON.stringify(submission),
        state: req.state || "",
      });

      const r = await fetch(responseUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const result = await r.json().catch(() => ({ status: r.status }));
      vpStatus.value = "done";
      presentationRequest.value = null;
      return result;
    } catch (e) {
      vpStatus.value = "error";
      errorMsg.value = e.message;
      throw e;
    }
  }

  function clearRequest() {
    presentationRequest.value = null;
    vpStatus.value = "idle";
    errorMsg.value = null;
  }

  return {
    vpStatus,
    presentationRequest,
    errorMsg,
    fetchRequest,
    present,
    clearRequest,
  };
}

/**
 * Build a vp_token string from credential specs without an active request.
 * Used for in-person QR display where no response_uri is involved.
 */
export async function buildVpTokenFromSpecs(credentialSpecs, opts = {}) {
  const vault = useKeyVault();
  const { did } = vault.getHolderInfo();
  const nonce = opts.nonce || _randomHex(16);
  const now = Math.floor(Date.now() / 1000);
  const fakeReq = { client_id: did, nonce, presentation_definition: null };

  const plainSpecs = credentialSpecs.filter((s) => !s.rawSdJwt);
  const sdJwtSpecs = credentialSpecs.filter((s) => s.rawSdJwt);
  const vpTokens = [];

  for (const spec of sdJwtSpecs) {
    vpTokens.push(
      await buildSdJwtPresentation(
        spec.rawSdJwt,
        spec.selectedClaims,
        nonce,
        did,
      ),
    );
  }

  if (plainSpecs.length > 0) {
    const filteredVCs = plainSpecs.map((s) =>
      buildFilteredVc(s.vc, s.selectedClaims),
    );
    const vp = {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      holder: did,
      verifiableCredential: filteredVCs,
    };
    vpTokens.push(await _buildVpJwt(vp, fakeReq, did, nonce, now));
  }

  return vpTokens.length === 1 ? vpTokens[0] : JSON.stringify(vpTokens);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _b64url(data) {
  const str =
    typeof data === "string"
      ? data
      : String.fromCharCode(...new Uint8Array(data));
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function _buildVpJwt(vp, req, did, nonce, now) {
  const vault = useKeyVault();

  const header = {
    alg: "ES256K",
    typ: "JWT",
    kid: `${did}#key-0`,
  };

  const payload = {
    iss: did,
    sub: did,
    aud: req.client_id || req.response_uri,
    iat: now,
    exp: now + 300,
    nonce,
    vp,
  };

  const headerB64 = _b64url(JSON.stringify(header));
  const payloadB64 = _b64url(JSON.stringify(payload));
  const sigInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigHex = await vault.sign(sigInput);
  const compactSig = _derToCompact(sigHex);
  return `${headerB64}.${payloadB64}.${compactSig}`;
}

/**
 * Match a credential to a descriptor ID in the presentation_definition.
 * Falls back to the descriptor at the given index if no type match is found.
 */
function _matchDescriptorId(presentationDefinition, vc, fallbackIndex) {
  const descriptors = presentationDefinition?.input_descriptors || [];
  const vcTypes = Array.isArray(vc.type) ? vc.type : [vc.type];

  for (const desc of descriptors) {
    // Check if any type constraint in the descriptor matches this VC
    const typeConstraints =
      desc.constraints?.fields
        ?.filter(
          (f) => f.path?.includes("$.type") || f.path?.includes("$.vc.type"),
        )
        .flatMap((f) => f.filter?.const || []) || [];

    if (
      typeConstraints.length === 0 ||
      typeConstraints.some((t) => vcTypes.includes(t))
    ) {
      return desc.id;
    }
  }

  return descriptors[fallbackIndex]?.id || `descriptor-${fallbackIndex}`;
}

function _parseRequestObject(body) {
  // Try JSON first, then JWT payload
  try {
    return JSON.parse(body);
  } catch {
    const parts = body.trim().split(".");
    if (parts.length >= 2) {
      return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    }
    throw new Error("Cannot parse presentation request");
  }
}

function _randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function _derToCompact(compactHex) {
  // sign() now returns compact (r||s) hex directly — just base64url-encode it
  const bytes = new Uint8Array(compactHex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(compactHex.slice(i * 2, i * 2 + 2), 16);
  return _b64url(String.fromCharCode(...bytes));
}
