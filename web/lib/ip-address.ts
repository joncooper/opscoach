/** Returns true when the value is an IPv4 address learners cannot reach from the internet. */
export function isPrivateOrUnroutableIp(host: string): boolean {
  const trimmed = host.trim();
  if (!trimmed) {
    return true;
  }

  const ipv4 = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    // Anything that is not a plain IPv4 literal (hostname, IPv6, etc.) is treated as
    // not-public-routable, so it can never pass isPublicRoutableIp's allowlist.
    return true;
  }

  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;

  return false;
}

export function isPublicRoutableIp(host: string): boolean {
  const trimmed = host.trim();
  if (!trimmed) {
    return false;
  }
  return !isPrivateOrUnroutableIp(trimmed);
}

/** SSH target shown to learners — never expose VPC-private addresses. */
export function learnerSshHost(
  sshHost: string | null | undefined
): string | null {
  if (!sshHost || isPrivateOrUnroutableIp(sshHost)) {
    return null;
  }
  return sshHost;
}
