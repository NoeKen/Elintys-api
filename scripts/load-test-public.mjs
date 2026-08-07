#!/usr/bin/env node
/**
 * Test de charge de la zone publique (F-019).
 *
 * Usage :
 *   node scripts/load-test-public.mjs [--base URL] [--visiteurs N] [--duree S] [--abus]
 *
 * Chaque visiteur simulé annonce sa propre adresse via `X-Forwarded-For`,
 * comme le ferait le proxy de la plateforme. L'API doit être démarrée avec
 * `TRUSTED_PROXY_HOPS=1` pour que cet en-tête soit pris en compte.
 *
 * `--abus` bascule tous les appels sur une **seule** adresse : le scénario
 * doit alors produire des 429, faute de quoi le rate-limiting ne protège plus
 * rien.
 *
 * Sécurité : ne jamais viser un environnement de production.
 */

function arg(nom, defaut) {
  const index = process.argv.indexOf(`--${nom}`);
  return index === -1 ? defaut : process.argv[index + 1];
}

const BASE = arg('base', 'http://localhost:3002/api/v1');
const VISITEURS = Number(arg('visiteurs', '30'));
const DUREE_S = Number(arg('duree', '30'));
const ABUS = process.argv.includes('--abus');

if (/elintys\.com|render\.com|railway\.app/.test(BASE)) {
  console.error('Refus : ce test ne doit pas viser un environnement déployé.');
  process.exit(1);
}

/** Parcours réaliste d'un visiteur du catalogue. */
const PARCOURS = [
  '/events?page=1&limit=20',
  '/events/categories',
  '/events?page=2&limit=20',
  '/discovery/featured',
  '/vendors?page=1&limit=20',
  '/venues?page=1&limit=20',
  '/discovery/search?q=gala&limit=10',
];

const latences = [];
const statuts = {};
let premier429 = null;
const debut = Date.now();

async function visiteur(index) {
  // En mode abus, tout le trafic provient d'une seule adresse.
  const ip = ABUS ? '203.0.113.1' : `203.0.113.${index % 250}`;
  while (Date.now() - debut < DUREE_S * 1000) {
    const chemin = PARCOURS[Math.floor(Math.random() * PARCOURS.length)];
    const t0 = performance.now();
    try {
      const reponse = await fetch(`${BASE}${chemin}`, {
        headers: { 'X-Forwarded-For': ip },
      });
      latences.push(performance.now() - t0);
      statuts[reponse.status] = (statuts[reponse.status] ?? 0) + 1;
      if (reponse.status === 429 && premier429 === null) {
        premier429 = { apresMs: Date.now() - debut, requetes: latences.length };
      }
    } catch (erreur) {
      statuts.erreur = (statuts.erreur ?? 0) + 1;
      if (latences.length === 0) console.error(String(erreur));
    }
    // Cadence d'une navigation humaine : une action toutes ~1,2 s.
    if (!ABUS) await new Promise((resoudre) => setTimeout(resoudre, 900 + Math.random() * 600));
  }
}

const percentile = (valeurs, p) => {
  if (!valeurs.length) return 0;
  const triees = [...valeurs].sort((a, b) => a - b);
  return Math.round(triees[Math.min(triees.length - 1, Math.floor((p / 100) * triees.length))]);
};

console.log(
  `Charge : ${VISITEURS} visiteurs · ${DUREE_S} s · ${ABUS ? 'UNE SEULE IP (abus)' : 'IP distinctes'} · ${BASE}`,
);
await Promise.all(Array.from({ length: VISITEURS }, (_, index) => visiteur(index)));

const total = Object.values(statuts).reduce((somme, valeur) => somme + valeur, 0);
const duree = (Date.now() - debut) / 1000;
const compte = (code) => statuts[code] ?? 0;
const part = (code) => `${((compte(code) / total) * 100).toFixed(2)} %`;
const cinqCents = Object.entries(statuts)
  .filter(([code]) => Number(code) >= 500)
  .reduce((somme, [, valeur]) => somme + valeur, 0);

console.log(`
Requêtes      : ${total} en ${duree.toFixed(1)} s (${(total / duree).toFixed(1)} req/s)
2xx           : ${compte(200)} (${part(200)})
429           : ${compte(429)} (${part(429)})
5xx           : ${cinqCents} (${((cinqCents / total) * 100).toFixed(2)} %)
p50 / p95 / p99 : ${percentile(latences, 50)} / ${percentile(latences, 95)} / ${percentile(latences, 99)} ms
premier 429   : ${premier429 ? `après ${premier429.apresMs} ms (${premier429.requetes} requêtes)` : 'aucun'}
statuts bruts : ${JSON.stringify(statuts)}
`);
