/**
 * Redaction core (§3 M7). Runs before ANY raw excerpt, error message, log line or CloseReason
 * leaves the library. Each codec adds its own secret keys / URL patterns.
 */

const BASE_SECRET_KEYS = [
  "auth", "authorization", "token", "authToken", "auth-token", "auth_token", "access-token", "access_token", "accessToken",
  "listenKey", "listen-key", "signature", "sig", "hmac", "apiKey", "api_key", "api-key", "x-api-key",
  "secret", "secretKey", "secret_key", "secret-key", "privateKey", "private_key", "private-key", "password", "passphrase",
];

export const REDACTED = "<redacted>";
export const RAW_EXCERPT_MAX = 200;

export type Redactor = (s: string) => string;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Patterns (keys case-insensitive, hyphen/underscore variants listed):
 *  - JSON `"key": <string | number | bool | [..] | {..}>` (one nesting level for arrays/objects)
 *  - the same at any escaping depth (`\"key\":\"v\"`, JSON inside a string inside JSON)
 *  - query `?key=v` / `&key=v`, and URL-encoded `key%3Dv`
 *  - free text `key: v`, `key = "v"`, `key='v'`
 *  - `Bearer <token>` / `Basic <token>`
 *  - codec URL patterns (e.g. a listenKey path segment)
 */
export function createRedactor(secretKeys: readonly string[], urlPatterns: readonly RegExp[] = []): Redactor {
  const keys = Array.from(new Set([...BASE_SECRET_KEYS, ...secretKeys])).map(escapeRe).join("|");
  const K = `(?<![A-Za-z0-9_])(?:${keys})(?![A-Za-z0-9_])`;
  // arrays/objects with up to one nested level
  const nested = `\\[(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*\\]|\\{(?:[^{}]|\\{[^{}]*\\})*\\}`;
  const json = new RegExp(`("(?:${keys})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|${nested}|-?\\d[\\d.eE+-]*|true|false)`, "gi");
  const escaped = new RegExp(`((\\\\+)"(?:${keys})\\\\+"\\s*:\\s*)(?:\\\\+"(?:(?!\\\\+").)*\\\\+"|\\[[^\\]]*\\]|\\{[^}]*\\}|-?\\d[\\d.eE+-]*|true|false)`, "gi");
  const query = new RegExp(`([?&]${K}=)[^&#\\s"'\\\\]*`, "gi");
  const encoded = new RegExp(`(${K}%3D)(?:[A-Za-z0-9._~+/-]|%(?!26)[0-9A-Fa-f]{2})*`, "gi");
  // the quote may itself be escaped (\\" inside a JSON string): the same sequence closes it
  const quotedText = new RegExp(`(${K}\\s*[=:]\\s*)(\\\\*["'])(?:(?!\\2).)*\\2`, "gi");
  const text = new RegExp(`(${K}\\s*[=:]\\s*)(?![\\s"'\\\\<])[^\\s,;&"'}\\]\\\\]+`, "gi");
  const bearer = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
  return (s: string): string => {
    let out = s
      .replace(json, `$1"${REDACTED}"`)
      .replace(escaped, (_m, prefix: string, slashes: string) => `${prefix}${slashes}"${REDACTED}${slashes}"`)
      .replace(query, `$1${REDACTED}`)
      .replace(encoded, `$1${REDACTED}`)
      .replace(bearer, `$1 ${REDACTED}`)
      .replace(quotedText, `$1$2${REDACTED}$2`)
      .replace(text, `$1${REDACTED}`);
    for (const p of urlPatterns) out = out.replace(p, REDACTED);
    return out;
  };
}

/** Redacted excerpt of at most RAW_EXCERPT_MAX characters (redact first, then cut). */
export function excerpt(redact: Redactor, s: string): string {
  const r = redact(s);
  return r.length <= RAW_EXCERPT_MAX ? r : `${r.slice(0, RAW_EXCERPT_MAX - 1)}…`;
}
