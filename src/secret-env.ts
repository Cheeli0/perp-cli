/**
 * Environment variables that carry key material (SSOT Rule #3).
 *
 * Child processes (tmux background jobs, the OWS CLI) never receive these: they
 * are stripped from the child's environment, and a background job resolves its
 * credentials itself from the OWS vault / agent keystores / ~/.perp/.env.
 */

/** Every secret-bearing env var perp-cli (or the OWS CLI) reads. */
export const SECRET_ENV_NAMES: readonly string[] = [
  "PRIVATE_KEY", "pk",
  "PACIFICA_PRIVATE_KEY", "HL_PRIVATE_KEY", "HYPERLIQUID_PRIVATE_KEY",
  "LIGHTER_PRIVATE_KEY", "LT_PRIVATE_KEY", "ASTER_PRIVATE_KEY", "LIGHTER_API_KEY",
  "OWS_PASSPHRASE", "OWS_API_KEY", "OWS_PRIVATE_KEY", "OWS_MNEMONIC",
  "LWS_PASSPHRASE", "LWS_PRIVATE_KEY", "LWS_MNEMONIC",
];

const SECRET_NAME_PATTERN = /PRIVATE_KEY|PASSPHRASE|SECRET|MNEMONIC|(^|_)API_KEY$/i;

/** True when an env var name is (or looks like) key material. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAMES.includes(name) || SECRET_NAME_PATTERN.test(name);
}

/** Secret env var names to remove from a child: the fixed list plus any secret-looking name in `env`. */
export function secretEnvNamesIn(env: NodeJS.ProcessEnv): string[] {
  const names = new Set(SECRET_ENV_NAMES);
  for (const k of Object.keys(env)) if (isSecretEnvName(k)) names.add(k);
  return [...names];
}

/** A copy of `env` without any secret-bearing variable. */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!isSecretEnvName(k)) out[k] = v;
  return out;
}
