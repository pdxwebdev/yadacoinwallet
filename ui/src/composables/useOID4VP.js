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
   * Present selected credentials to the verifier.
   * selectedVCs: array of W3C VC objects the user has chosen to present.
   * Returns the verifier's response (often a redirect URI or status).
   */
  async function present(selectedVCs) {
    if (!presentationRequest.value)
      throw new Error("No active presentation request");
    vpStatus.value = "presenting";
    try {
      const req = presentationRequest.value;
      const { did, publicKeyHex } = vault.getHolderInfo();
      const nonce = req.nonce || _randomHex(16);
      const now = Math.floor(Date.now() / 1000);

      // Build the VP
      const vp = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiablePresentation"],
        holder: did,
        verifiableCredential: selectedVCs,
      };

      // Sign the VP as a JWT (vp_token)
      const vpToken = await _buildVpJwt(vp, req, did, publicKeyHex, nonce, now);

      // Build presentation_submission mapping credentials to descriptor IDs
      const submission = _buildSubmission(
        req.presentation_definition,
        selectedVCs,
      );

      // POST to response_uri (direct_post)
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

async function _buildVpJwt(vp, req, did, pubKeyHex, nonce, now) {
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
    exp: now + 300, // 5 minutes
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

function _buildSubmission(presentationDefinition, selectedVCs) {
  const descriptors = (presentationDefinition?.input_descriptors || []).map(
    (desc, i) => ({
      id: desc.id,
      format: "ldp_vc",
      path: "$",
      path_nested: {
        format: "ldp_vc",
        path: `$.verifiableCredential[${i}]`,
      },
    }),
  );
  return {
    id: _randomHex(8),
    definition_id: presentationDefinition?.id || "default",
    descriptor_map: descriptors,
  };
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

function _derToCompact(derHex) {
  const hex = derHex;
  const der = new Uint8Array(hex.length / 2);
  for (let i = 0; i < der.length; i++)
    der[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let i = 2;
  i++;
  const rLen = der[i++];
  const r = der.slice(i, i + rLen);
  i += rLen;
  i++;
  const sLen = der[i++];
  const s = der.slice(i, i + sLen);
  const rPad = new Uint8Array(32);
  const sPad = new Uint8Array(32);
  rPad.set(r.slice(-32), 32 - Math.min(r.length, 32));
  sPad.set(s.slice(-32), 32 - Math.min(s.length, 32));
  const compact = new Uint8Array(64);
  compact.set(rPad, 0);
  compact.set(sPad, 32);
  return _b64url(String.fromCharCode(...compact));
}
