# Runbook — Paiements PayPal Sandbox
**Elintys-api / Elintys-web — Sprint 3 / Vague 6**

> **Aucun secret dans ce document.** Tous les identifiants sont des
> placeholders. Les vraies valeurs vivent dans `.env`, jamais versionné.

---

## 1. Préparer l'application PayPal Developer

1. Ouvrir <https://developer.paypal.com/dashboard/> et se connecter.
2. Basculer l'interrupteur en haut à droite sur **Sandbox**.
3. **Apps & Credentials → Create App**
   - Type : *Merchant*
   - Sandbox Business Account : celui proposé par défaut
4. Relever **Client ID** et **Secret** (bouton *Show*).

### Comptes de test

**Testing Tools → Sandbox Accounts.** Deux comptes sont générés :

| Type | Usage |
|---|---|
| Business | encaisse les paiements — c'est le compte lié à l'app |
| Personal | l'acheteur — sert à se connecter pendant l'approbation |

Noter le courriel et le mot de passe du compte **Personal** : ils servent à
chaque test d'achat.

---

## 2. Configurer le webhook

**Apps & Credentials → votre app → Webhooks → Add Webhook.**

- **Webhook URL** : `https://<hôte-joignable>/api/v1/payments/paypal/webhook`
- **Événements à cocher — uniquement ces quatre** :
  - `CHECKOUT.ORDER.APPROVED`
  - `PAYMENT.CAPTURE.COMPLETED`
  - `PAYMENT.CAPTURE.DENIED`
  - `PAYMENT.CAPTURE.REFUNDED`

Relever le **Webhook ID** (format `WH-…`). Il est obligatoire : c'est lui que
l'API transmet à la vérification de signature. Un webhook signé pour un autre
identifiant sera rejeté.

En développement local, exposer le port avec un tunnel HTTPS. L'URL doit être
joignable depuis Internet : PayPal appelle le serveur, pas l'inverse.

---

## 3. Variables d'environnement

Dans `Elintys-api/.env` :

```bash
PAID_CHECKOUT_ENABLED=true      # interrupteur global de caisse
PAYPAL_PROVIDER_ENABLED=true    # interrupteur PayPal
PAYPAL_ENV=sandbox              # jamais 'live' en développement
PAYPAL_CLIENT_ID=<client id sandbox>
PAYPAL_CLIENT_SECRET=<secret sandbox>
PAYPAL_WEBHOOK_ID=WH-<identifiant du webhook>
```

### Ce qui empêche le démarrage (fail-closed)

| Situation | Comportement |
|---|---|
| `PAYPAL_ENV=live` hors `ELINTYS_ENV=prod` + `NODE_ENV=production` | **refus de démarrage**, activé ou non |
| `PAYPAL_PROVIDER_ENABLED=true` sans les trois credentials | **refus de démarrage**, avec le nom des variables manquantes |
| `PAYPAL_ENV` autre que `sandbox`/`live` | **refus de démarrage** |

### Ce qui ferme le paiement sans empêcher le démarrage

| Situation | Comportement |
|---|---|
| `PAID_CHECKOUT_ENABLED=false` | aucune commande payante — 503 `PAID_CHECKOUT_NOT_READY` |
| `PAYPAL_PROVIDER_ENABLED=false` | repli sur Stripe si ouvert, sinon fournisseur de test, sinon 503 |

**Le serveur fait autorité.** Une UI ouverte par erreur ne contourne rien.

---

## 4. Appliquer la migration

```bash
cd Elintys-api
npm run backup:dev -- backups/paypal-wave6     # obligatoire avant toute écriture
npm run sprint3-wave6:migrate                  # dry-run, aucune écriture
npm run sprint3-wave6:migrate -- --apply       # elintys-dev uniquement
```

Rollback des index de cette vague :

```bash
npm run sprint3-wave6:migrate -- --rollback
```

Gardes : `ELINTYS_ENV=dev` **et** base nommée exactement `elintys-dev`.
La production est impossible par construction.

---

## 5. Démarrage local

```bash
# Terminal 1
cd Elintys-api && npm run start:dev

# Terminal 2
cd Elintys-web && npm run dev

# Terminal 3 — tunnel HTTPS vers le port 3001
```

Vérifier au démarrage que l'API ne signale ni refus de configuration ni
`PAYPAL_NOT_CONFIGURED`.

---

## 6. Scénarios de test

### 6.1 Paiement réussi

1. Créer un événement publié avec `admissionModes: ['paid_ticket']` et un type
   de billet payant.
2. Se connecter comme participant, ouvrir la page publique de l'événement.
3. **Acheter mon billet** → choisir la quantité → confirmer.
4. Redirection vers PayPal Sandbox → se connecter avec le compte **Personal**.
5. Approuver le paiement.
6. Retour sur `/paiement/succes?order_id=…` → « Nous confirmons votre
   paiement… » puis « Votre paiement est confirmé ».
7. Vérifier `/tableau-de-bord/participation` : les billets apparaissent.

**Vérifications en base :**

```
ticket_orders     status=PAID, payment.settlementReference renseignée
ticket_holds      status=CONSUMED
tickettypes       sold += quantité, reserved revenu à sa valeur initiale
ticketpurchases   une admission par billet
```

### 6.2 Annulation

Cliquer **Cancel and return** sur la page PayPal. Retour sur
`/paiement/annule`. La page interroge le serveur : aucun message n'affirme
qu'aucun montant n'a été débité.

### 6.3 Paiement refusé

**Testing Tools → Sandbox Accounts → compte Personal → Funding**, puis retirer
les moyens de paiement ou utiliser une carte de test refusée. La capture
échoue : `TicketOrder → FAILED`, `TicketHold → RELEASED`, `reserved` restitué.

### 6.4 Expiration

Réduire `PAID_TICKET_HOLD_MINUTES=1`, créer une commande et ne pas payer.
Après une minute, la commande passe `EXPIRED` à la première évaluation de
disponibilité (expiration paresseuse) ou via
`POST /ticket-orders-maintenance/expire` (rôle admin).

### 6.5 Doublon et rejeu de webhook

**Webhooks → Event Logs → un événement → Resend.** Le second envoi est
authentifié puis reconnu comme doublon : aucune admission supplémentaire,
aucun second incrément de `sold`.

Vérifier dans `paypal_webhook_events` : une seule entrée par `eventId`.

### 6.6 Webhook non authentique

Envoyer une requête POST manuelle sur l'endpoint avec un corps JSON plausible
mais sans en-têtes de transmission valides. Réponse attendue : **400
`WEBHOOK_NOT_AUTHENTIC`**, aucun effet métier.

---

## 7. Kill switch

**Couper tout encaissement immédiatement :**

```bash
PAID_CHECKOUT_ENABLED=false
```

puis redémarrer l'API. Effet :

- aucune nouvelle commande payante (503) ;
- les commandes existantes ne peuvent plus être réglées ;
- les réservations en cours expirent normalement et rendent leur capacité.

`PAYPAL_PROVIDER_ENABLED=false` coupe PayPal seul, sans fermer la caisse.

---

## 8. Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| L'API refuse de démarrer, message `PAYPAL_ENV=live is refused` | `PAYPAL_ENV=live` dans un `.env` de dev | remettre `sandbox` |
| L'API refuse de démarrer, message citant `PAYPAL_CLIENT_ID` | activation sans credentials | compléter les trois variables |
| 503 `PAID_CHECKOUT_NOT_READY` à la création de commande | un des deux interrupteurs est fermé | vérifier les deux drapeaux |
| 503 `PAYPAL_NOT_CONFIGURED` sur le webhook | fournisseur désactivé | activer `PAYPAL_PROVIDER_ENABLED` |
| 400 `WEBHOOK_NOT_AUTHENTIC` sur des webhooks légitimes | `PAYPAL_WEBHOOK_ID` ne correspond pas au webhook appelant | recopier l'ID du tableau de bord |
| 503 `WEBHOOK_VERIFICATION_UNAVAILABLE` | PayPal injoignable | PayPal rejouera ; vérifier le réseau sortant |
| La commande reste `PENDING_PAYMENT` après approbation | capture non déclenchée | ouvrir `/paiement/succes?order_id=…`, qui déclenche la synchronisation serveur |
| `TICKET_ORDER_SETTLEMENT_MISMATCH` | montant capturé différent de la commande | incident : la commande est en `requiresManualReview`, ne pas forcer |
| Aucun webhook reçu | URL non joignable | vérifier le tunnel et l'URL enregistrée |

### Ce qu'on ne trouvera jamais dans les journaux

`client_secret`, jeton d'accès OAuth, en-tête `Authorization`, corps de réponse
PayPal, clé d'idempotence brute. Les identifiants sensibles sont hachés et
tronqués. C'est intentionnel : ne pas chercher à les y ajouter pour déboguer.

---

## 9. Passage en live — NON AUTORISÉ DANS CETTE VAGUE

Le mode live exige, **avant** toute activation :

1. **Trancher la politique de règlement tardif** (Vague 5, §8 du rapport) —
   bloquant : que faire d'un paiement capturé après expiration ou annulation.
2. Retirer le garde-fou de vague `assertSandbox()` dans
   `PayPalPaymentProvider`, de façon explicite et revue.
3. Créer une application PayPal **Live** distincte, avec ses propres
   credentials et son propre webhook.
4. Aligner `PAID_TICKET_HOLD_MINUTES` sur la durée de validité réelle d'une
   commande PayPal, pour réduire la fenêtre de règlement tardif.
5. Vérifier que `ELINTYS_ENV=prod` et `NODE_ENV=production` sur l'hôte cible :
   la configuration refuse `live` partout ailleurs.
6. Ajouter l'opération de remboursement au contrat `PaymentProvider` si la
   politique retenue l'exige.

**Tant que ces points ne sont pas réglés, `PAYPAL_ENV` reste `sandbox`.**
