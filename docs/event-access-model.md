# Modèle d’accès aux événements v2

## Trois axes indépendants

`discoverability` répond à « où l’événement est-il visible ? » :

- `public` : catalogue, recherche et page publique indexable lorsqu’il est publié ;
- `unlisted` : page accessible par lien direct, absente des listings et `noindex` ;
- `private` : aucune projection publique ; une autorisation dédiée est obligatoire et la route publique répond 404.

`accessPolicy` répond à « qui peut participer ? ». C’est une union discriminée : `open`, `registration_required`, `access_code`, `email_domain`, `manual_approval`, `guest_list` ou `invitation_token`.

`admissionModes[]` répond à « quelle preuve donne accès sur place ? » : `free`, `registration_only`, `free_ticket`, `paid_ticket`, `invitation`. Plusieurs modes peuvent coexister, par exemple vente publique et invitations VIP.

## Matrice de référence

| Cas | Discoverability | Policy | Admission |
| --- | --- | --- | --- |
| Public libre | public | open | free |
| Public avec inscription | public | registration_required | registration_only |
| Vente publique | public | open | paid_ticket |
| Domaine professionnel | public | email_domain | registration_only |
| Lien + code | unlisted | access_code | registration_only |
| Privé approuvé | private | manual_approval | registration_only |
| Accès nominatif visible | public | invitation_token | invitation |
| Vente + VIP | public | open | paid_ticket + invitation |

## Policies

Les décisions sont séparées : `canViewEvent`, `canRegisterForEvent`, `canPurchaseTicket`, `canReceiveInvitation`, `canCheckIn` et `canManageEvent`. Voir une fiche ne donne donc jamais implicitement le droit de s’inscrire, d’acheter ou d’entrer.

`validateEventAccessConfiguration` refuse les combinaisons incohérentes. `validateEventPublishability` ajoute les champs requis, le lieu et l’inventaire de billets. `GET /events/:id/publish-readiness` et `PATCH /events/:id/publish` utilisent la même policy.

## Routes

- `GET /events` : événements publics publiés seulement ;
- `GET /events/slug/:slug` : public et unlisted, jamais private ;
- `PUT /events/:id/access-configuration` : configuration complète, propriétaire/admin ;
- `POST /events/:id/access/code/verify` : code brut entrant, réponse avec grant de 15 minutes ;
- `GET /events/access/:grant` : résolution du grant sans exposer de secret ;
- `POST /events/:id/access/domain/check` : compte connecté avec adresse vérifiée ;
- `POST /events/:id/access/request` : demande d’approbation ;
- `GET /events/:id/access/requests` et `PATCH .../:requestId` : revue organisateur ;
- `GET /events/:id/publish-readiness` : erreurs et avertissements de publication.
- `POST /venues/:eventId/bookings`, `GET /venues/:eventId/bookings` et `PATCH /venues/bookings/:bookingId/cancel` : propriété de l’événement vérifiée côté serveur.

## Sécurité

- Les codes sont hashés avec bcrypt et ne sont jamais retournés.
- Les grants sont des JWT courts, dédiés à un événement et à une audience spécifique.
- Les invitations utilisent 32 octets aléatoires ; seul leur SHA-256 est stocké. Elles expirent, ont un compteur d’utilisation et la redemption est rate-limitée.
- Un domaine est normalisé en ASCII minuscule, sans `@`, puis comparé exactement au domaine final d’une adresse vérifiée. Les suffixes (`evilentreprise.ca`) et sous-domaines ne correspondent pas.
- Les routes sensibles sont limitées en débit. Les logs contiennent seulement eventId, type de policy, décision, reason code et requestId — jamais code, token, hash ou courriel complet.
- Le slug est un identifiant de routage, jamais une preuve d’autorisation.

## Migration legacy

`npm run event-access:migrate` est toujours un dry-run par défaut. Il compte les valeurs, affiche les événements ambigus et ne modifie rien.

Après revue :

```bash
npm run event-access:migrate -- --execute --confirm-access-v2
```

L’exécution crée d’abord un fichier de rollback en mode `0600`. Les anciens `private` sans intention déterminable et ceux marqués `accessCode` sans valeur brute ne sont pas migrés. Ils exigent une revue manuelle. La lecture utilise temporairement `normalizeLegacyEventAccess`; ce helper doit être supprimé lorsque tous les documents portent `accessModelVersion: 2`, puis les champs `visibility` et `accessRules` doivent être retirés du schéma.

## SEO et projections

Les listings ne projettent que `public`. Une page `unlisted` porte `noindex` et ne figure pas au sitemap. Un événement `private` ne génère aucune metadata sensible. Les réponses API suppriment `codeHash`, `tokenHash` et le token legacy ; une policy `access_code` expose seulement `hasAccessCode: true`.

## Intégration future Workspace

L’autorisation de gestion passe par `canManageEvent(actor, event)`. Aujourd’hui, elle reconnaît le propriétaire et l’admin ; demain elle pourra intégrer membres, rôles et permissions Workspace sans disperser des comparaisons `organizer === userId`.
