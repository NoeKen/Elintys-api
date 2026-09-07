/**
 * Appartenance d'un nom d'hôte à une liste blanche FERMÉE.
 *
 * Deux approches naïves sont écartées :
 *
 * 1. `hostname.endsWith('paypal.com')` — accepte `paypal.com.attacker.tld` et
 *    `fakepaypal.com`, faute de frontière de label.
 *
 * 2. La correspondance par domaine avec frontière (`host === domain ||
 *    host.endsWith('.' + domain)`) corrige le point 1 mais reste insuffisante
 *    ici : `www.sandbox.paypal.com` EST un sous-domaine de `paypal.com`. Une
 *    liste live construite sur le domaine accepterait donc les URL Sandbox, et
 *    la confusion d'environnement — exactement ce qu'on veut interdire —
 *    passerait inaperçue.
 *
 * D'où la comparaison EXACTE : la liste énumère les hôtes attendus, rien de
 * plus. Elle est plus stricte que les deux alternatives et cloisonne
 * réellement Sandbox et Live.
 */
function normalizeHost(value: string): string {
  // Le point final absolu (`paypal.com.`) désigne le même hôte en DNS.
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function isAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return allowedHosts.some((allowed) => {
    const candidate = normalizeHost(allowed);
    return candidate.length > 0 && candidate === host;
  });
}
