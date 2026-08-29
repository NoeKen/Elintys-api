# Sprint 3 / Vague 5 — Paid Ticketing Core
## Rapport d'implémentation

**Date** : 2026-08-29
**Auteur** : Claude Code (Opus 5) — implémenteur
**Branche** : `dev` (worktree non committé, remis à Codex pour review indépendante)
**Statut Stripe** : `PAID_CHECKOUT_ENABLED` reste `false`. Aucun paiement réel n'a été effectué.

---

## 1. Audit initial

### 1.1 État du dépôt au démarrage

| Élément | Constat |
|---|---|
| Branche | `dev`, synchronisée avec `origin/dev` (`8d32f4d`) |
| Worktree | propre |
| Tests unitaires | 716/716 |
| Tests E2E | 29/29 |
| MongoDB dev | `elintys-dev`, replica set `atlas-10vwsl-shard-0`, transactions disponibles |

### 1.2 Ce qui existait déjà — et a été réutilisé tel quel

| Primitive | Emplacement | Décision |
|---|---|---|
| `IdempotencyService` (lease, fingerprint, replay) | `shared/consistency/idempotency/` | **réutilisé**, non modifié |
| `TransactionService` (BEGIN/COMMIT/ROLLBACK) | `shared/consistency/transactions/` | **réutilisé**, non modifié |
| `CriticalOperationLogger` | `shared/consistency/observability/` | **réutilisé**, non modifié |
| Erreurs normalisées + `InsufficientCapacityError` | `shared/consistency/errors/` | **réutilisées** |
| Moteur de migration (préflight / apply / rollback / gardes) | `scripts/migrate-sprint3-wave4-indexes.ts` | **importé** par la migration Vague 5 |
| Politique d'accès `canPurchaseTicket` | `modules/events/event-access.policy.ts` | **réutilisée** |
| Réservation atomique `$expr` sur billets gratuits | `tickets.service.ts#purchase` | inchangée |
| Finalisation Stripe durable (lease + `stripe_payment_finalizations`) | `payments.service.ts` | **inchangée** (voir §11) |

**Aucune abstraction existante n'a été dupliquée. La Vague 4 n'a pas été réécrite.**

### 1.3 Ce qui manquait réellement

| Manque | Impact |
|---|---|
| Aucun concept de **commande** | `TicketPurchase` = billet ; rien ne représente l'intention d'achat, ses lignes, son montant, son état |
| Aucune **réservation temporaire** | `TicketType` n'a que `quantity` / `sold` : le stock ne peut être bloqué pendant un paiement |
| Aucune **machine d'état** de commande | rien n'interdit une transition incohérente |
| Aucune **abstraction de paiement** | Stripe est instancié directement dans `PaymentsService` ; le domaine n'est pas testable sans Stripe |
| Aucun **mécanisme d'expiration** | conséquence directe de l'absence de réservation |
| Aucun **ordonnanceur** (`@nestjs/schedule`, BullMQ, broker) | information déterminante pour le choix du mécanisme d'expiration (§6) |

---

## 2. Décisions d'architecture

### D1 — Introduire `TicketOrder` plutôt que surcharger `TicketPurchase`

`TicketPurchase` est aujourd'hui **un billet** : un document par admission, avec
son `qrCode` unique, son `status` de scan et son `scannedAt`. Y ajouter les
lignes de commande, le montant total, l'état de paiement et l'expiration
aurait mélangé trois concepts dans un seul document, et aurait rendu
impossible la relation « une commande → N billets ».

Le modèle retenu sépare :

```
TicketOrder     la commande      (lignes, montants, état, paiement, expiration)
TicketHold      la réservation   (capacité bloquée, une par ligne)
TicketPurchase  l'admission      (le billet, inchangé + champ `order`)
```

Évolution **incrémentale et non destructive** de l'existant : `TicketPurchase`
gagne un champ optionnel `order` (null pour les billets gratuits et pour le
chemin Stripe historique) ; aucun champ n'est retiré ni transformé.

### D2 — `reserved` sur `TicketType` plutôt qu'un agrégat calculé

Compter les holds actifs à la volée aurait exigé une agrégation à chaque
tentative de réservation, sans possibilité de filtre conditionnel atomique sur
un document unique. `reserved` est un compteur sur le même document que `sold`
et `quantity` : l'invariant complet est alors vérifiable dans **un seul filtre
atomique**.

Robustesse aux documents antérieurs : toutes les expressions utilisent
`$ifNull: ['$reserved', 0]`. La correction **ne dépend pas** du backfill.

### D3 — Expiration paresseuse, sans ordonnanceur

Voir §6. Aucune dépendance npm n'a été ajoutée.

### D4 — Le serveur interroge le fournisseur ; il ne reçoit pas de verdict

Il n'existe aucun endpoint acceptant un statut de paiement. `sync-payment` est
un **déclencheur** : le serveur appelle `getPaymentStatus` et applique la
transition. Conséquence : le fournisseur de test ne peut jamais servir à
« marquer une commande comme payée » par le client.

### D5 — Stripe conservé sur son chemin historique

Voir §11.

---

## 3. Modèles

### `TicketOrder` — collection `ticket_orders`

| Champ | Type | Note |
|---|---|---|
| `buyerId` | ObjectId → User | identité serveur (`user.sub`) |
| `event` | ObjectId → Event | |
| `lines[]` | `{ ticketTypeId, quantity, unitPrice, lineTotal }` | prix figé à la création |
| `currency` | string | `cad` |
| `totalAmount` | int (cents) | |
| `status` | enum | `PENDING_PAYMENT` / `PAID` / `FAILED` / `EXPIRED` / `CANCELLED` |
| `payment` | `{ provider, reference, status, checkoutUrl, lastSyncedAt }` | référence jamais exposée au client |
| `expiresAt` | Date | aligné sur les holds |
| `paidAt` / `failedAt` / `expiredAt` / `cancelledAt` | Date \| null | audit |
| `admissionIds[]` | ObjectId → TicketPurchase | vide tant que non `PAID` |
| `failureReason` | string \| null | code stable, jamais un message fournisseur brut |
| `requiresManualReview` | boolean | escalade (§8) |
| `lateSettlement` | sous-document \| null | trace du règlement tardif |
| `creationKeyHash` | string \| null | SHA-256 ; la clé brute n'est jamais persistée |

`autoIndex: false` — les index ne sont jamais créés au démarrage.

### `TicketHold` — collection `ticket_holds`

`orderId`, `eventId`, `ticketTypeId`, `quantity`, `status`
(`ACTIVE` / `CONSUMED` / `EXPIRED` / `RELEASED`), `expiresAt`, `consumedAt`, `releasedAt`.

**Aucun TTL** sur ce document (§6).

### Modifications de modèles existants

| Modèle | Changement | Destructif ? |
|---|---|---|
| `TicketType` | `+ reserved: number` (défaut 0, min 0) | non — champ additif |
| `TicketPurchase` | `+ order: ObjectId \| null` (défaut null) | non — champ additif |

Aucun champ supprimé, aucun champ transformé, aucun index existant supprimé.

---

## 4. Machine d'état

```
PENDING_PAYMENT ──▶ PAID
PENDING_PAYMENT ──▶ FAILED
PENDING_PAYMENT ──▶ EXPIRED
PENDING_PAYMENT ──▶ CANCELLED

PAID / FAILED / EXPIRED / CANCELLED  ──▶  (aucune sortie)
```

`PAID → PENDING_PAYMENT` est impossible : vérifié par test exhaustif sur
l'ensemble du produit cartésien des états.

La table (`ticket-order.state-machine.ts`) exprime l'intention.
**La garantie effective vient de la base** : chaque transition est un
`findOneAndUpdate` filtré sur le statut courant, à l'intérieur d'une transaction.
Si le filtre ne correspond plus, la transaction entière est annulée.

Machine d'état du hold : `ACTIVE → CONSUMED | RELEASED | EXPIRED`, états
terminaux définitifs → consommation unique, libération unique.

---

## 5. Réservation atomique

```
findOneAndUpdate(
  { _id, isFree: false,
    $expr: { $lte: [ { $add: [ sold+reserved , quantity_demandée ] }, '$quantity' ] } },
  { $inc: { reserved: quantity_demandée } },
  { session }
)
```

| Opération | Filtre | Effet |
|---|---|---|
| Réserver | `sold + reserved + q <= quantity` | `reserved += q` |
| Consommer | `reserved >= q` | `reserved -= q`, `sold += q` |
| Libérer | `reserved >= q` | `reserved -= q` |

- Aucune lecture-puis-écriture non conditionnelle.
- Aucun mutex / `Map` / `Set` process comme garantie.
- Correct avec N instances API (vérifié, scénario J).

---

## 6. Expiration — mécanisme explicite

**Constat d'audit déterminant** : ni `@nestjs/schedule`, ni BullMQ, ni broker,
ni file ne sont présents dans le projet. Introduire l'un d'eux pour un balayage
trivial aurait été une infrastructure prématurée.

**Un TTL MongoDB a été explicitement écarté** : il supprime un document mais
n'exécute aucune transaction de compensation. La capacité `reserved` serait
perdue définitivement.

Mécanisme retenu :

| Mécanisme | Déclenchement | La correction en dépend ? |
|---|---|---|
| **Expiration paresseuse** | à chaque création de commande, avant toute évaluation de disponibilité des types de billets demandés | **OUI** |
| **Balayage explicite** | `POST /ticket-orders-maintenance/expire` (admin) | non |

Chaque expiration s'exécute dans sa propre transaction, sous double filtre
`status = PENDING_PAYMENT` **ET** `expiresAt <= now` :

- une commande encore valide ne peut pas être expirée par erreur ;
- une commande déjà expirée ne peut pas l'être une seconde fois ;
- le balayage est interruptible et rejouable sans effet cumulatif.

**Durée configurable** : `PAID_TICKET_HOLD_MINUTES`, source unique dans
`src/config/ticketing-environment.ts`, bornée à `[1, 120]`.
Défaut **15 minutes** — valeur DEV raisonnable, **pas une décision commerciale**.

---

## 7. Idempotence

`shared/consistency` est réutilisé **sans aucun second système**.

| Scope | `actorId` | Clé |
|---|---|---|
| `ticket-order-create` | `buyerId` | en-tête `Idempotency-Key` (client) |
| `ticket-order-settle` | `orderId` | `<référence fournisseur>:SUCCEEDED` (**dérivée côté serveur**) |

Comportement contractuel vérifié :

| Cas | Résultat |
|---|---|
| même clé + même payload | même commande, opération exécutée une seule fois |
| même clé + payload différent | `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` |
| clé différente | nouvelle tentative légitime |
| clé absente | `400 IDEMPOTENCY_KEY_REQUIRED` |

### Ce qui est garanti — et ce qui ne l'est pas

```
livraison at-least-once  +  traitement idempotent  +  contraintes de base
= UN SEUL effet métier
```

**Aucun transport exactly-once n'est promis.** Au-delà de la rétention de 90
jours de l'idempotence générique, la protection subsiste : la transition
`PENDING_PAYMENT → PAID` est conditionnelle et l'index unique sur
`payment.reference` reste permanent.

---

## 8. Paiement confirmé après clôture — ⚠️ DÉCISION PRODUIT REQUISE

**Comportement implémenté (mécanisme de sécurité, pas politique commerciale) :**

Si le fournisseur confirme un succès alors que la commande est `EXPIRED`,
`CANCELLED` ou `FAILED` :

1. **aucune admission n'est créée** ;
2. **aucun stock n'est consommé** — la capacité a pu être revendue ;
3. la commande passe `requiresManualReview = true` et enregistre un
   sous-document `lateSettlement` (idempotent : écrit une seule fois) ;
4. un log critique est émis (`TICKET_ORDER_LATE_PAYMENT_REQUIRES_REVIEW`) ;
5. l'appel retourne `409 TICKET_ORDER_LATE_PAYMENT_REQUIRES_REVIEW`.

Ce comportement est le seul **sûr** : il refuse de ressusciter une capacité
potentiellement revendue.

### 🛑 STOP — ce qui N'A PAS été décidé et n'a pas été inventé

La **résolution** d'un règlement tardif est une décision produit absente de
l'existant. Trois options mutuellement exclusives, aux conséquences
commerciales et légales différentes :

| Option | Conséquence |
|---|---|
| **A. Remboursement automatique** | l'acheteur est remboursé sans intervention ; nécessite l'opération `refund` chez le fournisseur, hors périmètre Vague 5 |
| **B. Honorer si la capacité le permet** | réémettre les billets uniquement si `sold + reserved + q <= quantity` ; sinon, retomber sur A ou C |
| **C. Traitement manuel** | un opérateur tranche au cas par cas depuis une file de revue |

**Éléments également non tranchés** : délai de traitement attendu, canal de
notification à l'acheteur, responsabilité (organisateur ou plateforme) du
remboursement et des frais.

Ces décisions doivent être prises avant l'activation de Stripe. Le code actuel
échoue proprement et conserve toute l'information nécessaire à n'importe
laquelle des trois options.

---

## 9. Abstraction de paiement

```typescript
interface PaymentProvider {
  readonly name: 'test' | 'stripe';
  createPayment(input): Promise<PaymentHandle>;
  getPaymentStatus(reference): Promise<ProviderPaymentStatus>;
  cancelPayment(reference): Promise<void>;
}
```

Contrat minimal dérivé des trois moments réels du flux. Volontairement absents :
remboursement, payout, capture différée — aucun cas d'usage en Vague 5.

Statuts normalisés : `PENDING` / `SUCCEEDED` / `FAILED` / `CANCELLED`.
Toute combinaison fournisseur inconnue est traduite en `PENDING` : le domaine
préfère laisser expirer une commande plutôt que d'émettre un billet à tort.

### Sélection — décision serveur uniquement

```
PAID_CHECKOUT_ENABLED=true            → Stripe
sinon, fournisseur de test autorisé   → TestPaymentProvider
sinon                                 → 503 PAID_CHECKOUT_NOT_READY
```

Le client ne choisit jamais son fournisseur. Une commande créée avec un
fournisseur ne peut pas être réglée par un autre (`resolveByName` vérifie
l'autorisation courante).

**En Vague 5, `PAID_CHECKOUT_ENABLED` reste `false` : aucun paiement réel
n'est possible.** Hors `ELINTYS_ENV=dev`, aucune commande payante ne peut être
créée du tout.

---

## 10. TestPaymentProvider

Scénarios déterministes : `SUCCESS`, `DECLINED`, `CANCELLED`, `TIMEOUT`,
`DELAYED_SUCCESS`, `DUPLICATE_CALLBACK`.

**Sans état persistant** : le scénario et l'horodatage sont encodés dans la
référence (`testpay:SCENARIO:orderId:createdAtMs`). Deux instances API
calculent donc le même statut, sans collection dédiée ni mémoire de processus.

`checkoutUrl` est **toujours `null`** : rien ne doit ressembler à un vrai
paiement du point de vue du participant.

### Encadrement de sécurité — trois protections indépendantes

1. **L'API refuse de démarrer** si `TEST_PAYMENT_PROVIDER_ENABLED=true` hors
   `ELINTYS_ENV=dev` / avec `NODE_ENV=production`
   (`resolveTestPaymentProviderEnabled` lève au chargement de la configuration).
   Un environnement mal configuré ne démarre pas « à moitié activé ».
2. **Défense en profondeur** : chaque appel du provider revérifie l'autorisation.
3. **Aucune autorité client** : le scénario n'influence que le fournisseur
   simulé ; il est rejeté (`400`) dès qu'un autre fournisseur est sélectionné,
   et aucun endpoint n'accepte de statut de paiement.

`render.yaml` n'a **pas** été modifié : ni `PAID_CHECKOUT_ENABLED` ni
`TEST_PAYMENT_PROVIDER_ENABLED` n'y figurent, donc les environnements déployés
sont fermés par défaut.

---

## 11. Stripe — état exact

| Élément | État |
|---|---|
| `PaymentsService.createCheckoutSession` + webhook + `stripe_payment_finalizations` | **inchangés** |
| Paiement participant | **fermé** (`PAID_CHECKOUT_ENABLED=false`) |
| Paiement réel effectué | **aucun** |
| Production | **non touchée** |
| `StripePaymentProvider` (nouveau) | adaptateur conforme au contrat, testé avec un client Stripe simulé, **jamais sélectionné** tant que le drapeau est `false` |

**Choix délibéré** : le chemin Stripe historique n'a **pas** été réécrit pour
passer par `TicketOrder`. Le faire aurait touché la finalisation durable
validée en Vague 4 sans possibilité de la tester contre le vrai Stripe dans
cette vague — donc un risque de régression sans contrepartie. La migration du
webhook Stripe vers le flux commande/hold est listée en §16.

---

## 12. Index et migration

### Index créés (7)

| Collection | Index | Type |
|---|---|---|
| `ticket_orders` | `ticket_orders_by_buyer` `{buyerId:1, createdAt:-1}` | listing |
| `ticket_orders` | `ticket_orders_pending_expiry` `{status:1, expiresAt:1}` | balayage |
| `ticket_orders` | `ticket_orders_by_event` `{event:1, status:1}` | vue organisateur |
| `ticket_orders` | `ticket_orders_unique_payment_reference` `{'payment.reference':1}` | **unique partiel** |
| `ticket_holds` | `ticket_holds_unique_order_line` `{orderId:1, ticketTypeId:1}` | **unique** |
| `ticket_holds` | `ticket_holds_active_by_type` `{ticketTypeId:1, status:1, expiresAt:1}` | expiration |
| `ticketpurchases` | `ticket_purchases_by_order` `{order:1}` | sparse |

**Aucun TTL déclaré** — vérifié par test.

### Procédure exécutée

| Étape | Résultat |
|---|---|
| Backup `elintys-dev` | `backups/paid-ticketing-wave5/elintys-dev-2026-08-29T04-05-32-052Z` — 405 documents, 19 collections, checksums SHA-256 |
| Dry-run | 7 à créer, **0 conflit**, **0 doublon bloquant**, **0 document invalide**, 52 candidats au backfill |
| Vérification replica set | `atlas-10vwsl-shard-0`, primary writable, sessions disponibles, transactions disponibles |
| Apply (`elintys-dev` uniquement) | 7 index créés, **vérification post-apply réussie**, backfill `reserved:0` sur 52 `tickettypes` |
| Production | **NON exécutée — interdite** |

### Backfill `tickettypes.reserved = 0`

Additif et non destructif : filtre `{ reserved: { $exists: false } }`, jamais
d'écrasement d'une valeur existante. **La correction du domaine n'en dépend
pas** (`$ifNull` partout).

### Rollback

`npm run sprint3-wave5:migrate -- --rollback` supprime **uniquement** les 7
index nommés ci-dessus. Le champ `reserved` n'est volontairement **pas** retiré :
supprimer un champ est destructif et reste une opération manuelle assumée.

### Gardes héritées de la Vague 4

`ELINTYS_ENV === 'dev'` **ET** base connectée nommée exactement `elintys-dev`.
L'URI Mongo n'est jamais lue ni logguée en clair. Refus si des transactions ne
sont pas disponibles, si un conflit de spec existe, ou si des documents
invalides sont détectés.

---

## 13. Tests de concurrence

### 13.1 En CI, sans MongoDB (déterministes)

Un modèle en mémoire reproduit **la seule propriété dont dépend la
correction** : l'atomicité MongoDB au niveau d'un document, avec sérialisation
des sections critiques et rollback transactionnel.

### 13.2 Sur MongoDB RÉEL — preuve

`npm run wave5:concurrency` exécute les 10 scénarios contre `elintys-dev`
(replica set, vraies transactions, vrais index uniques), avec **deux contextes
applicatifs distincts** pour simuler deux instances API.

**Résultat : 10/10 réussis** (exécuté deux fois, résultats identiques).

| # | Scénario | Résultat observé |
|---|---|---|
| A | stock restant 1, deux acheteurs concurrents | 1 réussite, `reserved = 1` |
| B | même acheteur, double clic (même clé) | même commande, `reserved = 2` |
| C | même clé, 3 appels simultanés | **1 seule** commande en base |
| D | deux clés distinctes | 2 commandes, `reserved = 2` |
| E | expiration simultanée + tentative d'achat | commande `EXPIRED`, invariant tenu |
| F | callback succès répété | 2 admissions, `sold = 2`, `reserved = 0` |
| G | callbacks succès concurrents (×3) | **2 admissions**, pas 6 |
| H | échec après réservation | `reserved = 0`, hold `RELEASED` |
| I | rollback pendant finalisation | commande restée `PENDING_PAYMENT`, **0 admission** |
| J | deux instances logiques | 1 réservation, 1 admission, `sold = 1` |

Le script ne supprime que les documents qu'il a lui-même créés, par `_id`
explicite. Vérification post-exécution : la base est revenue exactement à ses
compteurs d'origine (226 events / 52 tickettypes / 26 users / 4 ticketpurchases
/ 9 idempotent_operations), **0 résidu**, **0 violation d'invariant**.

---

## 14. Invariants prouvés

| Invariant | Preuve |
|---|---|
| `sold >= 0` | filtres conditionnels + `min: 0` ; vérifié dans tous les scénarios |
| `reserved >= 0` | filtre `reserved >= q` sur consommation et libération |
| `sold + reserved <= quantity` | filtre `$expr` de réservation ; vérifié après chaque scénario A–J et sur les 52 `tickettypes` de `elintys-dev` (0 violation) |
| une réservation n'est consommée qu'une fois | transition `ACTIVE → CONSUMED` conditionnelle (scénarios F, G, I) |
| une réservation n'est libérée qu'une fois | transition `ACTIVE → RELEASED/EXPIRED` conditionnelle (scénarios E, H) |
| une commande payée n'est finalisée qu'une fois | transition `PENDING_PAYMENT → PAID` conditionnelle + idempotence (F, G) |
| un même callback logique ne crée jamais deux admissions | scénarios F et G : 2 admissions attendues, 2 obtenues |

---

## 15. Limites et risques connus

| Limite | Impact | Atténuation |
|---|---|---|
| Politique de règlement tardif non tranchée | commandes en `requiresManualReview` sans traitement automatisé | §8 — décision produit requise avant Stripe |
| Aucune file de revue exposée | un opérateur doit interroger la base | endpoint/écran à prévoir avec la décision §8 |
| Pas d'email de confirmation sur le flux commande | l'acheteur n'est pas notifié hors interface | volontaire (§17) ; à ajouter avec l'activation Stripe |
| Balayage d'expiration manuel | commandes abandonnées sur des types de billets jamais relus | **la correction n'en dépend pas** (expiration paresseuse) ; un ordonnanceur pourra appeler l'endpoint admin |
| `StripePaymentProvider` non validé contre le vrai Stripe | risque au moment de l'activation | testé avec un client simulé ; validation réelle = étape d'activation |
| Chemin Stripe historique non migré | deux chemins de finalisation coexistent | l'un des deux est fermé par drapeau ; §16 |
| Lease d'idempotence de 5 min (Vague 4) | inchangé | déjà documenté en Vague 4 |
| `throttling.e2e-spec.ts` instable sous forte charge CPU | faux négatif possible en CI chargée | **préexistant**, sans lien avec la Vague 5 — détail et reproduction en §20 |

---

## 16. Éléments restant pour Stripe

1. **Trancher la politique de règlement tardif** (§8) — bloquant.
2. Migrer le webhook `checkout.session.completed` vers le flux
   commande/hold : retrouver la commande par `metadata.orderId`, puis appeler
   la finalisation. Le webhook devient un simple déclencheur.
3. Ajouter l'opération `refund` au contrat `PaymentProvider` si l'option A de §8
   est retenue.
4. Décider et documenter la durée définitive de `PAID_TICKET_HOLD_MINUTES`
   (défaut DEV actuel : 15 min) et l'aligner sur `expires_at` de Stripe
   (Stripe impose un minimum de 30 minutes pour `expires_at` — **à vérifier**
   avant activation, car une durée de hold plus courte que l'expiration Stripe
   crée mécaniquement des règlements tardifs).
5. Email de confirmation sur le flux commande.
6. Écran/endpoint de revue manuelle.
7. Validation de bout en bout en mode test Stripe, puis ouverture progressive
   de `PAID_CHECKOUT_ENABLED`.

---

## 17. Volontairement NON implémenté

| Élément | Raison |
|---|---|
| Activation de `PAID_CHECKOUT_ENABLED` | interdit par le cadrage |
| Paiement réel Stripe | interdit par le cadrage |
| Migration du webhook Stripe vers `TicketOrder` | risque de régression sans validation Stripe possible (§11) |
| Remboursement / payout / scanner | hors périmètre explicite |
| Email de confirmation de commande | effet externe non requis par le cœur transactionnel |
| Ordonnanceur / broker / file | infrastructure prématurée (§6) |
| Modification du frontend | §18 |
| Migration en production | interdite |
| Retrait du champ `reserved` au rollback | opération destructive |

---

## 18. Frontend

**Aucune modification apportée à `Elintys-web`.**

Vérification effectuée : `EventPageClient.tsx` désactive déjà tout billet
payant (`paidUnavailable = !ticketType.isFree`) et affiche
`participationCopy.paidUnavailableBadge`. Le checkout payant participant est
donc **déjà fermé côté interface** ; aucun changement n'était nécessaire pour
respecter la contrainte, et toute simulation de paiement resterait invisible
pour un participant.

L'API est prête pour l'intégration : les endpoints, les codes d'erreur stables
et les vues de commande sont documentés en §19. La QA UI/UX revient à Codex.

---

## 19. Endpoints

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/ticket-orders` | JWT + `Idempotency-Key` | créer une commande, réserver le stock |
| `GET` | `/ticket-orders/me` | JWT | mes commandes (paginé) |
| `GET` | `/ticket-orders/:id` | JWT (propriétaire) | suivi d'une commande |
| `POST` | `/ticket-orders/:id/sync-payment` | JWT (propriétaire) | demander l'issue au fournisseur |
| `POST` | `/ticket-orders/:id/cancel` | JWT (propriétaire) | annuler et libérer la capacité |
| `POST` | `/ticket-orders-maintenance/expire` | JWT + rôle `admin` | balayage d'expiration |

**Aucun endpoint de simulation de paiement n'est exposé.** Le scénario de test
transite par le DTO de création et n'est accepté que lorsque le fournisseur
simulé est autorisé.

### Champs d'autorité rejetés

`buyerId`, `participantId`, `paymentStatus`, `paid`, `sold`, `reserved`,
`status`, `totalAmount` — rejetés par `ValidationPipe`
(`whitelist` + `forbidNonWhitelisted`), vérifié en E2E.
L'identité provient exclusivement de `user.sub`.

### Codes d'erreur ajoutés

`TICKET_ORDER_NOT_FOUND`, `TICKET_ORDER_LINE_DUPLICATE`,
`TICKET_ORDER_MIXED_EVENTS`, `TICKET_ORDER_PAID_TICKET_REQUIRED`,
`TICKET_ORDER_ADMISSION_NOT_AVAILABLE`, `TICKET_ORDER_NOT_PENDING`,
`TICKET_ORDER_LATE_PAYMENT_REQUIRES_REVIEW`,
`TICKET_ORDER_SCENARIO_NOT_ALLOWED`, `PAYMENT_PROVIDER_UNAVAILABLE`.

---

## 20. Résultats des gates

| Gate | Commande | Résultat |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 erreur, 0 avertissement |
| Typecheck | `npm run typecheck` | ✅ 0 erreur |
| Build | `npm run build` | ✅ |
| Tests unitaires | `npm test` | ✅ **872/872** (716 avant → +156) |
| Couverture | `npm run test:cov` | ✅ 73,49 % stmts / 65,82 % branches / 70,22 % fonctions / 74,27 % lignes — **aucun seuil abaissé** |
| E2E | `npm run test:e2e` | ✅ **49/49** (29 avant → +20) — voir note de flakiness ci-dessous |
| Concurrence MongoDB réel | `npm run wave5:concurrency` | ✅ **10/10** |
| `git diff --check` | — | ✅ aucun problème d'espaces |
| Secrets / debug / config prod | inspection | ✅ aucun secret, aucun `console.log` hors scripts CLI, `render.yaml` inchangé, `.env` non modifié |

### ⚠️ Flakiness préexistante observée — `throttling.e2e-spec.ts`

Un échec transitoire a été observé **une fois** sur la suite E2E, puis n'a pas
été reproduit sur 17 exécutions séquentielles. Il a ensuite été reproduit
**délibérément** en lançant 6 suites E2E en parallèle sur la même machine :

```
FAIL test/throttling.e2e-spec.ts
  ● Throttling public derrière proxy (e2e)
    › avec un proxy de confiance
      › devrait compter chaque visiteur anonyme séparément
    expect(statuts[200]).toBe(TIER_TEST.limit)   Expected: 5, Received: 4
    at test/throttling.e2e-spec.ts:121
```

**Diagnostic** : test sensible au temps (fenêtre de rate-limiting) qui échoue
sous forte contention CPU. Il s'agit d'un test **préexistant à la Vague 5** ;
il ne touche ni la billetterie, ni les commandes, ni les paiements. Aucun test
de la Vague 5 n'a été observé instable (les nouveaux tests E2E sont des tests
de contrat purs, sans dépendance temporelle).

**Aucun test n'a été skippé, désactivé ou assoupli pour obtenir du vert.**
Ce point est signalé tel quel à Codex : il mérite un durcissement du test de
throttling, hors périmètre de cette vague.

Couverture des nouveaux fichiers métier :
`src/modules/tickets/orders` 94,15 % stmts · `src/modules/payments/providers` 93,79 % stmts ·
`ticketing-environment.ts` 100 % · `error-codes.ts` 100 %.

---

*Fin du rapport d'implémentation — Vague 5.*
