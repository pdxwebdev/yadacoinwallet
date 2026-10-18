/**
 * useCredentialDisplay.js
 *
 * Extracts issuer-provided display metadata from a W3C VC so the wallet
 * can render credentials using the issuer's preferred presentation rather
 * than falling back to raw key/value enumeration.
 *
 * Supports:
 *   1. W3C Credential Display spec — vc.renderMethod[].type === "SvgRenderingTemplate2023"
 *   2. Credential Manifest display (OB2 / older) — vc.display.{name, description, backgroundColor, textColor, logo}
 *   3. OID4VCI credential_configuration display metadata (passed in separately)
 *   4. Inline vc.name / vc.description as fallback
 *
 * Returns a plain display object:
 * {
 *   name:            string | null,
 *   description:     string | null,
 *   backgroundColor: string | null,   // hex e.g. "#1a1a2e"
 *   textColor:       string | null,
 *   logo:            { uri, altText } | null,
 *   backgroundImage: { uri, altText } | null,
 *   svgTemplate:     string | null,   // SVG markup or URL
 * }
 */

export function getCredentialDisplay(vc, issuerMeta = null) {
  const result = {
    name: null,
    description: null,
    backgroundColor: null,
    textColor: null,
    logo: null,
    backgroundImage: null,
    svgTemplate: null,
  };

  if (!vc) return result;

  // ── 1. W3C renderMethod ───────────────────────────────────────────────────
  const renderMethods = vc.renderMethod || vc["render"];
  if (Array.isArray(renderMethods)) {
    for (const rm of renderMethods) {
      if (
        rm.type === "SvgRenderingTemplate2023" ||
        rm.type === "SvgRenderingTemplate"
      ) {
        result.svgTemplate = rm.template || rm.id || null;
        break;
      }
    }
  }

  // ── 2. Credential Manifest / OB display block ─────────────────────────────
  const display = vc.display;
  if (display && typeof display === "object") {
    result.name ??= _localizedString(display.name);
    result.description ??= _localizedString(display.description);
    result.backgroundColor ??=
      display.background_color || display.backgroundColor || null;
    result.textColor ??= display.text_color || display.textColor || null;
    if (display.logo) {
      result.logo = {
        uri: display.logo.uri || display.logo.url || display.logo,
        altText: display.logo.alt_text || display.logo.altText || "",
      };
    }
    if (display.background_image || display.backgroundImage) {
      const bi = display.background_image || display.backgroundImage;
      result.backgroundImage = {
        uri: bi.uri || bi.url || bi,
        altText: bi.alt_text || bi.altText || "",
      };
    }
  }

  // ── 3. OID4VCI issuer metadata (credential_configuration display array) ───
  if (issuerMeta && Array.isArray(issuerMeta.display)) {
    // Prefer the first English entry, fall back to first entry
    const d =
      issuerMeta.display.find((e) => /^en/i.test(e.locale)) ||
      issuerMeta.display[0];
    if (d) {
      result.name ??= d.name || null;
      result.description ??= d.description || null;
      result.backgroundColor ??= d.background_color || null;
      result.textColor ??= d.text_color || null;
      if (d.logo && !result.logo) {
        result.logo = {
          uri: d.logo.uri || d.logo.url || d.logo,
          altText: d.logo.alt_text || "",
        };
      }
      if (d.background_image && !result.backgroundImage) {
        result.backgroundImage = {
          uri:
            d.background_image.uri ||
            d.background_image.url ||
            d.background_image,
          altText: d.background_image.alt_text || "",
        };
      }
    }
  }

  // ── 4. Inline vc.name / vc.description (W3C VCDM 2.0 optional fields) ────
  result.name ??= _localizedString(vc.name) || null;
  result.description ??= _localizedString(vc.description) || null;

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a localized string value.
 * Handles plain strings, { "@value": "..." }, and [{ "@value": "...", "@language": "en" }] arrays.
 */
function _localizedString(val) {
  if (!val) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object" && !Array.isArray(val)) {
    return val["@value"] || val.value || null;
  }
  if (Array.isArray(val)) {
    const en = val.find((v) => /^en/i.test(v["@language"] || v.language || ""));
    const first = en || val[0];
    return first?.["@value"] || first?.value || null;
  }
  return null;
}
