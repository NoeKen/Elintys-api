# Architecture — Opérations Critiques
**Elintys-api — Sprint 3 / Vague 4**
Date : 2026-08-18

---

## Vue d'ensemble

Ce document décrit l'architecture de la couche de consistance transverse introduite dans `src/shared/consistency/`. Elle fournit des **primitives techniques** partagées par les modules métier, sans contenir de logique métier elle-même.

---

## Architecture actuelle

```
Frontend Next.js
      │
      ▼
NestJS Modular Monolith
      │
      ├── src/shared/consistency/          ← SOCLE TRANSVERSE (nouveau)
      │     ├── IdempotencyService         primitives d'idempotence
      │     ├── TransactionService         wrapper BEGIN/COMMIT/ROLLBACK
      │     ├── CriticalOperationLogger    logs structurés, jamais de secret
      │     └── ConsistencyErrors          erreurs normalisées
      │
      ├── src/modules/tickets/             consomme idempotence + transactions
      ├── src/modules/payments/            finalisation Stripe durable + transactions
      ├── src/modules/invitations/         acceptation déjà atomique
      ├── src/modules/events/
      └── …
```

### Règle fondamentale

```
Modular Monolith
  │
  Critical Operations Infrastructure
  │  ↕ primitives techniques uniquement
  │
  + Tickets      ← invariant : sold ≤ quantity
  + Payments     ← invariant : un PaymentIntent = une finalisation
  + Invitations  ← invariant : useCount < maxUses
  + EventRegistration ← invariant : un participant = une inscription active
```

Les modules métier possèdent leurs invariants. Le socle fournit les mécanismes.

---

## Composants du socle

### IdempotencyService

**Contrat :**
```typescript
idempotencyService.execute({
  scope: 'ticket-purchase',       // domaine
  actorId: userId,                // acteur ou ressource
  idempotencyKey: dto.key,        // clé client
  payload: { ticketTypeId, qty }, // paramètres métier (fingerprint calculé dessus)
  operation: (session) => doDatabaseWork({ session }),
  toReplayResult: (result) => ({ id: result.id }), // projection JSON <= 64 KiB
})
```

**Machine d'état :**
```
Nouvelle (scope, actorId, key)
      │
      ▼ findOneAndUpdate + upsert + $setOnInsert [atomic, clé hashée]
   PROCESSING ────────────────────────────────────────────┐
      │                                                   │
      │ succès              rollback                      │ concurrent + lease actif
      ▼                     ▼                            │
  SUCCEEDED              FAILED                           │
      │                     │                            │
      │ replay (même fp)     │ retry (même fp) ──────────┘
      │ → résultat caché     ▼
      │                   PROCESSING → SUCCEEDED | FAILED
      ▼
  [return result]

Même clé + payload différent (tout statut) → IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD

PROCESSING + lease expiré → reprise atomique par une seule instance
```

L'effet métier MongoDB et le passage à `SUCCEEDED` sont écrits dans **la même
transaction**. Le callback reçoit obligatoirement la `ClientSession`. Les effets
externes (appel Stripe, email, HTTP) sont interdits dans ce callback : ils devront
être effectués avant la mutation ou, lorsque nécessaire, via un futur outbox.

### TransactionService

**Contrat :**
```typescript
// BEGIN / COMMIT / ROLLBACK explicitement visible dans le code appelant
const result = await transactionService.run('ticket-purchase', async (session) => {
  // Toutes les opérations Mongoose reçoivent { session }
  const tt = await TicketType.findOneAndUpdate(..., { session });
  const purchases = await TicketPurchase.create([...], { session });
  return purchases;
  // ↑ Mongoose commit automatiquement si pas d'exception
  // ↓ Mongoose rollback automatiquement si exception
});
```

> **IMPORTANT : ne jamais utiliser `Promise.all()` dans une transaction.**
> MongoDB ne garantit pas l'ordre d'exécution des opérations parallèles
> dans la même session. Séquentialiser toujours avec `await`.

### CriticalOperationLogger

Logs JSON structurés. Champs jamais loggués : clé complète, secret, token, données bancaires.

```typescript
// Loggué (safe) :
{
  "operationType": "idempotency",
  "scope": "ticket-purchase",
  "actorId": "7d8b9f62c9e1", // identifiant toujours hashé
  "status": "succeeded",
  "durationMs": 42,
  "keyHashPrefix": "c684dd39" // préfixe du SHA-256 uniquement
}

// Jamais loggué :
{ "idempotencyKey": "super-secret-full-key" }  // ← INTERDIT
{ "actorId": "pi_3Xyz_FULL_STRIPE_PI_ID" }     // ← hashé/tronqué
```

### ConsistencyErrors

Erreurs normalisées retournables aux clients :

| Code | HTTP | Signification |
|------|------|---------------|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Clé manquante |
| `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` | 409 | Même clé, payload différent |
| `OPERATION_ALREADY_PROCESSING` | 409 | Concurrence — en cours d'exécution |
| `INSUFFICIENT_CAPACITY` | 400 | Stock insuffisant (à utiliser par Tickets) |
| `REGISTRATION_ALREADY_EXISTS` | 409 | Inscription déjà existante (à utiliser par EventRegistration) |

---

## Garanties multi-instance

```
Instance API #1         Instance API #2
      │                       │
      │ findOneAndUpdate       │ findOneAndUpdate
      │ + upsert               │ + upsert
      │ + $setOnInsert         │ + $setOnInsert
      │                       │
      └──────────┬────────────┘
                 │
        MongoDB (Replica Set)
        Unique Index { scope, actorId, keyHash }
                 │
         Une seule crée → l'autre lit l'existant
```

**Ce qui N'EST PAS utilisé comme garantie :**
- `Map` JavaScript
- `Set` JavaScript
- Mutex / Semaphore Node.js
- Variables globales
- Mémoire process

**Ce qui EST utilisé :**
- Index unique composé MongoDB
- `findOneAndUpdate + upsert + $setOnInsert` (atomique côté serveur)
- `findOneAndUpdate` conditionnel pour le retry FAILED ou le lease expiré
- `Connection#transaction` avec session explicite pour l'effet et sa finalisation

---

## Base de données comme dernière ligne de défense

Principe : la validation applicative améliore l'UX, la contrainte DB garantit l'intégrité.

```
Application layer :
  available = quantity - sold
  if (available < requested) throw InsufficientCapacityError  ← UX rapide

Database layer (dernière ligne de défense) :
  findOneAndUpdate(
    {
      _id: ticketTypeId,
      $expr: { $lte: [{ $add: ['$sold', requested] }, '$quantity'] }
    },                                                ← filtre conditionnel exact
    { $inc: { sold: requested } },
    { session }                                       ← dans une transaction
  )
  if (!updated) throw InsufficientCapacityError       ← race condition stoppée

Ne jamais considérer findOne() + create() comme protection suffisante.
```

---

## Reprise après crash et limites

| Limitation | Impact | Plan |
|-----------|--------|------|
| Lease fixe de 5 minutes | Une opération DB anormalement longue peut perdre son lease ; son commit échoue alors et toute sa transaction est rollback | Garder les callbacks courts ; ajouter un renouvellement seulement si un vrai cas long apparaît |
| TTL 90 jours sur les seuls états terminaux | Stockage borné ; le nettoyage TTL n'est pas instantané | Ajustable selon volume et politique d'audit |
| Résultat de replay limité à 64 KiB JSON | Les documents volumineux sont refusés avant commit | Utiliser `toReplayResult` et stocker une projection/ID |
| Effets externes non transactionnels | La primitive ne peut pas rendre un appel réseau exactly-once | Ne pas appeler de réseau dans `operation`; utiliser les identifiants/idempotences du fournisseur et, plus tard si requis, outbox |

## Gate architecture Codex — 2026-08-18

| Question | Verdict après corrections |
|---|---|
| A. Réellement transverse ? | Oui : idempotence, transaction, erreurs et logs seulement. |
| B. Logique métier dans le socle ? | Non : capacité, inscription et PaymentIntent restent dans leurs domaines. |
| C. God Module ? | Non : deux services étroits et des erreurs/logs sans orchestration métier. |
| D. Abstraction prématurée ? | Non après suppression des promesses distribuées ; API locale Mongoose explicite. |
| E. Multi-instance ? | Oui, sous réserve de l'index unique migré et du replica set vérifié. |
| F. Garanties MongoDB ? | Oui : upsert/index, lease conditionnel et transaction effet + SUCCEEDED. |
| G. Extraction future ? | Oui : aucune dépendance Controller/HTTP, session explicite. |
| H. Librairie interne future ? | Oui, mais chaque service garderait sa base et ses invariants. |
| I. Race résiduelle ? | Pas de race d'intégrité connue dans le socle ; les tests Mongo réels restent requis après migration. |
| J. Assez simple pour le MVP ? | Oui : aucune infra réseau, broker, ALS ou mutex process. |

Le gate a été levé après vérification du replica set `elintys-dev`, application
idempotente des six index de la vague et tests de concurrence sur MongoDB réel.
`autoIndex: false` continue d'empêcher le démarrage applicatif de créer
silencieusement les index hors migration contrôlée.

---

## Trajectoire microservices

### Aujourd'hui — Modular Monolith

```
src/shared/consistency/   ← primitives locales, dans le monolith
```

Les modules consomment directement via injection NestJS. Aucun réseau.

### Demain — Extraction de bounded contexts

Si Tickets ou Payments deviennent des services autonomes :

```
Option A : package npm interne
  @elintys/consistency-primitives (npm private registry)
  Chaque service importe le même package.
  Chaque service a sa propre base MongoDB (sa propre collection idempotent_operations).

Option B : copier-coller adapté
  Acceptable si les services divergent.

INTERDIT :
  Un "Idempotency Microservice" réseau centralisé.
  → Crée une dépendance synchrone et un point de défaillance unique.
```

### Plus tard — Workflows inter-services

Si des transactions traversent plusieurs services, introduire **uniquement si nécessaire** :

| Pattern | Quand | Pourquoi pas maintenant |
|---------|-------|------------------------|
| Transactional Outbox | Écriture DB + événement atomique | Pas de broker aujourd'hui |
| Idempotent Consumers | Déduplication côté consommateur | Pas de consommateurs aujourd'hui |
| Inbox / Deduplication | Protection contre replay cross-service | Pas de messages inter-services |
| Sagas / Process Managers | Workflows longs multi-services | Pas de services autonomes |
| Compensation | Rollback distribué | Pas de transactions distribuées |

---

## Principes directeurs

```
"shared library ≠ shared database"
  → Deux services ne partagent jamais la même base. Chacun maintient
    ses propres idempotent_operations dans sa propre base.

"shared infrastructure primitives ≠ shared business logic"
  → ConsistencyModule fournit des mécanismes.
    Les invariants métier (sold ≤ quantity) restent dans Tickets.
    Les invariants métier (un participant = une inscription) restent dans Registration.

"Design for extraction, not for distribution"
  → Les frontières sont propres aujourd'hui.
    On ne paie pas le coût des microservices aujourd'hui.

"BUILD FOR TODAY. DESIGN THE BOUNDARIES FOR TOMORROW."
```

---

*Fin du document architecture — raccordement domaines Vague 4 validé.*
