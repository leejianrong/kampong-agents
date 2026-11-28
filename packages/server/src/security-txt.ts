// KAM-331: /.well-known/security.txt (RFC 9116), so a researcher or a buyer's security team can find where to report a
// vulnerability. The contact is the operator's to supply (`SECURITY_CONTACT`, chart value `security.contact`); without
// one there is nothing honest to serve, and the route answers 404. `Expires` is always about six months ahead of the
// request, so a file that is no longer maintained does not go on claiming a contact for ever: RFC 9116 asks for a
// date less than a year out, and one that moves with the clock needs no yearly edit.

export interface SecurityTxtConfig {
  /** A `mailto:` or `https:` URI where reports go. */
  contact: string;
  /** Where the disclosure policy is published. */
  policy?: string;
}

const EXPIRES_DAYS = 180;

export function getSecurityTxtConfig(
  env: NodeJS.ProcessEnv = process.env,
): SecurityTxtConfig | undefined {
  const contact = env["SECURITY_CONTACT"]?.trim();
  if (!contact) return undefined;
  const allowed = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/;
  if (!allowed.test(contact)) {
    throw new Error(
      `SECURITY_CONTACT must be a mailto: address or an https:// URL, got "${contact}".`,
    );
  }
  const policy = env["SECURITY_POLICY_URL"]?.trim();
  if (policy && !/^https:\/\/\S+$/.test(policy)) {
    throw new Error(`SECURITY_POLICY_URL must be an https:// URL, got "${policy}".`);
  }
  return { contact, ...(policy ? { policy } : {}) };
}

export function buildSecurityTxt(config: SecurityTxtConfig, now: Date = new Date()): string {
  const expires = new Date(now.getTime() + EXPIRES_DAYS * 86_400_000).toISOString();
  return [
    `Contact: ${config.contact}`,
    `Expires: ${expires}`,
    ...(config.policy ? [`Policy: ${config.policy}`] : []),
    "Preferred-Languages: en",
    "",
  ].join("\n");
}
