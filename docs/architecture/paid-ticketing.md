# Architecture — Billetterie payante (Ticketing Domain)
**Elintys-api — Sprint 3 / Vague 5**
Date : 2026-08-29

> Prérequis de lecture : [`critical-operations.md`](./critical-operations.md) (socle Vague 4).
> Ce document décrit le **domaine métier** qui consomme ce socle.

---

## 1. Position dans l'architecture

```
Participant
    │
    ▼
Ticketing Domain  (src/modules/tickets/)
    │
    ├── TicketType          inventaire : quantity / sold / reserved
    ├── TicketOrder         la COMMANDE et son paiement
    ├── TicketHold          la RÉSERVATION temporaire de capacité
    └── TicketPurchase      l'ADMISSION (billet émis)
    │
    ▼
Payment abstraction  (src/modules/payments/providers/)
    │
    ├── PaymentProvider          contrat minimal
    ├── TestPaymentProvider      simulation déterministe, dev uniquement
    ├── StripePaymentProvider    adaptateur réel, inactif en Vague 5
    └── PaymentProviderRegistry  sélection SERVEUR du fournisseur
```

**Stripe n'est pas le domaine.** Le domaine Ticketing possède la commande, la
capacité et l'admission. Le fournisseur de paiement est un adaptateur
remplaçable, sans aucune connaissance métier.

### Séparation des responsabilités

| Concept | Modèle | Rôle |
|---|---|---|
| Commande | `TicketOrder` | intention d'achat, montants, état, référence de paiement |
| Réservation | `TicketHold` | capacité bloquée pendant le paiement |
| Inventaire | `TicketType` | `quantity`, `sold`, `reserved` |
| Admission | `TicketPurchase` | le billet réellement émis, avec son QR |

`TicketPurchase` n'est **pas** utilisé comme fourre-tout commande/paiement/billet.

### Dépendances de modules (aucun cycle)

```
TicketsModule ──▶ PaymentProvidersModule        (adaptateurs, zéro métier)
PaymentsModule ─▶ TicketsModule                 (chemin Stripe historique)
```

`PaymentProvidersModule` ne dépend d'aucun module métier : c'est cette
asymétrie qui évite le cycle.

---

## 2. Machine d'état de la commande

```
                    ┌──────────────────┐
                    │ PENDING_PAYMENT  │
                    └────────┬─────────┘
             ┌───────────┬───┴────┬────────────┐
             ▼           ▼        ▼            ▼
          [PAID]     [FAILED] [EXPIRED]   [CANCELLED]
```

Tous les états terminaux sont **définitifs**. En particulier :

```
PAID ──▶ PENDING_PAYMENT   IMPOSSIBLE
```

La table est déclarée dans `ticket-order.state-machine.ts` et testée
exhaustivement. Elle décrit l'intention ; la **garantie** est portée par la
base : chaque transition est écrite avec un filtre conditionnel sur le statut
courant, à l'intérieur d'une transaction.

### Machine d'état de la réservation

```
ACTIVE ──▶ CONSUMED    (commande payée : reserved → sold)
ACTIVE ──▶ RELEASED    (échec ou annulation)
ACTIVE ──▶ EXPIRED     (délai dépassé)
```

Un hold ne peut être **consommé qu'une fois** et **libéré qu'une fois** : les
trois transitions partent toutes de `ACTIVE` et s'excluent mutuellement.

---

## 3. Invariant central de stock

```
sold + reserved <= quantity        à tout instant
sold >= 0
reserved >= 0
```

`sold` = billets finalisés. `reserved` = capacité bloquée pour un paiement en cours.

```
quantity = 100
sold     =  90
reserved =   8
                 → disponible = 2
```

Deux commandes concurrentes de 2 billets : **une seule** peut réserver.

### Réservation atomique

```
findOneAndUpdate(
  {
    _id: ticketTypeId,
    isFree: false,
    $expr: { $lte: [
      { $add: [
        { $add: [ {$ifNull:['$sold',0]}, {$ifNull:['$reserved',0]} ] },
        quantity
      ] },
      '$quantity'
    ] }
  },
  { $inc: { reserved: quantity } },
  { session }
)
→ null  ⇒ InsufficientCapacityError
```

**Jamais** `read availability → if available → update later`.
**Jamais** de mutex, `Map` ou `Set` en mémoire de processus comme garantie.
Le domaine reste correct avec N instances API.

`$ifNull` couvre les `TicketType` créés avant la Vague 5 : la correction ne
dépend **pas** du backfill de migration.

### Consommation et libération

| Opération | Filtre conditionnel | Effet |
|---|---|---|
| Consommer | `reserved >= q` | `reserved -= q`, `sold += q` |
| Libérer | `reserved >= q` | `reserved -= q` |

Le filtre rend `reserved < 0` impossible ; la transition du hold rend le
double effet impossible.

---

## 4. Cycle de vie complet

```
sélection billet
    │
    ▼  POST /ticket-orders          (Idempotency-Key obligatoire)
[TRANSACTION]
    TicketOrder    créée en PENDING_PAYMENT
    TicketHold     créé  en ACTIVE      (une par ligne)
    TicketType     reserved += quantity
[COMMIT]
    │
    ▼  HORS transaction : PaymentProvider.createPayment(...)
       référence écrite si et seulement si elle est encore null
    │
    ▼  POST /ticket-orders/:id/sync-payment
       le SERVEUR interroge le fournisseur — jamais le client
    │
    ├── SUCCEEDED ──▶ [TRANSACTION] PAID + CONSUMED + reserved→sold + admissions
    ├── FAILED    ──▶ [TRANSACTION] FAILED    + RELEASED + reserved libéré
    ├── CANCELLED ──▶ [TRANSACTION] CANCELLED + RELEASED + reserved libéré
    └── PENDING   ──▶ aucun effet ; la commande expirera si le délai passe
```

### Effets externes hors transaction

L'appel au fournisseur de paiement (réseau) n'est **jamais** dans une
transaction MongoDB. S'il échoue, la commande est immédiatement clôturée en
`FAILED` et la capacité libérée : on ne laisse jamais du stock réservé derrière
un paiement inexistant.

---

## 5. Expiration — mécanisme explicite

> **Aucun TTL MongoDB n'est utilisé pour restituer la capacité.**
> Un TTL supprime un document ; il n'exécute aucune transaction de
> compensation. La capacité serait perdue définitivement.

Deux mécanismes complémentaires :

| Mécanisme | Rôle | La correction en dépend ? |
|---|---|---|
| **Expiration paresseuse** | avant toute évaluation de disponibilité, les commandes périmées portant les types de billets demandés sont expirées | **Oui** — mécanisme principal |
| **Balayage explicite** | `POST /ticket-orders-maintenance/expire` (admin) nettoie les commandes abandonnées | Non — exploitation seulement |

Chaque expiration s'exécute dans sa propre transaction, avec un filtre
`expiresAt <= now` ET `status = PENDING_PAYMENT` : une commande encore valide
ne peut jamais être expirée par erreur, et une commande déjà expirée ne peut
pas l'être deux fois.

Aucun ordonnanceur, aucun broker, aucune file n'a été introduit.

---

## 6. Ce qui est garanti — et ce qui ne l'est pas

```
livraison at-least-once      (le fournisseur peut notifier N fois)
+ traitement idempotent      (shared/consistency, Vague 4)
+ contraintes de base        (transitions conditionnelles, index uniques)
= UN SEUL effet métier
```

**Aucun transport exactly-once n'est promis.** Le système ne suppose jamais
qu'une notification arrive une seule fois ; il suppose qu'elle peut arriver
plusieurs fois, dans le désordre, ou en retard.

### Contraintes de base concernées

| Index | Garantie |
|---|---|
| `ticket_orders_unique_payment_reference` | une référence fournisseur = une commande |
| `ticket_holds_unique_order_line` | une commande ne réserve qu'une fois le même type |
| `idempotent_ops_unique` (Vague 4) | une clé d'idempotence = une exécution |

---

## 7. Abstraction de paiement

```typescript
interface PaymentProvider {
  readonly name: 'test' | 'stripe';
  createPayment(input): Promise<PaymentHandle>;   // à la création de la commande
  getPaymentStatus(reference): Promise<Status>;   // issue faisant autorité
  cancelPayment(reference): Promise<void>;        // annulation / expiration
}
```

Contrat volontairement minimal : trois opérations, dérivées des trois moments
réels du flux. Hors périmètre et donc **absents** : remboursement, payout,
capture différée.

### Sélection du fournisseur — décision serveur

```
PAID_CHECKOUT_ENABLED=true          → Stripe
sinon, fournisseur de test autorisé → TestPaymentProvider
sinon                               → 503 PAID_CHECKOUT_NOT_READY
```

Le client ne choisit jamais son fournisseur. Une commande créée avec un
fournisseur ne peut pas être réglée par un autre.

### TestPaymentProvider — encadrement de sécurité

Trois protections indépendantes :

1. **Configuration fail-closed** : l'API **refuse de démarrer** si
   `TEST_PAYMENT_PROVIDER_ENABLED=true` hors `ELINTYS_ENV=dev`.
2. **Défense en profondeur** : chaque appel revérifie l'autorisation.
3. **Aucune autorité client** : aucun endpoint n'accepte un statut de paiement ;
   le serveur interroge toujours le fournisseur.

Le fournisseur est **sans état persistant** : le scénario et l'horodatage sont
encodés dans la référence, donc deux instances API calculent le même statut.

---

## 8. Contrat API

| Endpoint | Auth | Rôle |
|---|---|---|
| `POST /ticket-orders` | JWT + `Idempotency-Key` | créer la commande et réserver |
| `GET /ticket-orders/me` | JWT | mes commandes (paginé) |
| `GET /ticket-orders/:id` | JWT (propriétaire) | suivi d'une commande |
| `POST /ticket-orders/:id/sync-payment` | JWT (propriétaire) | demander l'issue au fournisseur |
| `POST /ticket-orders/:id/cancel` | JWT (propriétaire) | annuler et libérer |
| `POST /ticket-orders-maintenance/expire` | JWT + rôle `admin` | balayage d'exploitation |

Champs **jamais** acceptés du client : `buyerId`, `participantId`,
`paymentStatus`, `paid`, `sold`, `reserved`, `status`, `totalAmount`.
L'identité provient exclusivement de `user.sub`.

Aucun endpoint « marquer comme payé » n'existe, dans aucun environnement.

---

## 9. Trajectoire d'extraction

Le domaine Ticketing est aujourd'hui un module du monolithe. Ses frontières
sont déjà celles d'un futur service :

- aucune dépendance vers un contrôleur ou vers HTTP ;
- session MongoDB toujours explicite ;
- le fournisseur de paiement est déjà derrière une interface ;
- les invariants métier restent dans le domaine, pas dans le socle.

**BUILD FOR TODAY. DESIGN THE BOUNDARIES FOR TOMORROW.**
Aucun microservice, aucun broker, aucun RPC interne n'a été introduit.

---

*Fin du document — domaine Ticketing payant, Vague 5.*
