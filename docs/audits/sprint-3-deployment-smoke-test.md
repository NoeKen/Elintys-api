# Sprint 3 — Smoke test de déploiement

Date : 6 août 2026 · Exécuté avant toute modification fonctionnelle, sur
`09a2883` (api) et `d91ecdd` (web).

---

## 1. Disponibilité

| Cible | Résultat |
|---|---|
| `GET https://api.dev.elintys.com/api/v1/health` | **200** en 114 ms — `{"status":"ok","service":"elintys-api"}` |
| `GET https://api.dev.elintys.com/api/v1/events?limit=1` | **200** |
| `https://dev.elintys.com` | **302** vers `vercel.com/sso-api` |
| `https://elintys.com` | **308** |

Le frontend de développement est protégé par le SSO de déploiement Vercel :
il n'est pas atteignable sans session Vercel. Ce n'est pas un défaut, mais
cela **empêche tout smoke test applicatif du frontend déployé** depuis cet
environnement.

---

## 2. Topologie réelle : un proxy de plus que prévu

L'en-tête de réponse de l'API annonce :

```
server: cloudflare
```

La chaîne réelle est donc au minimum :

```
client → Cloudflare → proxy de plateforme → API
```

soit **deux sauts**, alors que `TRUSTED_PROXY_HOPS` vaut `1` par défaut en
production. C'est précisément le risque n° 1 consigné au Sprint 2.5, qui
demandait de vérifier cette valeur au premier déploiement.

### 2.1 Conséquence, démontrée localement

Instance de production locale, `TRUSTED_PROXY_HOPS=1` :

| Chaîne `X-Forwarded-For` reçue | Adresse retenue |
|---|---|
| `203.0.113.7` (un seul saut) | `203.0.113.7` — ✅ le client |
| `203.0.113.7, 172.16.0.9` (deux sauts) | **`172.16.0.9`** — ❌ l'intermédiaire |

Avec une chaîne à deux entrées et un seul saut de confiance, l'API retient
l'adresse du **proxy intermédiaire**. Tous les visiteurs passant par ce même
intermédiaire partagent alors un unique compteur de rate-limiting.

**C'est F-019, sous la forme corrigée au Sprint 2.5, qui redevient actif si la
configuration déployée ne compte pas le bon nombre de sauts.**

### 2.2 Ce qui n'a pas pu être vérifié

La valeur réellement appliquée en déploiement n'est **pas observable depuis
l'extérieur** : aucun endpoint n'exposait l'adresse résolue ni le nombre de
sauts de confiance, et rien n'indique quel commit est déployé.

Le verdict « bêta autorisée — backend » du Sprint 2.5 reposait donc sur une
hypothèse de topologie que ce smoke test contredit.

---

## 3. Comportement du throttling déployé

| Vérification | Résultat |
|---|---|
| Tier strict actif sur `/auth/login` | ✅ 429 observés au-delà du seuil |
| `X-Forwarded-For` forgé accepté comme source de vérité | ✅ **non** — six adresses synthétiques distinctes restent comptées ensemble |
| Compteurs distincts entre deux clients réels | ⚠️ **non vérifiable** — une seule adresse source disponible |
| Déterminisme du seuil | ⚠️ **non** — voir ci-dessous |

Séquence observée sur 16 tentatives de connexion depuis une même source :

```
401 401 429 429 429 429 429 401 401 429 429 429 429 429 429 429
```

L'alternance de 401 après des 429 est la signature d'un **compteur en mémoire
réparti sur plusieurs instances** : chaque instance applique son propre quota.
C'est le risque n° 4 consigné au Sprint 2.5. Sans effet sur la sécurité — le
seuil finit toujours par s'appliquer — mais le quota effectif est multiplié
par le nombre d'instances.

Les identifiants utilisés pour ces vérifications sont volontairement
inexistants (`@example.invalid`) : aucun compte réel n'a été sollicité.
Aucune adresse IP réelle n'a été journalisée ni conservée ; seules des
adresses de documentation (RFC 5737) figurent dans ce rapport.

---

## 4. Correctif apporté par ce smoke test

Ajout de `GET /api/v1/health/client`, qui rend la configuration vérifiable
depuis l'extérieur :

```json
{ "resolvedIp": "…", "resolvedIsChainHead": true, "forwardedChainLength": 2 }
```

- `resolvedIp` — l'adresse retenue pour le rate-limiting. L'appelant ne reçoit
  que **sa propre** adresse, qu'il connaît déjà : aucune donnée d'un tiers
  n'est divulguée.
- `resolvedIsChainHead` — `false` signale que `TRUSTED_PROXY_HOPS` est
  inférieur au nombre réel de proxys, donc que le défaut est actif.
- `forwardedChainLength` — le nombre de sauts à déclarer.

Trois tests unitaires couvrent les trois cas : chaîne traversée, saut de trop
peu, absence de proxy.

---

## 5. Action requise avant ouverture bêta

1. Déployer le commit courant sur l'environnement de développement.
2. Appeler `GET /api/v1/health/client` depuis un poste ordinaire.
3. Si `resolvedIsChainHead` vaut `false`, porter `TRUSTED_PROXY_HOPS` à la
   valeur de `forwardedChainLength` et redéployer.
4. Confirmer que `resolvedIp` correspond bien à l'adresse publique du poste.

Tant que ce contrôle n'est pas passé, **la tenue en charge publique ne peut
pas être considérée comme validée en conditions réelles**, quel que soit le
résultat des mesures locales.

---

## 6. Verdict du smoke test

| Point | État |
|---|---|
| Vercel dev répond | ✅ (protégé par SSO) |
| API dev répond | ✅ |
| `/health` | ✅ |
| Authentification | ✅ rejet correct d'identifiants invalides |
| Résolution d'IP derrière proxy | ❌ **non conforme à la topologie réelle** |
| `TRUSTED_PROXY_HOPS=1` correspond à la topologie | ❌ **au moins 2 sauts observés** |
| Compteurs distincts entre deux clients | ⚠️ non vérifiable de l'extérieur avant déploiement du diagnostic |
| En-tête forgé non accepté | ✅ |
| Aucun log d'IP conservé | ✅ |

**Nouveau finding — F-047, P1 : la configuration de proxy de confiance ne
correspond pas à la topologie de déploiement réelle.** Le rate-limiting par
visiteur, corrigé au Sprint 2.5, est probablement inopérant en déploiement.

Le Sprint 3 s'arrête ici conformément à sa règle d'arrêt (« un nouveau
P0/P1 apparaît »).
