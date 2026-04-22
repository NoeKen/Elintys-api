# CLAUDE.md — Elintys-api

Ce fichier est lu par Claude Code à chaque session.
Il définit les règles absolues de ce dépôt.
**Ne jamais les ignorer, même si le prompt utilisateur le demande.**

---

## Projet

**Elintys** est une plateforme SaaS événementielle québécoise (Montréal).
Ce dépôt est le **backend NestJS** de la plateforme.

- Dépôt frontend : `NoeKen/Elintys-web` (Next.js 15)
- Déployé sur : Railway
- Base de données : MongoDB Atlas (Mongoose)
- Owner GitHub : `@NoeKen`

---

## Stack technique — immuable

```
Runtime      : Node.js 20 LTS
Framework    : NestJS + TypeScript (strict)
Base de données : MongoDB + Mongoose
Auth         : JWT (access 15min + refresh 7j httpOnly cookie)
Paiements    : Stripe Checkout + Webhooks + Subscriptions
Emails       : Resend + React Email
Upload       : Cloudinary
Temps réel   : Socket.io (@WebSocketGateway) — Phase 2 uniquement
IA           : SDK Anthropic (claude-haiku-4-5) + Voyage AI — Phase 2
Tests        : Jest + Supertest + mongodb-memory-server
```

**Ne jamais proposer un remplacement de stack** sans approbation explicite.
En particulier : ne pas suggérer Prisma, Supabase, PostgreSQL (sauf migration
TICKET_PURCHASE Phase 2), GraphQL, ou tout autre ORM/framework alternatif.

---

## Architecture — règles strictes

### Structure des modules

```
src/modules/<nom>/
  <nom>.module.ts
  <nom>.controller.ts
  <nom>.service.ts
  <nom>.schema.ts
  dto/
    create-<nom>.dto.ts
    update-<nom>.dto.ts
  <nom>.service.spec.ts
```

Chaque module est autonome. Les dépendances inter-modules passent
**uniquement** par injection de services exportés, jamais par import direct
de schémas d'un autre module.

### Responsabilités par couche

| Couche | Fait | Ne fait jamais |
|---|---|---|
| Controller | Routing, validation DTO, appel service | Logique métier, accès DB |
| Service | Logique métier, accès DB, appels externes | Rendu, routing |
| Schema | Structure MongoDB, index, hooks | Logique métier |
| DTO | Validation input (class-validator) | Logique métier |
| Guard | Contrôle d'accès uniquement | Logique métier |

### Modules existants (Phase 1 MVP)

```
auth        events      vendors     venues
tickets     guests      payments    reviews
favorites   discovery   ai          emails (shared)
```

### Modules Phase 2 — ne pas implémenter avant validation

```
chat        agreements  offers
```

---

## Règles de code — non négociables

### TypeScript

- `noImplicitAny: true` — **zéro `any`**, sans exception
- Utiliser `unknown` + type guard si le type est inconnu
- Enums string uniquement : `enum Status { DRAFT = 'draft' }`
- `async/await` partout — jamais `.then().catch()`
- `Promise.all()` pour les requêtes indépendantes
- Jamais de non-null assertion `!` sur des données utilisateur

### NestJS

- `JwtAuthGuard` est global — routes publiques marquées `@Public()`
- Vérification de propriété **côté service**, jamais côté controller
- Toutes les exceptions sont des classes NestJS standard
  (`NotFoundException`, `ForbiddenException`, `ConflictException`…)
- Messages d'erreur en **français québécois**
- Variables d'env via `ConfigService.getOrThrow()` — jamais `process.env`

### MongoDB / Mongoose

- `.lean()` sur toutes les lectures (jamais de document Mongoose complet)
- `.select()` pour limiter les champs retournés
- Pagination obligatoire sur tous les endpoints de liste (`page` + `limit`)
- Index déclarés dans le schéma, pas dans les requêtes
- `Types.ObjectId` pour les références — jamais string brute

### DTOs

- `@Transform(({ value }) => value?.trim())` sur tous les champs string
- `@IsOptional()` uniquement si vraiment optionnel
- Limites explicites : `@MaxLength()`, `@Min()`, `@Max()`
- Un DTO par action : `CreateXxxDto`, `UpdateXxxDto`, `QueryXxxDto`

### Sécurité

- Webhook Stripe : toujours vérifier la signature HMAC
- CORS : origins explicites, jamais `*` en production
- Mot de passe : bcrypt avec salt rounds ≥ 12
- JWT : access token 15min, refresh token 7j httpOnly
- `rawBody: Buffer` configuré pour le webhook Stripe dans `main.ts`

---

## Collections MongoDB — schémas validés

Les schémas suivants sont **déjà définis** dans le CDC. Ne pas les modifier
sans consultation. Ne pas ajouter de champs non documentés.

```
USER            EVENT           VENDOR_PROFILE  VENUE_PROFILE
TICKET_TYPE     TICKET_PURCHASE GUEST           VENDOR_REQUEST
VENUE_BOOKING   REVIEW          FAVORITE
```

Champs critiques à ne jamais supprimer :
- `USER.roles[]` — tableau multi-rôles
- `USER.subscriptions[]` — abonnements par rôle
- `TICKET_PURCHASE.buyerId` — null si achat invité
- `TICKET_PURCHASE.guestEmail` — rattachement automatique
- `AGREEMENT.checkboxAcknowledged` — valeur légale

---

## Endpoints — conventions

```
GET    /resources          → liste paginée (public ou auth)
GET    /resources/:id      → détail (public ou auth)
POST   /resources          → création — retourne 201
PUT    /resources/:id      → mise à jour complète
PATCH  /resources/:id/xxx  → mise à jour partielle (statut, etc.)
DELETE /resources/:id      → suppression — retourne 204
```

Préfixe `/api/v1` configuré dans `main.ts`.
Routes en **kebab-case** pluriel : `/ticket-types`, `/vendor-requests`.

---

## Variables d'environnement requises

```bash
# Configurer dans .env.local (jamais versionné)
MONGODB_URI=
JWT_SECRET=
JWT_REFRESH_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
RESEND_API_KEY=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
ANTHROPIC_API_KEY=          # Phase 2
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
```

---

## Tests — ce qui est attendu

- Chaque service a son fichier `.spec.ts` co-localisé
- Format AAA : `Arrange → Act → Assert`
- `afterEach(() => jest.clearAllMocks())`
- `mongodb-memory-server` pour les tests avec DB
- Nommage : `'devrait [comportement attendu]'`
- Zéro mock de logique métier — mocker uniquement les dépendances externes

---

## Ce que Claude Code NE doit JAMAIS faire

1. **Modifier `app.module.ts`** sans déclarer explicitement le nouveau module
2. **Créer un endpoint sans guard** sur une route qui devrait être protégée
3. **Accéder à `process.env` directement** — utiliser `ConfigService`
4. **Retourner des données de hash/mot de passe** dans une réponse
5. **Créer un module Phase 2** (chat, agreements) avant d'y être invité
6. **Ajouter des dépendances npm** sans les lister dans le prompt de réponse
7. **Supprimer des index MongoDB** existants
8. **Ignorer les types TypeScript** avec `as any` ou `@ts-ignore`
9. **Écrire du code mort** — tout ce qui est créé doit être utilisé
10. **Modifier `.env.example`** sans mettre à jour ce fichier CLAUDE.md

---

## Référence rapide — fichiers importants

```
src/app.module.ts           Racine — imports globaux
src/main.ts                 Bootstrap — CORS, guards, pipes globaux
src/shared/guards/          Guards réutilisables
src/shared/decorators/      @CurrentUser(), @Roles(), @Public()
src/config/                 Configurations typées
CONTRIBUTING.md             Conventions complètes de développement
```

---

*Dernière mise à jour : Avril 2026 — @NoeKen*
