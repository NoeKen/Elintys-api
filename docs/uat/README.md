# Recette Elintys (UAT) — guide des testeurs

## Accès

| | URL |
| --- | --- |
| Application web | https://uat.elintys.com |
| API (santé) | https://api.uat.elintys.com/api/v1/health (en attendant le domaine : https://elintys-api-uat.onrender.com/api/v1/health) |

L'environnement est `uat` : l'application affiche un badge **« UAT »** en bas
à gauche, et la santé de l'API renvoie `"environment":"uat"`. Si le badge
n'apparaît pas, vous n'êtes **pas** sur la recette : n'y saisissez rien.

## Comptes de test

Deux possibilités :

1. **Comptes préparés** (domaine fictif `@uat.elintys.test`, aucun courriel
   ne peut y être reçu). Le mot de passe commun vous est transmis **hors de
   ce document**, par le mainteneur ; ne l'écrivez jamais dans un ticket.

   | Compte | Rôle | Usage prévu |
   | --- | --- | --- |
   | `participant.a@uat.elintys.test` | participant | billets, inscription, avis |
   | `participant.b@uat.elintys.test` | participant | invité d'un événement privé, avis |
   | `participant.unverified@uat.elintys.test` | participant, courriel **non vérifié** | mode lecture seule |
   | `organizer.a@uat.elintys.test` | organisateur | propriétaire des événements de recette |
   | `organizer.b@uat.elintys.test` | organisateur | tiers non propriétaire (tests d'accès) |
   | `vendor.a@uat.elintys.test` | prestataire | photographe, demande acceptée, avis |
   | `vendor.b@uat.elintys.test` | prestataire | traiteur sans demande |
   | `venue.manager.a@uat.elintys.test` | gestionnaire de salle | deux salles, réservation confirmée |
   | `venue.manager.b@uat.elintys.test` | gestionnaire de salle | une salle |

2. **Votre propre compte** : inscrivez-vous avec votre vraie adresse pour
   tester la réception et le lien de vérification du courriel (envoi réel via
   Resend). Utilisez de préférence une adresse dédiée aux tests.

## Données disponibles

Créées par `seed:uat` (fictives, préfixe « UAT ») :

- événements : conférence publique, atelier non répertorié, gala privé sur
  liste, festival en brouillon, concert terminé, réseautage annulé,
  rencontre d'une seconde organisatrice ; billets gratuits et « soutien » ;
- salles « UAT Salle Alpha / Beta / Gamma » (Montréal, Québec) ;
- invités (confirmé, invité, décliné), invitations en attente, demandes de
  prestataire, réservation de salle, avis.

## Limites connues

- **Démarrage à froid** : l'API est sur une offre gratuite Render, mise en
  veille après inactivité. Le premier appel peut prendre **~50 s**. Patientez
  puis rechargez avant de signaler un bug.
- **Paiement** : PayPal **sandbox** uniquement (aucun argent réel). Le
  paiement est actuellement fermé ; il sera annoncé quand il sera ouvert.
  N'utilisez jamais une vraie carte.
- **Courriel non vérifié = lecture seule** : tant que l'adresse n'est pas
  vérifiée, vous pouvez consulter mais toute action (créer, modifier,
  réserver, acheter, aimer…) est refusée et l'application affiche la
  vérification à faire. C'est le comportement attendu, pas un bug. Détail :
  [`../security/email-verification.md`](../security/email-verification.md).
- Les données peuvent être réinitialisées à tout moment (voir plus bas).
- La recette n'est pas indexée par les moteurs de recherche.

## Signaler un bug

Il n'existe pas encore de modèle d'issue dans les dépôts. Créez une issue
GitHub dans `NoeKen/Elintys-web` (problème visible dans l'interface) ou
`NoeKen/Elintys-api` (erreur serveur, données), avec le libellé `bug` et :

- **Titre** : `[UAT] <écran> — <symptôme>` ;
- **Environnement** : UAT, date/heure, navigateur et appareil ;
- **Compte utilisé** (adresse uniquement, jamais le mot de passe) et rôle ;
- **Étapes pour reproduire**, numérotées ;
- **Résultat attendu** / **résultat obtenu** ;
- **Gravité proposée** (P0–P3, voir [`../operations/bug-workflow.md`](../operations/bug-workflow.md)) ;
- **Preuves** : capture d'écran, et si possible l'identifiant `x-request-id`
  de la requête en erreur (outils de développement → Réseau).

Ne collez jamais de mot de passe, jeton, cookie ou donnée personnelle réelle
dans une issue : les dépôts sont **publics**.

## Réinitialisation des données

Réservée au mainteneur (NoeKen), depuis son poste, avec un fichier local
`.env.uat.local` non versionné :

```bash
npm run reset:uat -- --env-file=.env.uat.local --confirm=elintys-uat --backup-path=<dir> --reseed
```

Toutes les collections de `elintys-uat` sont vidées (y compris les comptes
créés par les testeurs), puis le jeu fictif est recréé. Annoncer la
réinitialisation aux testeurs avant de la lancer. Détail :
[`../operations/database-migrations.md`](../operations/database-migrations.md#seed-et-reset-uat).
