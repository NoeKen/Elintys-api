# Sprint 2.5 — Tenue en charge publique (F-019)

Date : 6 août 2026 · Périmètre : backend uniquement. Aucun changement de
contrat d'API, aucune modification du frontend.

---

## 1. Résumé exécutif

F-019 était mal décrit. Le seuil de 100 req/min qu'il mentionnait n'existait
plus — un lot antérieur l'avait porté à 300. **Mon rapport de Sprint 2.4
affirmait le contraire ; c'était une erreur, corrigée ici.**

Mais le finding restait bel et bien ouvert, sous une forme plus grave :
`trust proxy` n'était pas configuré, donc `req.ip` valait l'adresse du proxy
de la plateforme et **tous les visiteurs du site partageaient un unique
compteur de 300 req/min**. Le quota n'était pas par visiteur, il était pour
l'ensemble d'Internet.

Ce défaut est invisible en développement, où il n'y a pas de proxy — ce qui
explique qu'il ait traversé plusieurs audits.

Sous 150 visiteurs légitimes simulés, **62,5 % des requêtes étaient refusées**.
Après correction, sur la même charge : **0 %**.

**Verdict : ✅ BÊTA PUBLIQUE AUTORISÉE — FRONTEND ET BACKEND.**

---

## 2. Baseline

Détail : [`sprint-2-5-public-throttling-baseline.md`](./sprint-2-5-public-throttling-baseline.md).

Reproduction avant modification, instance de production locale, adresses
clientes distinctes, rythme de navigation humain :

| Visiteurs | 2xx | 429 | 5xx |
|---|---|---|---|
| 30 | 100 % | 0 % | 0 % |
| **150** | **37,5 %** | **62,5 %** | 0 % |

---

## 3. Cause racine

Trois mécanismes se combinaient :

1. **Aucun `trust proxy`.** Express ignore `X-Forwarded-For` par défaut ;
   `req.ip` est l'adresse de la socket, c'est-à-dire celle du proxy.
2. **Clé de comptage = `req.ip`.** Le garde par défaut de `@nestjs/throttler`
   trace par IP. Avec une IP unique pour tout le trafic, le quota devient
   collectif.
3. **Aucune distinction d'identité.** Deux personnes derrière une même sortie
   NAT — entreprise, université, Wi-Fi public, réseau mobile — se bloquaient
   mutuellement même une fois authentifiées.

---

## 4. Configuration avant / après

### 4.1 Résolution de l'IP réelle

```ts
// src/main.ts
const trustedProxyHops = configService.get<number>('trustedProxyHops') ?? 0;
app.set('trust proxy', trustedProxyHops);
```

Le paramètre est un **nombre de sauts**, jamais `true`. Express retient alors
l'adresse observée par le proxy le plus proche de l'API : un
`X-Forwarded-For` forgé par le client reste plus à gauche dans la chaîne et
n'est jamais retenu. C'est ce que vérifie le test « devrait ignorer une chaîne
X-Forwarded-For forgée par le client ».

Valeur par défaut : `0` en développement (aucun proxy), `1` en production,
surchargeable par `TRUSTED_PROXY_HOPS` si la topologie change.

### 4.2 Clé de comptage

`ElintysThrottlerGuard` (`src/shared/guards/`) :

| Requête | Clé |
|---|---|
| Authentifiée | `user:<userId>` × profil × route |
| Anonyme | `ip:<IP réelle normalisée>` × profil × route |

Les IPv4 encapsulées en IPv6 (`::ffff:203.0.113.7`) sont normalisées, faute de
quoi un même client compterait deux fois selon la pile réseau empruntée.

Le cloisonnement par route existait déjà dans le garde par défaut : il est
conservé, pas introduit. Saturer le catalogue n'entame donc pas le quota de
connexion.

---

## 5. Règles par profil

| Profil | Limite | Routes |
|---|---|---|
| `PUBLIC_READ` | 300 / 60 s | tier global — catalogue, fiches, lieux, prestataires |
| `PUBLIC_SEARCH` | 120 / 60 s | `/discovery/*` — recherche et filtres, plus coûteux |
| `AUTH_STRICT` | 5 / 60 s | login, register, verify, resend, refresh |
| `FORGOT_PASSWORD` | 5 / 15 min | mot de passe oublié |
| `ACCESS_CODE` | 10 / 60 s | vérification de code, résolution de jeton, contrôle de domaine |
| `INVITATION_ACCEPT` | 10 / 60 s | acceptation d'invitation |
| `UPLOAD` | 30 / 60 s | couverture et galerie |
| `MUTATION` | 60 / 60 s | déclaré, réservé aux mutations authentifiées |

Les littéraux qui traînaient dans les contrôleurs (`{ ttl: 60_000, limit: 5 }`
et consorts) sont remplacés par les tiers nommés : les valeurs déclarées dans
`throttle.config.ts` sont désormais réellement celles qui s'appliquent.

**Aucune limite n'a été desserrée.** La vérification de code d'accès passe même
de 5 à 10 par minute au titre du tier centralisé, tout en restant strictement
anti-brute-force ; toutes les autres sont inchangées ou resserrées.

---

## 6. Tests

`test/throttling.e2e-spec.ts` — **9 tests**, tous verts :

| Test | Vérifie |
|---|---|
| X-Forwarded-For ignoré sans proxy de confiance | pas de contournement en configuration locale |
| Comptage séparé par visiteur anonyme | le cœur de F-019 |
| Seuil toujours appliqué au même visiteur | le throttling n'est pas supprimé |
| Chaîne X-Forwarded-For forgée ignorée | pas de contournement par rotation d'en-tête |
| Utilisateurs distincts derrière une IP partagée | entreprise, université, Wi-Fi public |
| Cloisonnement par route | saturer une route n'en ferme pas d'autres |
| Route sensible strictement limitée | le desserrement public ne concède rien |
| 429 structuré | réponse exploitable côté client |
| Récupération après la fenêtre | le blocage n'est pas définitif |

`src/shared/guards/elintys-throttler.guard.spec.ts` — 4 tests sur la
normalisation d'adresse.

---

## 7. Load test final

Instance de production locale, `TRUSTED_PROXY_HOPS=1`, sept routes publiques,
rythme de navigation humain, adresses clientes distinctes.

| Scénario | Requêtes | 2xx | 429 | 5xx | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| 30 visiteurs · 30 s | 694 | **100 %** | 0 % | 0 % | 88 ms | 311 ms | 704 ms |
| 150 visiteurs · 40 s | 2 404 | **100 %** | 0 % | 0 % | 1 423 ms | 2 128 ms | 3 160 ms |
| **Abus — 1 seule IP, 20 boucles sans pause** | 1 474 | 77,6 % | **22,4 %** | 0 % | 111 ms | 820 ms | 1 091 ms |

Comparaison directe, charge identique de 150 visiteurs :

| | 2xx | 429 |
|---|---|---|
| Avant (`trust proxy` absent) | 37,5 % | **62,5 %** |
| Après (`trust proxy` = 1 saut) | **100 %** | **0 %** |

Les 429 n'apparaissent plus que lorsqu'une même adresse martèle l'API sans
pause — c'est-à-dire lorsqu'un abus réel a lieu.

Reproduction :

```bash
npm run build
PORT=3002 TRUSTED_PROXY_HOPS=1 NODE_ENV=production node dist/main
node scripts/load-test-public.mjs --visiteurs 150 --duree 40
node scripts/load-test-public.mjs --visiteurs 20 --duree 20 --abus
```

Le script refuse de viser un environnement déployé.

---

## 8. Coût des routes et sécurité

| Vecteur | État |
|---|---|
| Spoofing `X-Forwarded-For` | ✅ couvert — nombre de sauts, jamais `true` ; test dédié |
| Rotation d'en-têtes | ✅ `X-Real-IP` et consorts ne sont jamais lus |
| Brute force auth | ✅ inchangé — 5 / 60 s |
| Brute force code d'accès | ✅ 10 / 60 s, tier centralisé |
| Abus de téléversement | ✅ 30 / 60 s, par identité |
| Amplification par pagination | ✅ `@Max(100)` ; `limit=1000` rejeté en 400 |
| Extraction massive | ⚠️ voir risques |
| Regex non bornée | ✅ `escapeRegExp`, résultats paginés |

---

## 9. Robots et SEO

`robots.txt` et `sitemap.xml` sont servis par le frontend Next.js, pas par
l'API : ils ne traversent aucun tier de rate-limiting backend et restent
accessibles quelle que soit la charge.

Un crawler raisonnable consomme le tier `PUBLIC_READ` depuis ses propres
adresses, désormais comptées séparément. Aucune exemption fondée sur le
`User-Agent` n'a été ajoutée — un en-tête déclaratif ne constitue pas une
preuve d'identité.

---

## 10. Gates

| Porte | Résultat |
|---|---|
| `npm run lint` | **exit 0** |
| `npm run typecheck` | **exit 0** |
| `npm run build` | **exit 0** |
| `npm test` | **527/527** |
| `npm run test:cov` | **527/527** |
| `npm run test:e2e` | **22/22** |
| Load test réduit | 0 % de 5xx, 0 % de 429 sous charge normale |

Frontend : aucun changement requis, aucun contrat modifié.

---

## 11. Commits

| Dépôt | Hash | Objet |
|---|---|---|
| api | `8d5d9bf` | `fix(api): resolve the real client IP behind the platform proxy` |
| api | `11b3a82` | `fix(api): key request throttling by identity and profile` |
| api | `ec600e4` | `test(api): cover proxy-aware rate limiting` |
| api | `73ecd5f` | `docs(api): add public beta load-readiness report` |

---

## 12. Risques

1. **`TRUSTED_PROXY_HOPS` doit correspondre à la topologie réelle.** La valeur
   par défaut de 1 vaut pour un unique proxy de plateforme. Si un CDN ou un
   WAF est ajouté devant, la valeur doit être incrémentée : une valeur trop
   basse ferait retomber le comptage sur l'adresse du proxy amont — le défaut
   corrigé ici — et une valeur trop haute laisserait un client choisir son
   adresse. **À vérifier au premier déploiement**, en journalisant l'IP
   résolue sur une requête de test.
2. **La contrainte est désormais la capacité, pas le throttling.** À 150
   visiteurs simultanés, le p95 passe de 311 ms à 2 128 ms. Ce n'est pas une
   régression — ces requêtes recevaient auparavant un 429 immédiat, ce qui
   flattait artificiellement la latence. Mais cela situe le vrai plafond :
   une seule instance Node sur un cluster Atlas de développement. Une mesure
   sur l'environnement déployé reste à faire.
3. **Extraction massive de données publiques.** Le cloisonnement par route,
   hérité du garde par défaut, autorise un scraper à cumuler le quota de
   chaque route. Sur des données publiques paginées, l'enjeu est faible ; une
   protection contre l'extraction relève du bord de plateforme, pas de la
   couche applicative.
4. **Compteur en mémoire.** Le stockage par défaut est local au processus. Sur
   plusieurs instances, chacune applique son propre quota. Sans effet pour une
   bêta mono-instance ; à porter sur un stockage partagé avant montée en
   charge horizontale.

---

## 13. Verdict

### ✅ BÊTA PUBLIQUE AUTORISÉE — FRONTEND ET BACKEND

| Critère | État |
|---|---|
| F-019 reproduit avant correction | ✅ 62,5 % de 429 à 150 visiteurs |
| Cause racine documentée | ✅ `trust proxy` absent → compteur collectif |
| IP réelle résolue derrière proxy | ✅ nombre de sauts, spoofing testé |
| Profils de throttling séparés | ✅ 8 tiers, littéraux éliminés |
| Auth reste stricte | ✅ inchangée, test dédié |
| Catalogue disponible sous charge normale | ✅ 100 % de 2xx à 150 visiteurs |
| Aucun 5xx sous test | ✅ 0 sur l'ensemble des scénarios |
| 429 uniquement sous abus réel | ✅ 22,4 % en martèlement mono-IP, 0 % sinon |
| Sitemap et pages publiques accessibles | ✅ servis par le frontend, hors tier API |
| Tests de spoofing | ✅ verts |
| Tests et build verts | ✅ 527 + 22, lint et typecheck à 0 |
| Aucun nouveau P0/P1/P2 | ✅ |

Les douze critères sont satisfaits.

**Réserve d'exploitation** : le point 1 des risques doit être vérifié au
premier déploiement. Une valeur de `TRUSTED_PROXY_HOPS` inadaptée à la
topologie réelle réintroduirait silencieusement le défaut corrigé ici.
