# Stabilisation plateforme — UAT, CI/CD & baseline — rapport final

*Date : 2026-09-26 · Portée : Elintys-api, Elintys-web (Elintys-LP : hygiène des secrets uniquement)*
*PR : NoeKen/Elintys-api#63 · NoeKen/Elintys-web#112 (vers `dev`, non mergées — décision du mainteneur)*

## Verdict

**ELINTYS PLATFORM BASELINE — PARTIALLY READY — MANUAL INFRA ACTIONS REQUIRED**
— base MongoDB `elintys-uat` à créer (accès MCP Atlas désactivé), domaine Render `api.uat.elintys.com`,
domaine + variables Vercel pour `uat`, puis merge des PR, promotion `dev → uat`, migration + seed UAT et smoke réel.

Le code, la CI, les branches, les protections, les environnements GitHub, le service Render UAT et le DNS web UAT
sont en place. Aucune action n'a touché la production.

---

## 1. Résumé exécutif

| Domaine | État |
|---|---|
| Wave J intégrée dans `dev` | Oui (API #62 `760e917`, Web #111 `c309581`, déjà mergées avant la mission) |
| CI GitHub Actions | Active dans les deux dépôts, verte sur les PR #63 / #112 |
| Branches `main`/`master`, `dev`, `uat` | Créées/protégées (PR obligatoire, checks CI requis, force-push et suppression interdits) |
| Environnements GitHub | `development`, `uat`, `production` (approbation manuelle) |
| Vérification courriel (lecture seule si non vérifié) | Implémentée côté serveur (autorité) + UX web |
| Validation d'environnement au démarrage | Fail-fast en `uat`/`prod` |
| Migrations / seed / reset UAT | Gardes par environnement, dry-run par défaut, sauvegarde obligatoire |
| Service API UAT (Render) | Créé — en attente de `MONGODB_URI` et `RESEND_API_KEY` |
| DNS `uat.elintys.com` | Créé (CNAME Vercel) |
| Base `elintys-uat` | **Non créée** (action manuelle) |
| Smoke UAT réel | **Non exécuté** (dépend des actions manuelles) |
| P0 ouverts | 0 |
| P1 ouverts | 0 dans le code ; 1 bloquant d'infra (cookies cross-site → domaine `api.uat`) |

## 2. Inventaire des dépôts

| Dépôt | Branche prod | Intégration | Promotion | Hébergement |
|---|---|---|---|---|
| NoeKen/Elintys-api | `master` | `dev` | `uat` | Render |
| NoeKen/Elintys-web | `main` | `dev` | `uat` | Vercel (`elintys-web`) |
| NoeKen/Elintys-LP | `main` | — | — | Vercel (`elintys-lp`) |

Les trois dépôts sont publics depuis le 2026-09-26.

## 3. Wave J — preuve de merge

- API PR #62 → `dev` : MERGED, merge commit `760e917` (déployé sur `elintys-api-dev` le 2026-09-20).
- Web PR #111 → `dev` : MERGED, merge commit `c309581` (checks Vercel verts).
- Revalidation locale post-merge (branche de stabilisation, qui contient Wave J) : voir §33.

## 4. Commits de base

| Dépôt | Base `dev` | Tête de la branche de stabilisation |
|---|---|---|
| API | `760e917` | `chore/platform-stabilization-uat-ci` (PR #63) |
| Web | `c309581` | `chore/platform-stabilization-uat-ci` (PR #112) |

`uat` a été créée depuis `760e917` (API) et `c309581` (Web).

## 5. Modèle de branches

`feature/*` · `fix/*` → PR `dev` → CI → PR `dev → uat` (promotion) → déploiement UAT → recette →
PR `uat → master|main` → production. `hotfix/*` exceptionnel vers la branche de prod, puis rétro-merge.
Aucun développement direct sur `uat`. Pas de `release/*` (inutile à ce stade). Voir `docs/operations/deployment.md`.

## 6. Protection des branches (appliquée via l'API GitHub)

| Branche | PR requise | Approbations | Checks requis | Admins inclus | Force-push / suppression |
|---|---|---|---|---|---|
| API `master` | oui | 0 | quality, unit, e2e, security, dependency-review | oui | interdits |
| API `dev`, `uat` | oui | 0 | idem | non | interdits |
| Web `main` | oui | 0 | quality, unit, build, e2e-smoke, security | oui | interdits |
| Web `dev`, `uat` | oui | 0 | idem | non | interdits |

0 approbation : mainteneur unique (GitHub interdit d'approuver sa propre PR). Les checks sont liés à l'app
GitHub Actions (anti-usurpation). `e2e-full` (web) à ajouter aux checks de `uat`/`main` après une exécution verte.

## 7. Environnements GitHub

| Dépôt | Environnement | Branche autorisée | Règle |
|---|---|---|---|
| API / Web | `development` | `dev` | — |
| API / Web | `uat` | `uat` | — |
| API | `production` | `master` | revue requise (NoeKen) |
| Web | `Production` (fusionné avec l'environnement Vercel existant, insensible à la casse) | `main` | revue requise |

Aucun workflow ne référence encore ces environnements : ils ne bloquent pas les déploiements Render/Vercel
(déclenchés par leurs intégrations Git). La vraie barrière est la PR protégée. Aucun secret de dépôt n'est utilisé.

## 8. Architecture des environnements

Voir `docs/operations/environments.md` (matrice complète). Résumé :

| | LOCAL | CI | DEV | UAT | PROD |
|---|---|---|---|---|---|
| `ELINTYS_ENV` | local | ci | dev | uat | prod |
| Branche | toute | PR | `dev` | `uat` | `master`/`main` |
| Web | localhost:3000 | runner | dev.elintys.com | uat.elintys.com | app.elintys.com |
| API | localhost:3001 | runner | elintys-api-dev (Render) | elintys-api-uat (Render) | Elintys-api (Render) / api.elintys.com |
| Base | elintys-dev ou locale | elintys-test (conteneur) | elintys-dev | elintys-uat | prod (nom à confirmer) |
| PayPal | sandbox/off | off | sandbox | sandbox uniquement | live |
| Courriel | off/Resend | off | Resend | Resend (« Elintys UAT ») | Resend |

## 9. Configuration DEV

Render `elintys-api-dev` (branche `dev`, ohio, health `/api/v1/health` = 200). Avec le nouveau code, dev exige
une base nommée exactement `elintys-dev` et les deux secrets JWT (le reste = avertissements) — vérifié compatible
avec la configuration actuelle par la revue indépendante.

## 10. Configuration CI

Voir §23–§25 et `docs/operations/ci-cd.md`.

## 11. Configuration UAT

- Render `elintys-api-uat` : https://elintys-api-uat.onrender.com — branche `uat`, ohio, plan free,
  build `npm ci --include=dev && npm run build && npm prune --omit=dev`, start `npm run start:prod`, auto-deploy.
- Variables posées : `NODE_ENV=production`, `ELINTYS_ENV=uat`, `API_HOST`, `ENABLE_SWAGGER=false`, JWT (secrets
  générés aléatoirement, modifiables), `FRONTEND_URL`/`CORS_ORIGINS=https://uat.elintys.com`, `TRUSTED_PROXY_HOPS=1`,
  `PAYPAL_ENV=sandbox`, `PAYPAL_PROVIDER_ENABLED=false`, `PAID_CHECKOUT_ENABLED=false`,
  `TEST_PAYMENT_PROVIDER_ENABLED=false`, `EMAIL_DELIVERY_ENABLED=true`, `EMAIL_FROM="Elintys UAT <no-reply@elintys.com>"`,
  `CLOUDINARY_FOLDER=uat`. **`MONGODB_URI` et `RESEND_API_KEY` = `__SET_ME__`** (refusés explicitement au démarrage).
- Premier déploiement : `update_failed` (attendu : placeholders + ancien code sur `uat`).
- Web : DNS `uat.elintys.com` → Vercel créé ; domaine et variables Vercel = action manuelle.

## 12. Isolation de la production — preuve

- Aucune écriture, aucun déploiement, aucune variable modifiée sur `Elintys-api` (prod Render), Vercel Production
  ou une base de prod. Dernier déploiement prod inchangé : `3ed7f5b` (2026-08-01).
- UAT API → base : le validateur impose `elintys-uat` exact en `uat` (sinon refus de démarrer).
- UAT → PayPal : `PAYPAL_ENV=sandbox` imposé en `uat`, `live` refusé hors `prod`.
- UAT → courriel : expéditeur « Elintys UAT », domaine Resend `elintys.com` (vérifié).
- Cookies : host-only (`COOKIE_DOMAIN` interdit) → pas de partage dev/uat/prod.
- Preuve bout-en-bout Web UAT → API UAT → Mongo UAT : **à produire** au smoke réel (§32).

## 13. Séparation des bases MongoDB

`elintys-dev` (existante) · `elintys-uat` (à créer, même cluster, utilisateur dédié `readWrite@elintys-uat`
recommandé) · prod (séparée, nom à confirmer, ne doit contenir ni dev/uat/test/local) · `elintys-test`
(conteneur CI éphémère, jamais Atlas). L'accès MCP Atlas est désactivé au niveau des organisations : aucune base
n'a été créée depuis cette session.

## 14. Stratégie de migration UAT

Contrat unique (`src/scripts/lib/*`, `docs/operations/database-migrations.md`) : `--environment` obligatoire et
égal à `ELINTYS_ENV` ; dry-run par défaut ; `--apply` exige `--backup-path` ; cible affichée (hôte sans identifiants
+ base) puis revérifiée après connexion ; sauvegarde EJSON + manifeste SHA-256 ; post-validation (comptes, index,
orphelins) ; rapport `migration-report.json`. Prod bloquée sauf confirmations explicites multiples (jamais exécutée).

Séquence UAT (base neuve) : Wave 4/5/6 index → `npm run migrate:uat:wave-j` → `npm run seed:uat`.

## 15. Exécution de la migration UAT

**Non exécutée** — la base `elintys-uat` n'existe pas encore (§37).

## 16. Services externes

| Service | UAT | Statut |
|---|---|---|
| MongoDB Atlas | `elintys-uat` | à créer |
| Render | `elintys-api-uat` | créé |
| Vercel | branche `uat`, `uat.elintys.com` | DNS créé ; domaine/variables manuels |
| PayPal | Sandbox | désactivé tant que les identifiants sandbox ne sont pas copiés |
| Resend | `elintys.com` vérifié | clé à copier dans Render UAT |
| Cloudinary | mêmes identifiants, dossier `Elintys/uat` | identifiants à copier (optionnel au démarrage) |
| Analytics | désactivé hors `prod` (web) | fait |
| Webhooks PayPal | URL UAT distincte | à créer côté PayPal |

## 17. Stratégie des secrets

Aucun secret dans Git (gitleaks en CI, `.gitignore` couvre `.env.*` sauf `.env.example`). Secrets UAT uniquement
dans Render (`sync: false` dans `render.yaml`). CI : secrets factices ou générés/masqués par exécution. Aucun
secret de prod copié vers UAT.

**Alerte ouverte** : `Elintys-LP` versionne un `.env` contenant une clé Google (alerte secret-scanning #1),
maintenant publique → à révoquer puis retirer du dépôt (§37).

## 18. CORS / cookies / auth

Cookies `httpOnly`, `SameSite=Lax`, host-only, `secure` forcé en `uat`/`prod`. CORS : origines exactes https en
`uat`/`prod`, regex réseau local désactivée dès que l'environnement est de type production.
**Point bloquant d'infra** : `uat.elintys.com` → `elintys-api-uat.onrender.com` est *cross-site*
(`onrender.com` est un suffixe public) : les cookies ne seraient pas envoyés et la session ne tiendrait pas.
→ Domaine personnalisé Render `api.uat.elintys.com` + `NEXT_PUBLIC_API_URL=https://api.uat.elintys.com/api/v1`.
Même constat pour dev (`api.dev.elintys.com` pointe aujourd'hui vers la **prod**).

## 19. Durcissement de la vérification courriel

- `EmailVerifiedGuard` appelé par `JwtAuthGuard` après Passport ; statut relu en base à chaque requête
  (jamais depuis le JWT) ; fail-closed (`=== true` seulement) ; méthodes non sûres → `403 EMAIL_NOT_VERIFIED`.
- Exceptions (`@AllowUnverifiedEmail()`, 14 handlers) : cycle d'auth, renvoi de vérification, changement de mot de
  passe, préférences de notification (retrait de consentement), onboarding, accusés de lecture des notifications.
- Correctif sécurité : les achats invités étaient rattachés dès l'inscription (prise de contrôle possible avec
  l'adresse d'autrui) → rattachement après vérification, tolérant aux pannes et rejoué à chaque connexion vérifiée.
- Web : signal unique dans `src/shared/lib/api.ts`, bannière (courriel, renvoi avec délai de 60 s, 429 géré,
  « J'ai confirmé », déconnexion) et dialogue global.
- Matrice complète : `docs/security/email-verification.md`. Tests : 55 tests HTTP sur 4 rôles.
- Impact de déploiement : les comptes existants jamais vérifiés passent en lecture seule (voulu) ; ils peuvent
  renvoyer le courriel eux-mêmes.

## 20. Stratégie de seed UAT

`npm run seed:uat -- --env-file=.env.uat.local` : `ELINTYS_ENV=uat` + base `elintys-uat` obligatoires,
`UAT_SEED_PASSWORD` (≥ 12 caractères, jamais affiché), upserts idempotents via les modèles Mongoose, comptes
fictifs `@uat.elintys.test` : participant A/B (+ un non vérifié), organisateur A/B, prestataire A/B, gestionnaire
de salle A/B ; événements public/non listé/privé/brouillon/terminé/annulé ; lieux, profils, billets, invités,
invitations, demandes, réservations, avis V2.

## 21. Stratégie de reset UAT

`npm run reset:uat -- --env-file=.env.uat.local --confirm=elintys-uat --backup-path=<dir> [--reseed]` :
refus hors `uat`/`elintys-uat`, sauvegarde préalable (sauf `--skip-backup` explicite), `deleteMany` par
collection (index conservés, base jamais supprimée).

## 22. Health checks

`GET /api/v1/health` → `{status, service, environment}` (aucune donnée sensible). Dev = 200. Prod = 404 (code
ancien). UAT : chemin de health check à renseigner dans le tableau de bord Render (non réglable via l'outil).

## 23. CI API

`.github/workflows/ci.yml` — `quality` (npm ci, lint, typecheck, build, `git diff --check`), `unit`, `e2e`
(conteneur `mongo:7`, `elintys-test`, + smoke de démarrage `dist/main` → `/api/v1/health`), `security`
(`npm audit --omit=dev --audit-level=high`, gitleaks binaire vérifié par checksum), `dependency-review` (PR).
Actions épinglées par SHA, `contents: read`, timeouts, concurrence (annulation sauf `master`/`uat`), artefacts
de logs en échec, pas de filtre de chemins.

## 24. CI Web

`quality`, `unit`, `build` (+ vérification d'absence de source maps publiques), `e2e-smoke` (build de prod +
API factice, 17 tests, ~20 s), `e2e-full` (suite fonctionnelle avec checkout de l'API et `mongo:7`, puis smoke),
`security` (npm audit, gitleaks, dependency-review). Actions épinglées par SHA, `persist-credentials: false`.

## 25. Stratégie E2E

PR vers `dev` : `e2e-smoke` (bloquant). PR vers `uat`/`main`, nuit (07:00 UTC) et à la demande : `e2e-full`
(~25 min, 307 tests + 2 skips historiques `WIZARD_QA_CAPTURE`). Aucun test désactivé ni supprimé.
Première exécution manuelle de `e2e-full` : échec de configuration (comptes QA non transmis, `.next` de
`next dev` réutilisé, faux positifs gitleaks sur des SHA d'audit) → corrigé. La seconde exécution a révélé deux
tests sensibles au timing (focus clavier des onglets, mesure de débordement avant stabilisation) → assertions
rendues asynchrones sans relâcher les seuils (smoke 51/51 sur 3 répétitions). Le smoke de démarrage de l'API a
révélé que `EmailsService` exige `RESEND_API_KEY` même courriel désactivé → clé factice en CI (à corriger P3).
Le smoke a aussi révélé un **vrai bug d'interface** : à 768 px, l'en-tête public débordait de 21 px (« S'inscrire
gratuitement » coupé) avec les polices Linux → menu burger jusqu'à 1024 px (`PublicNavbar.tsx`).

État de `e2e-full` en CI (exécution manuelle du 2026-09-26, 5ᵉ itération) : **257 réussis, 7 échecs, 43 non
exécutés (séries interrompues), 2 skips historiques**. Corrections d'infrastructure apportées : comptes QA transmis,
jeu de démonstration `seed:dev` dans le conteneur jetable, MongoDB en **replica set** (l'API utilise des
transactions), build propre avant le smoke. Échecs restants : 6 specs médias (Cloudinary non configuré en CI →
503 `MEDIA_STORAGE_NOT_CONFIGURED`, secrets de dépôt optionnels prévus, dossier `Elintys/ci`) et 1 ressource 404
dans la console de la page Paramètres (à analyser). `e2e-full` reste **non bloquant** tant qu'il n'est pas vert.

## 26. Déploiement Web UAT

Vercel `elintys-web`, branche `uat` → `uat.elintys.com` (DNS fait). Variables à poser pour la branche `uat` :
`NEXT_PUBLIC_ELINTYS_ENV=uat`, `NEXT_PUBLIC_API_URL=https://api.uat.elintys.com/api/v1`,
`NEXT_PUBLIC_SITE_URL=https://uat.elintys.com`, `NEXT_PUBLIC_PAYPAL_ENV=sandbox`, `NEXT_PUBLIC_DISABLE_DEVTOOLS=true`.

## 27. Déploiement API UAT

Auto-deploy Render sur push `uat` (promotion par PR). Aucun déploiement de prod possible depuis `uat`.

## 28. Checks GitHub requis

API : `quality`, `unit`, `e2e`, `security`, `dependency-review`. Web : `quality`, `unit`, `build`, `e2e-smoke`,
`security` (+ `e2e-full` sur `uat`/`main` après une exécution verte).

## 29. Documentation créée

API : `AGENTS.md`, `CLAUDE.md` (section « Plateforme — état réel »), `.env.example` (variables ajoutées),
`docs/architecture/architecture-current.md` (AS-IS), `docs/architecture/architecture-target.md` (cible, non
implémentée), `docs/operations/{environments,database-migrations,deployment,ci-cd,bug-workflow}.md`,
`docs/uat/README.md`, `docs/security/email-verification.md`, ce rapport.
Web : `CLAUDE.md` (section plateforme), `docs/deployment-environments.md`, `TESTING.md`.

## 30. Revue de sécurité

Revue indépendante : 0 P0. CORS strict, cookies host-only, aucun log de secret/jeton/mot de passe, aucune source
map publique, `noindex` sur dev/uat, Analytics en prod seulement, erreurs de validation sans valeurs.

## 31. npm audit

`npm audit --omit=dev` : 0 vulnérabilité (API et Web).

## 32. Smoke UAT

**Non exécuté** — dépend des actions manuelles §37. Procédure : `docs/operations/deployment.md` et
`docs/uat/README.md` (compte neuf non vérifié → lecture OK / mutation 403 → vérification → brouillon →
publication → lecture publique → prestataire, lieu, avis, notification ; contrôle qu'aucune donnée n'apparaît
en prod).

## 33. Régression complète (branches finales)

| Contrôle | API | Web |
|---|---|---|
| lint / typecheck / build | vert | vert |
| unitaires | 90 suites / 1562 tests | 81 fichiers / 496 tests |
| E2E | 11 suites / 208 tests + smoke de démarrage | smoke 17/17 ; `e2e-full` 257 ✓ / 7 ✗ (§25) |
| npm audit (prod) | 0 | 0 |
| gitleaks | aucune fuite | aucune fuite (2 SHA d'audit ignorés via `.gitleaksignore`) |
| `git diff --check` | propre | propre |
| CI sur PR | verte | verte |

## 34. Revue indépendante

Agent distinct, lecture seule. Constats et suite donnée :

| # | Sévérité | Constat | Suite |
|---|---|---|---|
| 1 | P1 | `e2e-full` sans `E2E_TEST_EMAIL(_SECONDARY)` | corrigé |
| 2 | P1 | La prod refusera de démarrer au prochain déploiement si ses variables ne sont pas conformes | documenté (prérequis de promotion, `deployment.md`) |
| 3 | P2 | Rattachement des achats invités non tolérant aux pannes | corrigé + rejoué à la connexion |
| 4 | P2 | Comptes existants non vérifiés → lecture seule | accepté, documenté |
| 5 | P2 | Actions Web non épinglées, identifiants de checkout persistés | corrigé |
| 6 | P2 | Variables Vercel par branche nécessaires | action manuelle |
| 7 | P3 | Conteneur mongo inutilisé par l'e2e API | smoke de démarrage ajouté |
| 8 | P3 | Provisionneur QA encore en contrat `dev` (utilisé sur conteneur jetable) | reporté |
| 9 | P3 | Seed UAT réinitialise les mots de passe à chaque exécution ; invitations non acceptables (jeton brut non exposé) | reporté |
| 10 | P3 | `ENABLE_SWAGGER=true` non bloqué en uat/prod | reporté |

## 35. P0 / P1 / P2 / P3 ouverts

- P0 : aucun.
- P1 (infra) : domaine `api.uat.elintys.com` requis pour que la session fonctionne en UAT (§18).
- P1 (prod, hors mission) : variables prod à mettre en conformité avant la prochaine promotion `uat → master`.
- P2 : `api.dev.elintys.com` pointe vers la prod ; enregistrement racine `elintys.com` (ALIAS Railway + A) incohérent.
- P3 : §34 n° 8–10 ; ressource 404 sur la page Paramètres (`e2e-full`) ; `EmailsService` exige `RESEND_API_KEY` même courriel désactivé ; pas de route de suppression de compte (droit Loi 25) ; outil de restauration non scripté ;
  Stripe encore câblé (activer PayPal et le paiement ensemble).

## 36. Risques restants

- Plan Render free : mise en veille (~50 s de démarrage à froid) en UAT.
- Prod API : 81 commits de retard, build `npm install`, pas de health check — à réaligner lors d'une mission dédiée.
- La restauration de sauvegarde est manuelle et non répétée.
- `e2e-full` sur PR vers `main` teste contre `master` (en retard) tant que la prod n'est pas réalignée.

## 37. MANUAL ACTION REQUIRED

| # | Service | Action | Valeur attendue | Raison | Validation |
|---|---|---|---|---|---|
| 1 | Google Cloud / Firebase | Révoquer/régénérer la clé exposée dans `Elintys-LP/.env`, la restreindre par domaine ; puis retirer `.env` du dépôt | clé révoquée | dépôt public | alerte GitHub fermée |
| 2 | MongoDB Atlas | Créer l'utilisateur `elintys-uat` (`readWrite@elintys-uat`) — ou activer l'accès MCP de l'organisation | URI `…/elintys-uat` | isolation UAT | `list-databases` |
| 3 | Render `elintys-api-uat` | Renseigner `MONGODB_URI` (UAT) et `RESEND_API_KEY` ; health check path `/api/v1/health` ; domaine perso `api.uat.elintys.com` | voir §11 | démarrage + cookies same-site | `/api/v1/health` → `environment: "uat"` |
| 4 | Hostinger DNS | CNAME `api.uat` → `elintys-api-uat.onrender.com.` ; corriger `api.dev` → `elintys-api-dev-1pdh.onrender.com.` | CNAME | refusé à l'agent par la politique de sécurité | `dig` |
| 5 | Render `elintys-api-dev` | Domaine perso `api.dev.elintys.com` | — | cookies same-site en dev | health 200 |
| 6 | Vercel `elintys-web` | Domaine `uat.elintys.com` → branche `uat` ; variables §26 ; `NEXT_PUBLIC_ELINTYS_ENV=dev` + `NEXT_PUBLIC_SITE_URL` (dev), `prod` (Production) | §26 | environnement UAT web | badge UAT visible |
| 7 | PayPal Developer | Copier Client ID/Secret sandbox vers Render UAT, créer un webhook sandbox vers l'API UAT, renseigner `PAYPAL_WEBHOOK_ID`, puis `PAYPAL_PROVIDER_ENABLED=true` **et** `PAID_CHECKOUT_ENABLED=true` | sandbox | paiements UAT | achat sandbox |
| 8 | Cloudinary | Copier les identifiants dans Render UAT (dossier `uat` déjà configuré) | — | médias UAT | upload vers `Elintys/uat` |
| 9 | GitHub | Merger #63 et #112 vers `dev`, puis PR de promotion `dev → uat` | — | déploiement UAT | CI verte, Render/Vercel UAT déployés |
| 10 | Opérateur | `migrate:uat:wave-j` (dry-run puis `--apply`), `seed:uat` avec `UAT_SEED_PASSWORD` | — | données UAT | rapport de migration |
| 11 | GitHub (Elintys-web) | Secrets de dépôt `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (dossier `Elintys/ci` isolé) | — | specs médias de `e2e-full` | `e2e-full` vert |
| 12 | GitHub | Ajouter `e2e-full` aux checks requis de `uat`/`main` après une exécution verte | — | gate de promotion | — |

## 38. URLs UAT

- Web : https://uat.elintys.com (après action 6)
- API : https://api.uat.elintys.com/api/v1 (après actions 3–4) — direct : https://elintys-api-uat.onrender.com
- Santé : `/api/v1/health`

## 39. Identifiants des testeurs

Comptes fictifs `@uat.elintys.test` créés par `seed:uat` ; mot de passe unique (`UAT_SEED_PASSWORD`) transmis hors
bande, jamais dans Git ni dans la documentation. Les testeurs peuvent aussi s'inscrire avec leur propre adresse
pour éprouver le parcours de vérification (les adresses `.test` ne reçoivent pas de courriel).

## 40. Verdict final

**ELINTYS PLATFORM BASELINE — PARTIALLY READY — MANUAL INFRA ACTIONS REQUIRED** — base `elintys-uat`,
domaine `api.uat.elintys.com` (Render + DNS), domaine et variables Vercel `uat`, révocation de la clé LP ; puis
merge des PR, promotion `dev → uat`, migration + seed et smoke réel pour passer à
« UAT READY — CI/CD ACTIVE — USER ACCEPTANCE TESTING CAN START ».
