# Sprint 2.5 — Baseline du throttling public (F-019)

Date : 6 août 2026. Établi **avant toute modification**, sur `fcd9e4b`,
working tree propre sur `dev`.

---

## 1. Correction de la fiche du finding

Le brief de ce sprint reprenait la formulation d'origine de F-019 : « la zone
publique retourne massivement 429 au-delà d'une charge relativement faible,
seuil ~100 req/min ». **Cette description ne correspondait plus à l'état du
code.**

Un lot de correction antérieur avait déjà relevé le tier global de 100 à 300
req/min. Vérification par rafale séquentielle sur l'API locale :

```
GET /events?limit=1  ×400  →  {"200":300,"429":100}
premier 429 : requête n° 301
```

Le seuil est bien de 300, pas de 100.

**Le rapport de préparation bêta du Sprint 2.4 affirmait que F-019 restait
ouvert dans sa forme d'origine. C'était une erreur de ma part** : je m'étais
appuyé sur `performance-review.md`, le rapport d'audit initial, sans vérifier
que le lot suivant l'avait déjà traité.

Cette erreur n'invalide pas le sprint : le finding **est** resté ouvert, mais
sous une autre forme, plus grave et invisible en local.

---

## 2. La vraie cause : la clé de comptage

### 2.1 Aucun `trust proxy` configuré

`src/main.ts` ne contenait aucun `app.set('trust proxy', …)`. Express
n'accorde alors **aucune** confiance à `X-Forwarded-For` : `req.ip` vaut
l'adresse de la socket TCP.

En production, la socket est celle du proxy de la plateforme. `req.ip` est
donc **la même valeur pour tous les visiteurs du site**.

### 2.2 Preuve

320 requêtes annonçant 250 adresses clientes distinctes, sur l'API locale
avant correction :

```
X-Forwarded-For: 203.0.113.{0..249}   ×320
→ {"200":300,"429":20}
```

Les 250 adresses partagent un unique compteur. L'en-tête est ignoré — ce qui
est le comportement correct **en l'absence de proxy de confiance**, mais qui
devient le défaut dès qu'un proxy est réellement présent.

### 2.3 Conséquence en production

Le quota public n'est pas de 300 req/min **par visiteur** mais de 300 req/min
**pour l'ensemble des visiteurs**, soit 5 requêtes par seconde pour tout le
site public.

---

## 3. Reproduction sous charge

Instance de production locale (`node dist/main`, `NODE_ENV=production`), API
Atlas de développement, montée progressive, adresses clientes distinctes.

| Scénario | Visiteurs | Durée | 2xx | 429 | 5xx | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
| Charge modérée | 30 | 30 s | 698 (100 %) | 0 | 0 | 87 ms | 294 ms | 731 ms |
| **Charge bêta** | **150** | **40 s** | **1 440 (37,5 %)** | **2 399 (62,5 %)** | **0** | 3 ms | 1 706 ms | 2 410 ms |

À 150 visiteurs simultanés — chacun avec sa propre adresse, chacun naviguant
au rythme d'un humain (une action toutes ~1,2 s) — **62,5 % des requêtes sont
refusées**. Le premier 429 tombe après 12,9 s.

Le p50 de 3 ms sur la ligne dégradée est trompeur : il mesure surtout le coût
d'un 429, qui court-circuite le traitement.

C'est F-019, sous sa forme réelle : **le catalogue se rend indisponible sous
une charge de bêta ordinaire**, sans qu'aucun abus ne soit en cause.

---

## 4. Cartographie des profils avant correction

| Profil | Valeur | Application |
|---|---|---|
| `PUBLIC_READ` | 300 / 60 s | tier global `default`, donc toutes les routes |
| `AUTH_STRICT` | 5 / 60 s | login, register, verify, resend, refresh |
| `FORGOT_PASSWORD` | 5 / 15 min | mot de passe oublié |
| `ACCESS_CODE` | 10 / 60 s | déclaré mais **non appliqué** — les routes d'accès utilisaient des littéraux |
| `INVITATION_ACCEPT` | 10 / 60 s | idem |
| — | 20 / 60 s | téléversements (littéral, hors config) |
| — | 5 / 60 s, 3 / 10 min | vérification de code, waitlist (littéraux) |

Deux écarts : des tiers déclarés mais contournés par des valeurs en dur dans
les contrôleurs, et aucune distinction entre lecture de catalogue et recherche
filtrée.

---

## 5. Coût des routes publiques

| Contrôle | Résultat |
|---|---|
| Pagination obligatoire | ✅ `page` + `limit` sur tous les listings |
| Borne supérieure de `limit` | ✅ `@Max(100)` — `limit=1000` rejeté en 400 |
| Amplification par pagination | ✅ impossible |
| Recherche regex | ✅ échappée via `escapeRegExp`, résultats bornés |
| Agrégations | ✅ `getPublicCategoryCounts` groupe puis trie, sur filtre indexé |
| Tri paginé déterministe | ✅ corrigé au Sprint 2.2 (F-037) |

Le throttling ne masquait aucun endpoint non borné. La limite observée sous
charge est une limite de **capacité**, pas de conception.

---

## 6. Ce que le baseline établit

1. Le seuil de 100 req/min n'existe plus ; la fiche du finding était périmée.
2. Le défaut réel est la **clé** de comptage, pas la valeur du seuil.
3. Il ne se manifeste qu'en présence d'un proxy — donc jamais en local, ce qui
   explique qu'il ait survécu à plusieurs audits.
4. Sous 150 visiteurs légitimes, la zone publique est indisponible à 62,5 %.
