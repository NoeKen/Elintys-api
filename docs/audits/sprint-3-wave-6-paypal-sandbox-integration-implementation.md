# Sprint 3 / Vague 6 — PayPal Sandbox Integration
## Rapport d'implémentation

**Date** : 2026-08-29
**Auteur** : Claude Code (Opus 5) — implémenteur
**Branches** : `feat/s3-wave6-paypal-sandbox-integration` (API et Web)
**Base** : `origin/dev` — API `370f8dc`, Web `cb8c645`

> **PayPal Sandbox externe réellement exécuté : NON.**
> Aucune credential PayPal n'est disponible dans cet environnement. Voir §13.

---

## 1. Pré-audit

### 1.1 État au démarrage

| Élément | Constat |
|---|---|
| Vague 5 | **committée sur `dev`** dans les deux repos |
| Worktrees | propres, aucun travail en cours |
| Synchronisation | `origin/dev` = HEAD local, 0 en avance / 0 en retard |
| API | 998 tests unitaires, 49 E2E |
| Web | 244 tests unitaires |
| MongoDB dev | `elintys-dev`, replica set, transactions disponibles |
| Credentials PayPal | **absentes** — `.env` ne contient que Stripe |

### 1.2 Socle réutilisé sans modification

`TransactionService`, `IdempotencyService`, `CriticalOperationLogger`, erreurs
normalisées, moteur de migration des Vagues 4/5, politique d'accès
`canPurchaseTicket`, machine d'état `TicketOrder`/`TicketHold`, invariants de
stock. **Aucune abstraction dupliquée, aucune garantie de Vague 5 cassée.**

### 1.3 Ce qui manquait

| Manque | Conséquence |
|---|---|
| Aucun adaptateur PayPal | le flux payant réel était inatteignable |
| Contrat `PaymentProvider` en une seule étape | PayPal sépare approbation et capture |
| Aucune vérification de montant réglé | un fournisseur rapportant un autre montant aurait été honoré |
| Aucune déduplication de webhook fournisseur | un rejeu aurait pu être retraité |
| Aucune contrainte sur la référence de règlement | une capture aurait pu finaliser deux commandes |

---

## 2. Architecture

```
Ticketing Domain  (inchangé dans ses invariants)
      │
      ▼
PaymentProvider
      ├── PayPalPaymentProvider    Orders v2 — Sandbox (Vague 6)
      ├── TestPaymentProvider      simulation déterministe
      ├── StripePaymentProvider    inactif
      └── futurs fournisseurs      aucun impact sur le domaine
```

**PayPal est un adaptateur, pas le domaine.** Le domaine ne manipule jamais un
objet `order`, `capture`, `payer` ni un payload de webhook PayPal : tout est
traduit une seule fois vers des types internes (`PayPalOrderSnapshot`).

Aucun cycle de modules : `PaymentProvidersModule` ne dépend d'aucun module
métier ; `PaymentsModule` (webhook) dépend de `TicketsModule`.

---

## 3. Extension du contrat — justification

Une seule extension, **optionnelle** :

```typescript
confirmPayment?(input: { reference, orderId }): Promise<PaymentHandle>;
```

Motif : certains fournisseurs séparent l'approbation de l'acheteur du transfert
effectif des fonds. C'est un concept générique de « règlement en deux temps »,
pas une notion PayPal. Les fournisseurs en une étape ne l'implémentent pas et
sont inchangés. `PaymentHandle` gagne trois champs optionnels décrivant le
règlement (référence, montant, devise).

---

## 4. Flux implémenté

```
authentification participant
   ↓
validation événement + type de billet (admission paid_ticket, politique d'accès)
   ↓
TicketOrder créé + TicketHold + reserved incrémenté   [TRANSACTION MONGO]
   ↓
création de la commande PayPal                        [HORS TRANSACTION]
   ↓
référence fournisseur persistée (si encore null)
   ↓
redirection vers l'URL d'approbation PayPal
   ↓
approbation de l'acheteur (Sandbox)
   ↓
retour navigateur → la page demande au SERVEUR de synchroniser
   ↓
capture déclenchée par le serveur                     [HORS TRANSACTION]
   ↓
vérification du montant réglé vs TicketOrder
   ↓
PAID + Hold CONSUMED + reserved→sold + admissions     [TRANSACTION MONGO]
   ↓
webhook PayPal vérifié → même synchronisation, sans effet supplémentaire
```

**Aucun appel réseau n'a lieu à l'intérieur d'une transaction MongoDB.**

**TicketOrder toujours avant PayPal** : jamais l'inverse.

---

## 5. OAuth

Client credentials, jeton en **mémoire uniquement** (jamais persisté), cache
jusqu'à expiration moins une marge de 60 s, promesse partagée entre appels
concurrents (un seul aller-retour), purge sur 401, timeout dur de 10 s,
reprises bornées (3 tentatives) avec back-off exponentiel sur erreurs
transitoires uniquement — jamais sur une erreur métier 4xx.

Ne sont jamais journalisés : `client_secret`, jeton, en-tête `Authorization`,
corps de réponse. Les erreurs PayPal sont traduites en codes stables
(`PAYPAL_API_ERROR:<status>:<issue>`), le corps brut ne remonte jamais.

---

## 6. Montants

Le domaine conserve des unités mineures entières. Conversion déterministe et
**exactement réversible** vers le format décimal PayPal (4995 ↔ `"49.95"`).
Le montant provient exclusivement du TicketOrder serveur.

**Vérification avant finalisation** : si le montant ou la devise réglés
divergent du TicketOrder, aucune admission n'est créée, aucun stock n'est
consommé ; la commande passe `requiresManualReview` et l'erreur stable
`TICKET_ORDER_SETTLEMENT_MISMATCH` est renvoyée.

---

## 7. Idempotence — quatre niveaux distincts

| Niveau | Mécanisme |
|---|---|
| A. Elintys (création) | `IdempotencyService` — `Idempotency-Key` client, scope `ticket-order-create` |
| B. PayPal (création/capture) | en-tête `PayPal-Request-Id` + `invoice_id` unique par marchand |
| C. Déduplication webhook | index unique `eventId` + bail de traitement |
| D. Unicité en base | `ticket_orders_unique_settlement_reference` (unique partiel) |

```
livraison at-least-once + traitement idempotent + contraintes de base
= UN SEUL effet métier
```

Aucun exactly-once de transport n'est promis.

---

## 8. Webhook

Endpoint : `POST /api/v1/payments/paypal/webhook` (public — PayPal ne porte pas
de JWT).

**Vérification officielle** via `/v1/notifications/verify-webhook-signature`
avec le `webhook_id` **configuré côté serveur**. Un corps JSON plausible n'est
jamais suffisant.

Rejets testés : en-têtes manquants (les cinq), en-tête vide, certificat hors
domaine PayPal (rejeté **sans appeler PayPal**), corps non JSON, événement sans
id ou sans type, signature invalide, corps modifié après signature, webhook_id
incorrect, statut de vérification inattendu, PayPal injoignable.

Réponses : **200** authentifié et pris en charge (traité, doublon ou ignoré) ;
**400 `WEBHOOK_NOT_AUTHENTIC`** message uniforme, la raison n'est pas divulguée ;
**503** vérification indisponible ou traitement échoué → PayPal rejouera.

### Événements traités — périmètre étroit

| Événement | Effet |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | déclenche la synchronisation serveur (capture) |
| `PAYMENT.CAPTURE.COMPLETED` | finalisation métier |
| `PAYMENT.CAPTURE.DENIED` | libération de la réservation |
| `PAYMENT.CAPTURE.REFUNDED` | constaté, hors périmètre — revue manuelle |

Tout le reste est enregistré puis **ignoré explicitement**. Pas de gestionnaire
fourre-tout.

### Trois identifiants, jamais confondus

`resource.id` est l'**Order ID** sur `CHECKOUT.ORDER.*`, mais le **Capture ID**
sur `PAYMENT.CAPTURE.*`, où l'Order ID vit dans
`supplementary_data.related_ids`. Le Webhook Event ID est distinct des deux.

Le `custom_id` n'est jamais l'autorité : la commande est résolue par sa
référence fournisseur en base.

---

## 9. Expiration et règlement tardif

L'ordre d'évaluation dans `synchronize()` a été rendu explicite :

1. commande close → **lecture d'état seule, jamais de capture** ;
2. réservation expirée → lecture, expiration, puis politique de règlement tardif ;
3. commande vivante → capture autorisée.

Sans cet ordre, une capture aurait pu prélever des fonds pour une capacité déjà
revendue.

La politique safe de Vague 5 est conservée intégralement : un règlement arrivant
après `EXPIRED`, `CANCELLED` ou `FAILED` ne ressuscite rien, ne consomme aucun
stock, ne crée aucun billet ; la commande est marquée `requiresManualReview`
avec un sous-document `lateSettlement`, et un 409 stable est renvoyé.

**Écart documenté** : la durée de validité d'une commande PayPal n'est pas
alignable finement sur `PAID_TICKET_HOLD_MINUTES`. Une commande PayPal peut donc
rester capturable après l'expiration du hold Elintys — c'est précisément le cas
que la politique de règlement tardif absorbe. Réduire cette fenêtre avant tout
passage en live (§16).

---

## 10. Frontend

| Surface | Comportement |
|---|---|
| Page événement | CTA « Acheter mon billet » ; disponibilité = `quantity - sold - reserved` |
| Modal d'achat | crée la commande serveur, puis redirige vers l'approbation |
| Double clic | clé d'idempotence **stable** par tentative → une seule commande |
| Redirection | URL validée (https + domaine fournisseur) avant d'être suivie |
| `/paiement/succes` | interroge le serveur, polling **borné** (6 × 2,5 s) puis reprise manuelle |
| `/paiement/annule` | **aucun** message « aucun montant débité » ; état demandé au serveur |
| Revue manuelle | formulation non technique, sans promesse de remboursement |
| Ma participation | surface existante réutilisée, aucun second espace billets |

**UX cohérente et unique** : redirection vers l'approbation. **Aucun SDK PayPal
n'est chargé côté client** — donc aucun script tiers dans le bundle, et la
question du chargement global (§30/§47) ne se pose pas.

Un `order_id` malformé est ignoré (validation ObjectId) plutôt que transmis.

Aucune chaîne codée en dur : 29 clés `participation.payment` + 7 codes d'erreur,
à parité `fr`/`en`.

---

## 11. Sécurité

| Vecteur | Traitement | Testé |
|---|---|---|
| Webhook forgé / en-têtes falsifiés | vérification officielle PayPal obligatoire | ✅ |
| Rejeu et doublon de webhook | index unique + bail | ✅ |
| Order ID / Capture ID falsifiés | résolution serveur par référence en base | ✅ |
| Usurpation d'acheteur | identité = `user.sub`, ownership côté service | ✅ (Vague 5) |
| Altération de prix / devise | montant serveur + vérification du montant réglé | ✅ |
| IDOR sur TicketOrder | 404 si non propriétaire | ✅ (Vague 5) |
| Contournement du kill switch | double interrupteur, serveur autorité | ✅ |
| Confusion sandbox / live | refus de démarrage + `assertSandbox()` | ✅ |
| Fuite de client secret / jeton OAuth | jamais journalisés, jamais persistés | ✅ |
| Redirection ouverte | URL d'approbation validée avant redirection | ✅ |
| Fuite d'erreur PayPal brute | traduction en codes stables | ✅ |
| Injection de fournisseur | `resolveByName` sur liste fermée + drapeaux | ✅ |
| Contournement du TestPaymentProvider | refus de démarrage hors `ELINTYS_ENV=dev` | ✅ (Vague 5) |

---

## 12. Migration

Quatre index, sur `elintys-dev` uniquement, après backup (411 documents,
21 collections, checksums SHA-256) et dry-run (0 conflit, 0 doublon bloquant,
0 document invalide) :

| Collection | Index | Type |
|---|---|---|
| `ticket_orders` | `ticket_orders_unique_settlement_reference` | unique partiel |
| `paypal_webhook_events` | `paypal_webhook_events_unique_event` | unique |
| `paypal_webhook_events` | `paypal_webhook_events_by_order` | observabilité |
| `paypal_webhook_events` | `paypal_webhook_events_ttl` | rétention |

Vérification post-apply réussie. Aucun champ transformé ni supprimé. Aucun TTL
sur `ticket_orders` : la restitution de capacité exige une compensation métier
transactionnelle. **Production : non exécutée, interdite.**

---

## 13. Tests

| Catégorie | État |
|---|---|
| A. Fournisseur simulé | ✅ inchangé, toujours vert |
| B. Contrat PayPal (adaptateur, HTTP, OAuth, montants, traduction) | ✅ 88 tests dédiés |
| C. Vérification de webhook | ✅ 25 tests de rejet et d'acceptation |
| D. **PayPal Sandbox réel** | ❌ **NON EXÉCUTÉ** — aucune credential disponible |
| E. Frontend | ✅ 255 tests unitaires + **13 tests Playwright exécutés** (Axe, clavier, responsive) |

### Ce qui n'a pas été exécuté, honnêtement

Les 13 tests Playwright portent sur les **pages de retour** (`/paiement/succes`,
`/paiement/annule`), publiques et sans dépendance API. Le parcours d'achat
complet en navigateur n'est pas couvert : il exige une approbation PayPal
réelle.

Le flux Sandbox externe complet (login acheteur, approbation, capture réelle,
webhook signé par PayPal) **n'a pas été exécuté** : `.env` ne contient aucune
variable `PAYPAL_*`. Tout le reste est implémenté et testé. Le runbook (§14)
donne la procédure exacte pour l'exécuter dès que des credentials existent.

Je ne prétends pas avoir validé l'intégration contre le vrai PayPal.

---

## 14. Documentation

- `docs/runbooks/paypal-sandbox-payments.md` — création de l'app Sandbox,
  comptes de test, webhook, variables, démarrage local, six scénarios de test,
  kill switch, dépannage, prérequis au passage en live. **Aucun secret.**
- `docs/architecture/paid-ticketing.md` — mis à jour : registre de fournisseurs,
  règlement en deux temps, spécificités PayPal, webhooks.

---

## 15. Résultats des gates

### API

| Gate | Résultat |
|---|---|
| lint | ✅ 0 erreur, 0 avertissement |
| typecheck | ✅ |
| build | ✅ |
| unit | ✅ **1085/1085** (998 avant → +87) |
| coverage | ✅ 74,68 % stmts / 68,19 % branches — **aucun seuil abaissé** |
| E2E | ✅ 49/49 |
| concurrence | ✅ suites Vague 5 inchangées et vertes |
| webhook PayPal | ✅ 38 tests (vérificateur + service + contrôleur) |
| migration dry-run | ✅ 0 conflit |
| scan de secrets | ✅ aucun |
| `git diff --check` | ✅ |

Couverture des nouveaux fichiers : `paypal-environment` 100 %,
`paypal-orders.api` 100 %, `paypal-webhook.controller` 100 %,
`payment-provider.registry` 100 %, `paypal-webhook-event.schema` 100 %,
`paypal-webhook.verifier` 100 % stmts, `paypal-webhook.service` 98,4 %,
`paypal-http.client` 97,9 %, `paypal-money` 97,5 %,
`paypal-payment.provider` 90,6 %.

### Web

| Gate | Résultat |
|---|---|
| lint | ✅ 0 erreur (9 avertissements préexistants, hors périmètre) |
| typecheck | ✅ |
| build | ✅ production |
| unit | ✅ **255/255** (244 avant → +11) |
| `git diff --check` | ✅ |
| Playwright (pages de retour) | ✅ **13/13** |
| Axe WCAG 2.1 A/AA | ✅ **0 critical, 0 serious** |
| responsive 320 → 1538 | ✅ aucun débordement > 1 px |
| clavier / scroll natif | ✅ |

---

## 16. Limites et risques

| Limite | Impact | Atténuation |
|---|---|---|
| **Sandbox externe non exécuté** | l'intégration n'est pas validée contre le vrai PayPal | runbook complet ; à exécuter dès credentials disponibles |
| **Playwright limité aux pages de retour** | le parcours d'achat de bout en bout (événement → approbation → confirmation) n'est pas couvert en E2E navigateur | il exige l'API, MongoDB et une approbation PayPal réelle — donc les credentials Sandbox absentes ; les pages de retour, elles, sont vérifiées (Axe, clavier, responsive) |
| Politique de règlement tardif non tranchée | commandes en `requiresManualReview` sans traitement automatisé | **bloquant avant live** — décision produit héritée de la Vague 5 |
| Durée PayPal non alignable sur le hold | fenêtre de règlement tardif | absorbée par la politique safe ; à réduire avant live |
| Aucun domaine Refund | `PAYMENT.CAPTURE.REFUNDED` est constaté, pas traité | volontaire (§27 du cadrage) |
| Chemin Stripe historique inchangé | deux chemins coexistent | l'un est fermé par drapeau |
| Pas de file de revue manuelle exposée | un opérateur doit interroger la base | à prévoir avec la décision produit |

---

## 17. Volontairement non implémenté

Activation live · paiement réel · domaine Refund complet · scanner · payout ·
SDK PayPal côté client (redirection retenue) · file de revue manuelle ·
alignement fin de la durée PayPal · migration en production.

---

## 18. Commits

| SHA | Message |
|---|---|
| `e4b289e` | feat(payments): add PayPal sandbox provider |
| `3945bfd` | feat(ticketing): finalize PayPal ticket orders |
| `8ea8f4b` | feat(payments): verify PayPal webhook events |
| `b54a7fb` | feat(payments): add wave 6 index migration |
| `e959985` | test(payments): cover PayPal orchestration |
| *(web)* `ff5b271` | feat(web): add PayPal paid ticket journey |
| *(web)* — | test(web): cover PayPal payment return pages |

Aucun merge vers `dev`, aucun force push, aucun reset.

---

*Fin du rapport d'implémentation — Vague 6.*
