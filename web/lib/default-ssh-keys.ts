/**
 * Learner SSH keys are supplied per session (and, going forward, stored per user).
 * No key is committed to the repo. An optional dev-only default may be set via env,
 * but it is NEVER unioned alongside a learner-supplied key on a multi-tenant lab host.
 */
function configuredDefaultKeysRaw(): string {
  return (
    process.env.OPSCOACH_DEFAULT_LEARNER_PUBKEY?.trim() ||
    process.env.NEXT_PUBLIC_DEFAULT_LEARNER_PUBKEY?.trim() ||
    ""
  );
}

/** Optional dev-only default learner keys from env (comma or newline separated). */
export function defaultLearnerPublicKeys(): string[] {
  const keys = configuredDefaultKeysRaw()
    .split(/[\n,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

export function defaultLearnerPublicKey(): string {
  return defaultLearnerPublicKeys()[0] ?? "";
}

export function resolveLearnerPublicKey(input: string): {
  publicKey: string;
  extraAuthorizedKeys: string[];
} {
  const trimmed = input.trim();
  if (trimmed) {
    // A learner-supplied key is the only learner key on the host. Never union shared
    // defaults onto a multi-tenant lab — that would be a cross-tenant access key.
    return { publicKey: trimmed, extraAuthorizedKeys: [] };
  }

  const defaults = defaultLearnerPublicKeys();
  if (defaults.length === 0) {
    // No learner key supplied — that's fine. The lab is still reachable via the
    // in-browser terminal (which connects with the server-side grader key); the learner
    // just can't SSH in from their own client until they add a key.
    return { publicKey: "", extraAuthorizedKeys: [] };
  }
  return {
    publicKey: defaults[0]!,
    extraAuthorizedKeys: defaults.slice(1),
  };
}

export function learnerPublicKeyForSession(submittedPublicKey: string): string {
  return resolveLearnerPublicKey(submittedPublicKey).publicKey;
}

/**
 * Learner + default extras + a per-session vended key + grader keys written to the
 * lab authorized_keys file. `extraKeys` carries the throwaway key the platform vends
 * so a browser-terminal learner (who submitted no key of their own) can still SSH in.
 */
export function authorizedKeysForLab(
  submittedPublicKey: string,
  graderPublicKey: string,
  extraKeys: string[] = []
): string[] {
  const { publicKey, extraAuthorizedKeys } =
    resolveLearnerPublicKey(submittedPublicKey);
  const keys = [
    publicKey,
    ...extraAuthorizedKeys,
    ...extraKeys.map((key) => key.trim()),
    graderPublicKey.trim(),
  ].filter(Boolean);
  return [...new Set(keys)];
}
