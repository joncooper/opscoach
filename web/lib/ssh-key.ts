// Accepted OpenSSH public-key types. Kept conservative — these are the formats the lab
// hosts' sshd accepts in authorized_keys.
const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ssh-dss",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

const MAX_KEY_LENGTH = 8192;

export interface PublicKeyValidation {
  ok: boolean;
  key?: string;
  error?: string;
}

/**
 * Validate a single OpenSSH public key. Returns the normalized (trimmed) key on success.
 * Rejects multi-line input, unknown types, and malformed base64 blobs so we never write
 * junk — or multiple keys — into a lab host's authorized_keys.
 */
export function validatePublicKey(input: string): PublicKeyValidation {
  const key = input.trim();
  if (!key) {
    return { ok: false, error: "Public key is required." };
  }
  if (key.length > MAX_KEY_LENGTH) {
    return { ok: false, error: "Public key is too long." };
  }
  if (/[\r\n]/.test(key)) {
    return { ok: false, error: "Paste a single public key (one line)." };
  }
  const parts = key.split(/\s+/);
  if (parts.length < 2) {
    return { ok: false, error: "That doesn't look like an SSH public key." };
  }
  const [type, blob] = parts;
  if (!KEY_TYPES.has(type)) {
    return {
      ok: false,
      error: `Unsupported key type "${type}". Use an ed25519, ecdsa, or rsa key.`,
    };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || blob.length < 16) {
    return { ok: false, error: "The key body is not valid base64." };
  }
  return { ok: true, key };
}
