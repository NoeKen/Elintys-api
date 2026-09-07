# Runbook — Paiements PayPal (Sandbox et Live)
**Elintys-api / Elintys-web**

> L'environnement de paiement est **entièrement piloté par configuration**.
> Basculer Sandbox ↔ Live ne demande aucune modification de code : seules les
> variables et les credentials changent.

> **Aucun secret dans ce document.** Tous les identifiants sont des
> placeholders. Les vraies valeurs vivent dans `.env`, jamais versionné.

---

## 1. Préparer l'application PayPal Developer

1. Ouvrir <https://developer.paypal.com/dashboard/> et se connecter.
2. Basculer l'interrupteur en haut à droite sur l'environnement voulu :
   **Sandbox** pour la recette, **Live** pour la production. Les deux ont des
   applications, des credentials et des webhooks DISTINCTS.
3. **Apps & Credentials → Create App**
   - Type : *Merchant*
   - Sandbox Business Account : celui proposé par défaut
4. Relever **Client ID** et **Secret** (bouton *Show*).

### Comptes de test (Sandbox uniquement)

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
PAID_CHECKOUT_ENABLED=true      # interrupteur global de caisse (domaine)
PAYPAL_PROVIDER_ENABLED=true    # interrupteur PayPal (fournisseur)
PAYPAL_ENV=sandbox              # sandbox | live
PAYPAL_CLIENT_ID=<client id de l'app correspondante>
PAYPAL_CLIENT_SECRET=<secret de l'app correspondante>
PAYPAL_WEBHOOK_ID=WH-<identifiant du webhook de CET environnement>
```

Dans `Elintys-web/.env` :

```bash
NEXT_PUBLIC_PAYPAL_ENV=sandbox  # doit correspondre au PAYPAL_ENV de l'API
```

Le frontend ne s'en sert que pour valider l'hôte de l'URL d'approbation avant
de rediriger l'acheteur. Absent ou invalide, il retombe sur `sandbox` :
l'environnement inoffensif.

### `PAYPAL_ENV` est indépendant de `NODE_ENV`

Ce sont deux dimensions distinctes, et aucune n'est dérivée de l'autre. Toutes
ces combinaisons sont valides et supportées :

| Application | PayPal | Cas d'usage |
|---|---|---|
| `NODE_ENV=production` | désactivé | production sans encaissement |
| `NODE_ENV=production` | `sandbox` | recette sur un build de production |
| `NODE_ENV=development` | `sandbox` | développement courant |
| `NODE_ENV=development` | fournisseur de test | tests locaux sans PayPal |
| `NODE_ENV=production` | `live` | production réelle, après configuration explicite |

Un build de production ne bascule **jamais** PayPal en Live tout seul.

### Ce qui dérive de `PAYPAL_ENV`

Dérivé en un seul endroit (`src/config/paypal-environment.ts`), jamais recopié :

| | `sandbox` | `live` |
|---|---|---|
| Hôte API | `api-m.sandbox.paypal.com` | `api-m.paypal.com` |
| Hôtes d'approbation | `sandbox.paypal.com`, `www.sandbox.paypal.com` | `paypal.com`, `www.paypal.com` |

Une URL d'approbation Live reçue en configuration Sandbox — ou l'inverse — est
**refusée** : une confusion d'environnement est un incident, pas un détail.

### Matrice de configuration

| `PAID_CHECKOUT_ENABLED` | `PAYPAL_PROVIDER_ENABLED` | `PAYPAL_ENV` | Credentials | Résultat |
|---|---|---|---|---|
| `false` | `false` | `sandbox` | — | paiements fermés |
| `false` | `true` | `sandbox` | complètes | fournisseur prêt, caisse fermée (503) |
| `true` | `false` | `sandbox` | — | caisse ouverte, repli test/Stripe ou 503 |
| `true` | `true` | `sandbox` | complètes | **encaissement Sandbox** |
| `true` | `true` | `live` | complètes | **encaissement RÉEL** |
| toute | `true` | toute | incomplètes | **refus de démarrage** |
| toute | toute | invalide | — | **refus de démarrage** |

### Ce qui empêche le démarrage (fail-closed)

| Situation | Comportement |
|---|---|
| `PAYPAL_ENV` autre que `sandbox` ou `live` | **refus de démarrage**, fournisseur activé ou non |
| `PAYPAL_PROVIDER_ENABLED=true` sans les trois credentials | **refus de démarrage**, avec le nom des variables manquantes |

Il n'existe **aucun repli** : ni live → sandbox, ni sandbox → live, ni
dégradation silencieuse. Une configuration incohérente arrête l'API plutôt que
de la laisser tourner à moitié branchée sur un fournisseur de paiement.

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
| L'API refuse de démarrer, message citant `PAYPAL_ENV` | valeur autre que `sandbox` ou `live` (faute de frappe, `staging`, `prod`…) | corriger la valeur |
| Redirection PayPal refusée alors que la commande est créée | `NEXT_PUBLIC_PAYPAL_ENV` ne correspond pas au `PAYPAL_ENV` de l'API | aligner les deux |
| L'API refuse de démarrer, message citant `PAYPAL_CLIENT_ID` | activation sans credentials | compléter les trois variables |
| 503 `PAID_CHECKOUT_NOT_READY` à la création de commande | un des deux interrupteurs est fermé | vérifier les deux drapeaux |
| 503 `PAYPAL_NOT_CONFIGURED` sur le webhook | fournisseur désactivé | activer `PAYPAL_PROVIDER_ENABLED` |
| 400 `WEBHOOK_NOT_AUTHENTIC` sur des webhooks légitimes | `PAYPAL_WEBHOOK_ID` ne correspond pas au webhook appelant — souvent un webhook Sandbox laissé en Live | recopier l'ID du tableau de bord de l'environnement COURANT |
| 503 `WEBHOOK_VERIFICATION_UNAVAILABLE` | PayPal injoignable | PayPal rejouera ; vérifier le réseau sortant |
| La commande reste `PENDING_PAYMENT` après approbation | capture non déclenchée | ouvrir `/paiement/succes?order_id=…`, qui déclenche la synchronisation serveur |
| `TICKET_ORDER_SETTLEMENT_MISMATCH` | montant capturé différent de la commande | incident : la commande est en `requiresManualReview`, ne pas forcer |
| Aucun webhook reçu | URL non joignable | vérifier le tunnel et l'URL enregistrée |

### Ce qu'on ne trouvera jamais dans les journaux

`client_secret`, jeton d'accès OAuth, en-tête `Authorization`, corps de réponse
PayPal, clé d'idempotence brute. Les identifiants sensibles sont hachés et
tronqués. C'est intentionnel : ne pas chercher à les y ajouter pour déboguer.

---

## 9. Basculer Sandbox → Live

Aucune modification de code n'est requise. La bascule est une opération de
configuration et de déploiement.

### Prérequis produit — à trancher AVANT

1. **Politique de règlement tardif** (Vague 5, §8 du rapport) — bloquant : que
   faire d'un paiement capturé après expiration ou annulation d'une commande.
2. **`PAID_TICKET_HOLD_MINUTES`** aligné sur la durée de validité réelle d'une
   commande PayPal, pour réduire la fenêtre de règlement tardif.
3. **Remboursement** ajouté au contrat `PaymentProvider` si la politique
   retenue l'exige.

### Procédure

1. Créer une application PayPal **Live** distincte dans le tableau de bord
   PayPal Developer (interrupteur sur *Live*), avec ses propres credentials.
2. Créer un webhook **Live**, sur l'URL de production, avec les mêmes quatre
   événements. Relever son `WH-…` : il est **distinct** de celui de Sandbox.
3. Poser sur l'hôte cible :

   ```bash
   PAYPAL_ENV=live
   PAYPAL_CLIENT_ID=<client id LIVE>
   PAYPAL_CLIENT_SECRET=<secret LIVE>
   PAYPAL_WEBHOOK_ID=WH-<webhook LIVE>
   PAYPAL_PROVIDER_ENABLED=true
   PAID_CHECKOUT_ENABLED=true
   ```

   Et côté web : `NEXT_PUBLIC_PAYPAL_ENV=live`.

4. Redémarrer l'API. Si une variable manque, elle **refuse de démarrer** en
   nommant la variable absente — c'est le comportement attendu.
5. Vérifier au démarrage la ligne de diagnostic : `environment: "live"`,
   `baseUrl: "https://api-m.paypal.com"`, et les trois drapeaux de présence à
   `true`. Aucun secret n'y figure.
6. Valider avec **une** transaction réelle de faible montant, puis la
   rembourser.

### Ne jamais faire

- Réutiliser les credentials ou le webhook Sandbox en Live, ni l'inverse. Les
  deux environnements sont étanches et leurs identifiants ne sont pas
  interchangeables.
- Poser `PAYPAL_ENV=live` sans aligner `NEXT_PUBLIC_PAYPAL_ENV` : le frontend
  refuserait alors la redirection vers PayPal alors que la commande aurait été
  créée et le stock réservé.

## 10. Revenir Live → Sandbox

Même opération en sens inverse, et tout aussi réversible :

```bash
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=<client id SANDBOX>
PAYPAL_CLIENT_SECRET=<secret SANDBOX>
PAYPAL_WEBHOOK_ID=WH-<webhook SANDBOX>
```

et `NEXT_PUBLIC_PAYPAL_ENV=sandbox`. Redémarrer.

Les commandes créées en Live **ne sont pas** consultables depuis Sandbox : les
deux environnements ont des bases PayPal distinctes. Laisser les commandes en
cours se régler ou expirer avant de basculer.

## 11. Rollback

| Urgence | Action | Effet |
|---|---|---|
| Couper l'encaissement immédiatement | `PAID_CHECKOUT_ENABLED=false` + redémarrage | plus aucune commande payante (503) ; les réservations en cours expirent et rendent leur capacité |
| Couper PayPal seul | `PAYPAL_PROVIDER_ENABLED=false` + redémarrage | la caisse reste ouverte pour un autre fournisseur |
| Revenir à Sandbox | §10 | encaissement de test uniquement |

Aucun de ces gestes ne modifie ni ne supprime de commande existante.
