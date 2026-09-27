# CI/CD

Deux workflows GitHub Actions nommés `CI` :
`Elintys-api/.github/workflows/ci.yml` et `Elintys-web/.github/workflows/ci.yml`.
Le **déploiement** n'est pas fait par GitHub Actions : Render et Vercel
déploient eux-mêmes à chaque commit sur la branche suivie
([`deployment.md`](./deployment.md)).

Les noms de jobs (`name:`) sont des **contrats** : ils servent de checks
requis dans la protection de branche. Ne jamais les renommer sans mettre à
jour la protection.

## API — `Elintys-api`

Déclencheurs : `pull_request` et `push` vers `dev`, `uat`, `master` ;
`workflow_dispatch`. Aucun filtre de chemins (chaque exécution lance tous
les jobs).

Concurrence : groupe `ci-<workflow>-<ref>` ; annulation des exécutions
obsolètes sauf sur `master` et `uat`.

Permissions : `contents: read`. Node : `.nvmrc` (22), cache npm.

| Job | Timeout | Contenu | Artefacts |
| --- | --- | --- | --- |
| `quality` | 15 min | `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `git diff --check` (PR) | — |
| `unit` | 20 min | `npm test` (Jest) | `unit-test-logs` si échec (7 j) |
| `e2e` | 20 min | `npm run test:e2e` contre un service `mongo:7`, base `elintys-test`, `ELINTYS_ENV=ci`, `NODE_ENV=test`, envoi courriel et paiements désactivés, secrets JWT **factices** | `e2e-test-logs` si échec (7 j) |
| `security` | 10 min | `npm audit --omit=dev --audit-level=high` ; gitleaks 8.30.1 (binaire vérifié par checksum) sur les commits de la PR / du push, historique complet en `workflow_dispatch` | — |
| `dependency-review` | 5 min | `actions/dependency-review-action`, échec si sévérité ≥ high — **PR uniquement** | — |

Actions épinglées par SHA de commit.

## Web — `Elintys-web`

Déclencheurs : `pull_request` et `push` vers `dev`, `uat`, `main` ;
`workflow_dispatch` ; `schedule` quotidien `0 7 * * *` (07:00 UTC).

Concurrence : groupe `ci-<workflow>-<ref>` ; annulation uniquement pour les
PR.

Variables globales (non secrètes) : `NEXT_PUBLIC_ELINTYS_ENV=ci`,
`NEXT_PUBLIC_DISABLE_DEVTOOLS=true`, `NEXT_PUBLIC_PAYPAL_ENV=sandbox`,
`NEXT_TELEMETRY_DISABLED=1`.

| Job | Timeout | Contenu | Artefacts |
| --- | --- | --- | --- |
| `quality` | 15 min | lint, typecheck, `git diff --check` (PR) | — |
| `unit` | 15 min | `npm test` (Vitest) | — |
| `build` | 15 min | `npm run build` avec URLs factices `.invalid` ; vérifie l'absence de source maps publiques | — |
| `e2e-smoke` | 20 min | build + `npm run test:e2e:smoke` (Chromium, API factice `e2e/smoke/stub-api.mjs`) | `playwright-smoke-<tentative>` si échec (14 j) |
| `e2e-full` | 75 min | API NestJS (checkout de `NoeKen/Elintys-api`) + `mongo:7` éphémère ; `npm run test:e2e:functional` puis la batterie smoke | `playwright-full-<tentative>` si échec (14 j) |
| `security` | 15 min | `npm audit --omit=dev --audit-level=high`, gitleaks (`gitleaks/gitleaks-action@v2`), dependency-review (PR) | — |

`e2e-full` ne s'exécute que sur `schedule`, `workflow_dispatch` ou une PR
vers `uat`/`main` ; sinon il est *skipped* (non bloquant). Branche API
utilisée : PR/ref `main` → `master`, `uat` → `uat`, sinon (et la nuit) `dev`.
La nuit, la branche web testée est `dev`. Le job fixe `ELINTYS_ENV=dev` et
`MONGODB_URI=mongodb://127.0.0.1:27017/elintys-dev` : c'est un **conteneur
jetable du runner** (nom exigé par le provisionneur QA actuel), jamais la
base Atlas `elintys-dev`.

## Secrets

Aucun secret de dépôt ni d'environnement n'est utilisé :

- API : valeurs JWT factices écrites en clair dans le workflow
  (`test-only-…`), base locale.
- Web `e2e-full` : `JWT_SECRET`, `JWT_REFRESH_SECRET`, `E2E_TEST_PASSWORD`
  générés aléatoirement à chaque exécution (`openssl rand`), masqués
  (`::add-mask::`), jamais persistés.
- Web `security` : `GITHUB_TOKEN` fourni automatiquement par Actions.

Les workflows ne référencent aucun environnement GitHub (`development`,
`uat`, `production`).

## Checks requis

| Dépôt | Checks requis |
| --- | --- |
| API (`master`, `uat`, `dev`) | `quality`, `unit`, `e2e`, `security`, `dependency-review` |
| Web (`main`, `uat`, `dev`) | `quality`, `unit`, `build`, `e2e-smoke`, `security` |

`e2e-full` sera ajouté aux checks requis de `uat` et `main` après une
première exécution manuelle verte. Le graphe de dépendances GitHub a été
activé après l'échec initial de `dependency-review`.

## Lancer `e2e-full` manuellement

Interface : dépôt `Elintys-web` → *Actions* → workflow **CI** →
*Run workflow* → choisir la branche (`dev`, `uat` ou `main`).

CLI :

```bash
gh workflow run CI --repo NoeKen/Elintys-web --ref uat
gh run list --repo NoeKen/Elintys-web --workflow CI --limit 5
gh run watch --repo NoeKen/Elintys-web
```

Avec `workflow_dispatch`, la branche API est déduite de la branche web
choisie (`main` → `master`, `uat` → `uat`, autre → `dev`).

## Reproduire en local

```bash
# API
npm ci && npm run lint && npm run typecheck && npm run build && npm test
# e2e (Supertest ; les specs actuelles n'ouvrent pas de connexion MongoDB,
# le service mongo:7 de la CI est une sécurité si une spec en ajoute une)
npm run test:e2e

# Web
npm ci && npm run lint && npm run typecheck && npm test && npm run build
NEXT_PUBLIC_API_URL=http://127.0.0.1:3999/api/v1 npm run build && npm run test:e2e:smoke
```


## Répétition de la séquence UAT (job `e2e`)

Le job `e2e` démarre un MongoDB **replica set à un nœud** local au runner (les migrations et l'API utilisent des
transactions), puis rejoue la séquence UAT documentée sur une base `elintys-uat` **vierge et jetable** :
Wave 4/5/6 et Wave J en `--apply` (sauvegarde préalable dans `$RUNNER_TEMP`), `seed:uat`, deux passes pour prouver
l'idempotence, puis un dry-run Wave J final. Aucune base distante n'est utilisée. Journal : artefact `e2e-test-logs`
(`uat-rehearsal.log`) en cas d'échec.
