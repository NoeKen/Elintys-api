# Préaudit Architecture — Opérations Critiques
**Sprint 3 / Vague 4 — Stop P1 idempotence**
Date : 2026-08-18 | Auteur : Claude Code (Sonnet 4.6)

---

## 1. Architecture actuelle

```
Frontend Next.js
      │
      ▼
NestJS Modular Monolith (Elintys-api)
      │
      ├── Auth          → src/modules/auth/
      ├── Events        → src/modules/events/
      ├── Tickets       → src/modules/tickets/
      ├── Payments      → src/modules/payments/
      ├── Invitations   → src/modules/invitations/
      ├── Vendors       → src/modules/vendors/
      ├── Venues        → src/modules/venues/
      ├── Guests        → src/modules/guests/
      ├── Reviews       → src/modules/reviews/
      ├── Favorites     → src/modules/favorites/
      ├── Notifications → src/modules/notifications/
      ├── Discovery     → src/modules/discovery/
      ├── Media         → src/modules/media/
      ├── Emails        → src/modules/emails/
      └── shared/
            ├── constants/error-codes.ts
            ├── guards/   (JWT, Roles, Throttler)
            ├── filters/  (AllExceptionsFilter)
            ├── middleware/ (RequestObservability, TrustedOrigin)
            ├── pipes/    (ParseObjectId)
            └── utils/    (qr-code, transform, escape-regexp)
```

### Stack technique confirmée

| Composant       | Version  | Notes                           |
|-----------------|----------|---------------------------------|
| NestJS          | 11.x     | App Router                      |
| Mongoose        | 8.23.0   | Transactions supportées         |
| MongoDB cible   | À vérifier en lecture seule | Les transactions exigent un replica set ; aucune disponibilité n'est présumée avant le gate environnement |
| Stripe          | 22.1.0   | Webhooks checkout.session.*     |
| Jest            | 29.x     | + ts-jest, rootDir=src          |

---

## 2. Primitives existantes

### Ce qui fonctionne bien

| Primitive                       | Emplacement                              | Verdict         |
|---------------------------------|------------------------------------------|-----------------|
| Déduplication invitation token  | `invitations.service.ts#acceptInvitation` | ✅ Atomique (findOneAndUpdate conditionnel) |
| Token hash (SHA-256)            | `invitations.service.ts#hashToken`       | ✅ Correct       |
| Traduction E11000 ciblée        | `invitations.service.ts#translateDuplicateKeyError` | ✅ Distingue index métier vs technique |
| Rate limiting par userId        | `elintys-throttler.guard.ts`             | ✅ Par utilisateur authentifié |
| CSRF defense                    | `trusted-origin.middleware.ts`           | ✅ Origin allowlist |
| Timing attack mitigation (auth) | `auth.service.ts#login`                  | ✅ DUMMY_BCRYPT_HASH |
| Logs structurés                 | `request-observability.middleware.ts`    | ✅ requestId + durationMs |
| QR Code unique sparse           | `ticket.schema.ts#qrCode`                | ✅ unique + sparse index |

### Ce qui est partiellement présent

| Primitive                      | Emplacement                            | Limitation                            |
|-------------------------------|----------------------------------------|---------------------------------------|
| Idempotence Stripe webhook     | `payments.service.ts#handleCheckoutCompleted` | ✅ Check existant sur stripePaymentIntentId, mais TOCTOU possible (findOne + create séparés) |
| Pagination stable              | `events.service.ts`                    | ✅ { createdAt: -1, _id: -1 } — correct |
| Index composé invitation dedup | `invitation.schema.ts`                 | ✅ { invitedBy, email, eventId, type } unique |

---

## 3. Primitives manquantes

### 3.1 Idempotence générique multi-scope

**Absent.** Chaque domaine gère (ou ne gère pas) sa propre déduplication.
- `tickets.service.ts#purchase` : aucune idempotence → double-submit = double achat
- `tickets.service.ts#createPurchasesFromCheckout` : protégé par le check Stripe dans le layer supérieur, mais la protection est au niveau PaymentsService (findOne async) et non atomique
- `auth.service.ts#register` : aucune idempotence explicite (protégé par index unique email)

### 3.2 Transactions Mongoose

**Entièrement absentes.** Aucun `startSession()`, `withTransaction()`, `connection.transaction()` dans tout le codebase. Mongoose 8.23 les supporte, MongoDB Atlas Replica Set les supporte.

### 3.3 Machine d'état des opérations critiques

**Absente.** Pas de concept `PROCESSING / SUCCEEDED / FAILED` pour les opérations métier critiques.

### 3.4 Fingerprint payload

**Absent.** Aucune vérification que deux requêtes avec la même clé d'idempotence ont le même payload.

### 3.5 Contrainte DB sur stock atomique

**Partiellement présente.** `TicketType.sold` est incrémenté avec `$inc` (atomique sur un document), mais séparé de la création des `TicketPurchase` → non atomique globalement.

---

## 4. Opérations critiques — matrice des risques

### 4.1 TicketsService.purchase() — CRITIQUE P1

```typescript
// PROBLÈME 1 : Read-before-write race (TOCTOU)
const available = tt.quantity - tt.sold;    // READ sold
if (available < dto.quantity) throw ...;    // CHECK
await ticketPurchaseModel.create(...);       // WRITE purchase
await ticketTypeModel.$inc({ sold: qty });  // WRITE sold ← séparé

// Scénario race condition (stock=1, deux acheteurs A et B simultanés) :
// A: read sold=0, available=1 ✓
// B: read sold=0, available=1 ✓  (avant que A n'ait $inc)
// A: create purchase ✓
// B: create purchase ✓  ← DOUBLE VENTE !!
// A: $inc sold → 1
// B: $inc sold → 2  ← sold > quantity !!
```

**Risque :** P1 — Double vente possible sous concurrence
**Absence de :** transaction, findOneAndUpdate conditionnel avec filtre sold < quantity, unique constraint

### 4.2 PaymentsService.handleCheckoutCompleted() — CRITIQUE P1

```typescript
// PROBLÈME 2 : TOCTOU idempotence Stripe
const existing = await ticketPurchaseModel.findOne({ stripePaymentIntentId });  // READ
if (existing) return;                                                              // CHECK
await ticketsService.createPurchasesFromCheckout({ stripePaymentIntentId });     // WRITE

// Scénario : Stripe envoie le même webhook deux fois simultanément
// Request A : findOne → null
// Request B : findOne → null  (avant que A n'ait créé)
// A : crée purchases
// B : crée purchases  ← DOUBLE FULFILLEMENT !!
```

**Risque :** P1 — Double traitement webhook si Stripe retry simultané
**Absence de :** atomic upsert, état PROCESSING, transaction

### 4.3 TicketsService.purchase() — Absence idempotence utilisateur — P2

```typescript
// Un utilisateur clique "Acheter" deux fois rapidement
// → Deux requêtes HTTP arrivent
// → Deux achats créés (pour billets gratuits)
// Pas de protection contre le double-clic
```

**Risque :** P2 — Double achat sur double-clic (surtout billets gratuits)

### 4.4 EventsService.generateUniqueSlug() — MEDIUM

```typescript
// Pattern SELECT-then-INSERT pour les slugs
while (await Model.exists({ slug: candidate })) { candidate = `${base}-${++attempt}`; }
// Puis create(event)
// Race condition si deux événements créés en parallèle avec même titre
```

**Risque :** P3 — Slug dupliqué possible (protégé en pratique par la faible concurrence d'organisation)

### 4.5 AuthService.register() — Atomicité partielle — P2

```typescript
// 1. Crée User (protégé par unique email)
// 2. linkGuestPurchases() — si fail : tickets orphelins restent non-linkés
// 3. sendVerificationEmail() — fire-and-forget
// Pas de transaction : état partiel possible
```

**Risque :** P2 — Tickets invité non rattachés si linkGuestPurchases fail

### 4.6 TicketPurchase — Index stripePaymentIntentId manquant — P2

```typescript
// stripePaymentIntentId est stocké mais n'a PAS d'index unique
// Le check d'idempotence (findOne) est O(n) sans index → performance + race condition
@Prop()
stripePaymentIntentId?: string;
// ← aucun unique: true, aucun index déclaré
```

**Risque :** P2 — Performance et garantie incomplète

### 4.7 Autres domaines — candidats futurs

| Domaine            | Opération                | Risque     |
|--------------------|--------------------------|------------|
| VenueBooking       | createBooking            | Double réservation (medium — dates overlapping) |
| VendorRequest      | createRequest            | Duplicate check async (medium) |
| Refund             | refundTicket             | Double remboursement Stripe (medium — protégé partiellement) |
| Invitation accept  | acceptInvitation         | ✅ Protégé (findOneAndUpdate atomique) |
| Check-in (scan)    | scan()                   | Idempotent (USED → message, pas erreur) |

---

## 5. Architecture proposée

### Principe directeur

```
"Design for extraction, not for distribution."
BUILD FOR TODAY. DESIGN THE BOUNDARIES FOR TOMORROW.
```

### 5.1 Emplacement dans le repository

L'arborescence existante `src/shared/` accueille déjà les primitives transverses (guards, filters, middleware, utils). La couche de consistance s'y intègre naturellement :

```
src/shared/
  consistency/
    ├── consistency.module.ts         ← NestJS module exportant les services
    ├── index.ts                      ← Re-exports publics
    ├── idempotency/
    │   ├── idempotent-operation.schema.ts   ← Mongoose schema + enum Status
    │   ├── idempotency.service.ts           ← execute(), logique complète
    │   └── idempotency.service.spec.ts      ← Tests unitaires (fakes, pas de DB)
    ├── transactions/
    │   ├── transaction.service.ts           ← Thin wrapper connection.transaction()
    │   └── transaction.service.spec.ts
    ├── observability/
    │   ├── critical-operation.logger.ts     ← Logs structurés, jamais de secret
    │   └── critical-operation.logger.spec.ts
    └── errors/
        ├── consistency.errors.ts            ← HttpExceptions normalisées
        └── consistency.errors.spec.ts
```

### 5.2 Contrat de l'IdempotencyService

```typescript
interface ExecuteParams<TResult> {
  scope: string;           // 'ticket-purchase' | 'event-registration' | 'stripe-webhook' | ...
  actorId: string;         // userId ou resourceId (ex: stripePaymentIntentId)
  idempotencyKey: string;  // Clé fournie par le client ou générée stable
  payload: Record<string, unknown>;  // Paramètres métier — fingerprint calculé dessus
  operation: (session: ClientSession) => Promise<TResult>; // Mutation DB transactionnelle
}
```

### 5.3 Machine d'état

```
                    ┌─────────────────────┐
 Nouvelle clé  ─── ▶│    PROCESSING       │
                    └─────────────────────┘
                           │          │
                    succès │          │ erreur
                           ▼          ▼
                    ┌──────────┐  ┌──────────┐
                    │SUCCEEDED │  │  FAILED  │
                    └──────────┘  └──────────┘
                         │             │
                 replay  │             │ retry (même fingerprint)
                (retour  │             │ → PROCESSING à nouveau
                 résultat│             │
                 caché)  ▼             ▼
                     [return]      [re-execute]

Appel concurrent même clé (PROCESSING en cours) → OPERATION_ALREADY_PROCESSING
Même clé + payload différent (tout statut) → IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
```

### 5.4 Garantie multi-instance

La garantie repose **exclusivement** sur MongoDB :

```
Unique compound index : { scope: 1, actorId: 1, keyHash: 1 }

findOneAndUpdate + upsert + $setOnInsert
  → Atomique côté serveur MongoDB
  → Deux instances API peuvent tenter simultanément
  → Une seule obtient la création, l'autre lit l'existant

Aucun mutex Node.js, Map, Set ou variable globale n'est utilisé comme garantie.
```

---

## 6. Dépendances identifiées

### Dépendances directes

| Dépendance          | Usage                                    | Déjà présente |
|---------------------|------------------------------------------|---------------|
| `@nestjs/mongoose`  | InjectModel pour IdempotentOperation     | ✅            |
| `mongoose`          | Connection.transaction(), ClientSession  | ✅            |
| `@nestjs/common`    | Logger, Injectable, Module               | ✅            |
| `crypto` (Node)     | SHA-256 fingerprint                      | ✅ built-in   |

**Aucune nouvelle dépendance npm requise.**

### Modules à modifier (futur raccordement — hors scope Phase A+B)

| Module              | Opération critique                       | Modification planifiée           |
|--------------------|------------------------------------------|----------------------------------|
| TicketsModule      | purchase(), createPurchasesFromCheckout() | Wrapper IdempotencyService       |
| PaymentsModule     | handleCheckoutCompleted()                 | Wrapper + index stripePaymentIntentId |
| (EventRegistration) | registerParticipant()                   | Nouveau domaine, Phase C         |

---

## 7. Risques

| Risque                        | Sévérité | Mitigation                                              |
|-------------------------------|----------|---------------------------------------------------------|
| Transactions MongoDB indisponibles (standalone) | HIGH | Vérifier replica set avant activation ; STOP si indisponible, sans fallback non transactionnel. |
| Documents PROCESSING bloqués (process crash) | MEDIUM | Lease expirant et reprise conditionnelle atomique ; pas de suppression TTL des états en cours. |
| Fingerprint instable (JSON key order imbriqué) | HIGH | Canonicalisation récursive des objets avant SHA-256. |
| $setOnInsert + unique index edge case | LOW | Comportement MongoDB déterministe avec compound unique index |
| Surcharge collection idempotent_operations | LOW | TTL index (ex: 90 jours) pour cleanup automatique |
| Tests couplés à elintys-dev | HAUTE | Tests unitaires avec fakes uniquement — aucune connexion DB |

---

## 8. Stratégie de migration

### Phase A+B (actuelle — cette implémentation)
1. Créer le socle dans `src/shared/consistency/`
2. Tests unitaires avec fakes MongoDB (0 connexion DB)
3. Gates statiques : lint, typecheck, build, test unitaires
4. **Aucun raccordement des domaines**
5. **Aucune écriture en elintys-dev**

### Addendum review Codex

La première version issue de l'audit persistait la clé brute, ne reprenait pas les
`PROCESSING` après crash et finalisait l'état idempotent hors de la transaction
métier. La review Codex a refusé ce gate et corrigé le socle : clé SHA-256 seulement,
lease reprenable, canonicalisation récursive, résultat borné à 64 KiB, logs hashés,
et commit atomique de l'effet MongoDB avec `SUCCEEDED`. Les indexes sont déclarés
avec `autoIndex: false` et doivent être créés uniquement par la migration contrôlée.

### Phase C (après gate Codex)
1. Ajouter index `stripePaymentIntentId` sur TicketPurchase (migration script isolé)
2. Raccorder `PaymentsService` au socle
3. Raccorder `TicketsService.purchase()` au socle + transaction
4. Tests d'intégration isolés (MongoDB local, pas elintys-dev)
5. Tests de concurrence réels

### Phase D (après validation Phase C)
1. Créer domaine `EventRegistration`
2. Migration elintys-dev (backup + dry-run + checksums)
3. Tests E2E + concurrency tests

---

## 9. Trajectoire microservices

**Aujourd'hui :** Modular Monolith — primitives dans `src/shared/consistency/`

```
NestJS Monolith
  src/shared/consistency/   ← primitives locales
  src/modules/tickets/       ← consomment IdempotencyService localement
  src/modules/payments/      ← consomment TransactionService localement
```

**Demain (si extraction bounded contexts) :**

```
Tickets Service  ──── shared/primitives npm package interne
Payments Service ──┤  (idempotency + transactions + observability)
Registration Svc ──┘

Chaque service maintient ses propres garanties locales.
Pas de "Idempotency Microservice" réseau.
```

**Plus tard (si workflows inter-services) :**

```
Patterns à introduire uniquement si nécessaire :
  - Transactional Outbox (écriture DB + event atomique)
  - Idempotent Consumers (déduplication côté consommateur)
  - Inbox / Deduplication (protection contre replay)
  - Event IDs stables (corrélation)
  - Sagas / Process Managers (workflows longs)
  - Compensation (rollback distribué)
  - Messaging (broker si volume justifie)

NE PAS implémenter maintenant.
```

**Règle permanente :**
> `shared library ≠ shared database`
> `shared infrastructure primitives ≠ shared business logic`

---

*Fin du préaudit — Phase A*
