# Environnements

Source de vérité pour les cinq environnements Elintys. Les règles de
validation citées sont celles du code : `src/config/env.validation.ts`,
`src/config/elintys-environment.ts` (API) et
`src/shared/config/environment.ts` (web).

> Aucune valeur secrète n'apparaît ici. Les secrets vivent uniquement dans
> Render (API) et, pour le poste local, dans un fichier `.env*` non versionné.

## Vue d'ensemble

| | LOCAL | CI | DEV | UAT | PROD |
| --- | --- | --- | --- | --- | --- |
| `ELINTYS_ENV` (API) / `NEXT_PUBLIC_ELINTYS_ENV` (web) | `local` (défaut si absent et `NODE_ENV` ∈ development/test) | `ci` | `dev` | `uat` | `prod` |
| Branche API / web | quelconque | PR et push `dev`/`uat`/`master` · `dev`/`uat`/`main` | `dev` / `dev` | `uat` / `uat` | `master` / `main` |
| URL web | `http://localhost:3000` | dans le runner | `https://dev.elintys.com` | `https://uat.elintys.com` | `https://app.elintys.com` |
| URL API | `http://localhost:3001/api/v1` | dans le runner | `https://elintys-api-dev-1pdh.onrender.com/api/v1` | `https://elintys-api-uat.onrender.com/api/v1` | `https://api.elintys.com/api/v1` (Render `https://elintys-api-s9fo.onrender.com`) |
| Service API | poste | job GitHub Actions | Render `elintys-api-dev` (ohio) | Render `elintys-api-uat` (ohio) | Render `Elintys-api` (oregon) |
| Base MongoDB | MongoDB local, ou `elintys-dev` distante (avertissement) | conteneur `mongo:7`, base `elintys-test` — **jamais Atlas** | `elintys-dev` (exigé) | `elintys-uat` (exigé, à créer) | nom explicite sans `dev`/`uat`/`test`/`local` — **à confirmer** |
| Paiement | désactivé ou sandbox ; fournisseur de test possible | désactivé | sandbox ; fournisseur de test possible | **PayPal sandbox uniquement** (`PAYPAL_ENV=sandbox` exigé) ; actuellement fermé | PayPal `live` (exigé si PayPal activé) |
| Courriel | désactivé ou Resend | désactivé (`EMAIL_DELIVERY_ENABLED=false`) | Resend (`elintys.com`) | Resend (`elintys.com`) | Resend (`elintys.com`) |
| Médias Cloudinary | `Elintys/dev` | `Elintys/ci` | `Elintys/dev` | `Elintys/uat` | `Elintys/prod` (défaut) |
| Déclenchement du déploiement | manuel (`npm run start:dev`, `npm run dev`) | automatique (workflow `CI`) | merge sur `dev` (Render `autoDeployTrigger: commit`, Vercel Git) | merge sur `uat` (idem) | merge sur `master`/`main` |
| Qui peut déployer | le développeur | GitHub Actions | tout PR mergée vers `dev` (CI verte) | PR de promotion `dev → uat` mergée par le mainteneur | PR `uat → master/main` mergée par le mainteneur (NoeKen) |
| Type de données | fictives | éphémères, détruites en fin de job | fictives de démonstration (`seed:dev`, `qa:provision`) | fictives (`seed:uat`) + comptes créés par les testeurs | **réelles** (données personnelles) |
| Swagger | actif | actif | `ENABLE_SWAGGER=true` | désactivé | désactivé |
| Indexation web | — | — | `noindex` | `noindex` + badge « UAT » | indexé, Vercel Analytics |

### Règles de validation par environnement (API)

| Règle | local | ci | dev | uat | prod |
| --- | --- | --- | --- | --- | --- |
| `MONGODB_URI` requis | oui | oui | oui | oui | oui |
| Nom de base imposé | local ou `elintys-dev` | local, `elintys-test` conseillé | `elintys-dev` | `elintys-uat` | sans `dev\|uat\|test\|local` |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | non contrôlés par la validation (mais lus par `getOrThrow` au démarrage) | idem | requis | requis, ≥ 32 car., distincts | requis, ≥ 32 car., distincts |
| `NODE_ENV=production` | — | — | — | exigé | exigé |
| `FRONTEND_URL` https publique | — | — | avertissement | exigé | exigé |
| `CORS_ORIGINS` https, sans `*` | — | — | avertissement | exigé | exigé |
| `RESEND_API_KEY` + `EMAIL_FROM` (si envoi actif) | — | — | avertissement | exigé | exigé |
| `PAYPAL_ENV=live` | refusé | refusé | refusé | refusé (`sandbox` exigé) | exigé si `PAYPAL_PROVIDER_ENABLED=true` |
| `TEST_PAYMENT_PROVIDER_ENABLED=true` | permis (hors `NODE_ENV=production`) | permis | permis hors `NODE_ENV=production` (donc pas sur Render) | refusé | refusé |
| `CLOUDINARY_FOLDER` | libre | libre | `dev` conseillé | `uat` ou absent | sans `dev\|uat\|test\|local\|ci` |
| `COOKIE_DOMAIN` | doit être absent | idem | idem | idem | idem |

Toute valeur commençant par `__SET_ME__` est traitée comme absente. Les
messages d'erreur ne citent que des **noms** de variables, jamais de valeurs.

## Matrice des variables — API (`Elintys-api`)

Légende source : **R** = Render (dashboard ou `render.yaml`), **Y** =
`render.yaml` en clair (non sensible), **CI** = `.github/workflows/ci.yml`
(valeur factice), **L** = fichier local non versionné (`.env`,
`.env.uat.local`…), **D** = défaut du code.

| Variable | Sensible | local | ci | dev | uat | prod |
| --- | --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | non | L (`development`) | CI `test` | Y `production` | Y `production` | R `production` |
| `ELINTYS_ENV` | non | L / D `local` | CI `ci` | Y `dev` | Y `uat` | R `prod` (**à poser**) |
| `PORT` | non | D `3001` | D | Render | Render | Render |
| `API_HOST` | non | D `0.0.0.0` | D | Y | Y | R |
| `TRUSTED_PROXY_HOPS` | non | D `0` | D | D `1` | Y `1` | D `1` |
| `ENABLE_SWAGGER` | non | L | — | Y `true` | Y `false` | absent |
| `MONGODB_URI` | **oui** | L | CI (conteneur) | R | R (`__SET_ME__` actuellement) | R |
| `JWT_SECRET` | **oui** | L | CI (factice) | R | R | R |
| `JWT_REFRESH_SECRET` | **oui** | L | CI (factice) | R | R | R |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | non | D `15m` / `7d` | D | Y | Y | D ou R |
| `FRONTEND_URL` | non | D `http://localhost:3000` | — | Y `https://dev.elintys.com` | Y `https://uat.elintys.com` | R `https://app.elintys.com` |
| `CORS_ORIGINS` | non | L | — | R | Y `https://uat.elintys.com` | R |
| `COOKIE_DOMAIN` | non | **absent** | absent | absent | absent | absent |
| `EMAIL_DELIVERY_ENABLED` | non | L | CI `false` | D `true` | Y `true` | D `true` |
| `RESEND_API_KEY` | **oui** | L | — | R | R (`__SET_ME__` actuellement) | R |
| `EMAIL_FROM` | non | L / D | — | R | R | R |
| `CLOUDINARY_CLOUD_NAME` | non | L | — | R | R | R |
| `CLOUDINARY_API_KEY` | **oui** | L | — | R | R | R |
| `CLOUDINARY_API_SECRET` | **oui** | L | — | R | R | R |
| `CLOUDINARY_FOLDER` | non | L / D | D | D (`dev`) | Y `uat` | D (`prod`) |
| `PAID_CHECKOUT_ENABLED` | non | L | CI `false` | R | Y `false` (temporaire) | R |
| `PAID_TICKET_HOLD_MINUTES` | non | D `15` | D | D | D | D |
| `TEST_PAYMENT_PROVIDER_ENABLED` | non | L | CI `false` | R (`false` sur Render) | Y `false` | absent/`false` |
| `PAYPAL_PROVIDER_ENABLED` | non | L | CI `false` | R | Y `false` (temporaire) | R |
| `PAYPAL_ENV` | non | D `sandbox` | D | R `sandbox` | Y `sandbox` | R `live` |
| `PAYPAL_CLIENT_ID` | **oui** | L | — | R | R (sandbox) | R (live) |
| `PAYPAL_CLIENT_SECRET` | **oui** | L | — | R | R (sandbox) | R (live) |
| `PAYPAL_WEBHOOK_ID` | **oui** | L | — | R | R (sandbox) | R (live) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | **oui** | L | — | R (déclarées) | non déclarées | à décider |
| `ANTHROPIC_API_KEY` | **oui** | L | — | — | — | — |
| `UAT_SEED_PASSWORD` | **oui** | `.env.uat.local` du mainteneur (scripts `seed:uat` / `reset:uat` uniquement) | — | — | — | — |
| `ELINTYS_ALLOW_PRODUCTION_MIGRATION` | non (verrou) | uniquement le temps d'une migration prod autorisée | — | — | — | — |

## Matrice des variables — Web (`Elintys-web`)

Toutes les variables web sont **publiques** (préfixe `NEXT_PUBLIC_`, figées
au build). Aucun secret ne doit porter ce préfixe. Source : Vercel (variables
d'environnement du projet `elintys-web`, restreintes par branche), `.env.local`
en local, `ci.yml` en CI. Détail : `Elintys-web/docs/deployment-environments.md`.

| Variable | local | ci | dev (branche `dev`) | uat (branche `uat`) | prod (`main`) |
| --- | --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_ELINTYS_ENV` | `local` (défaut) | `ci` | `dev` | `uat` | `prod` |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001/api/v1` | factice / API stub | `https://elintys-api-dev-1pdh.onrender.com/api/v1` | `https://elintys-api-uat.onrender.com/api/v1` | `https://api.elintys.com/api/v1` |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | factice | `https://dev.elintys.com` | `https://uat.elintys.com` | `https://app.elintys.com` |
| `NEXT_PUBLIC_PAYPAL_ENV` | `sandbox` | `sandbox` | `sandbox` | `sandbox` | `live` (quand l'API l'est) |
| `NEXT_PUBLIC_DISABLE_DEVTOOLS` | `false` | `true` | `true` | `true` | `true` |

Les variables Vercel de la branche `uat` et le domaine `uat.elintys.com`
dans Vercel sont des **actions manuelles** (voir
[`deployment.md`](./deployment.md)).

## DNS (Hostinger, `elintys.com`)

| Enregistrement | Cible actuelle | Attendu |
| --- | --- | --- |
| `app` | Vercel (web prod) | idem |
| `dev` | Vercel | idem |
| `uat` | Vercel (ajouté le 2026-09-26) | idem |
| `api` | Render prod `Elintys-api` | idem |
| `api.dev` | **Render prod** | ⚠ anomalie : doit pointer vers `elintys-api-dev` |
| `@` (racine) | ALIAS Railway + un enregistrement A | ⚠ anomalie héritée à nettoyer |

`elintys.ca` est réservé, non utilisé.

## Anomalies connues

1. **Cookies cross-site dev/uat.** Les cookies d'authentification sont
   `SameSite=Lax` et host-only. Depuis `https://uat.elintys.com`, un appel
   `fetch` vers `https://elintys-api-uat.onrender.com` est *cross-site*
   (`onrender.com` est un suffixe public) : le navigateur n'y joint pas les
   cookies `Lax`, la session ne se maintient donc pas. La conception d'origine
   (`docs/auth-cookies-and-observability.md`) suppose une API sur un
   sous-domaine d'`elintys.com`. Correction recommandée, **à valider** :
   domaine personnalisé Render `api.uat.elintys.com` → `elintys-api-uat`
   (et `api.dev.elintys.com` → `elintys-api-dev`), puis
   `NEXT_PUBLIC_API_URL` de la branche correspondante mis à jour. Aucun
   changement de code n'est nécessaire.
2. `api.dev.elintys.com` pointe vers la production (voir DNS).
3. Production Render en retard sur `dev` et configuration non alignée (voir
   [`deployment.md`](./deployment.md#préalables-production)).
4. Base `elintys-uat` non créée ; `MONGODB_URI` et `RESEND_API_KEY` UAT
   encore `__SET_ME__` : l'API UAT refuse de démarrer tant qu'ils ne sont pas
   posés (comportement voulu).
