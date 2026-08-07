import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import type { JwtPayload } from '../decorators/current-user.decorator';

/**
 * Rate-limiting par identité réelle plutôt que par socket (F-019).
 *
 * Deux défauts du garde par défaut sont corrigés ici :
 *
 * 1. **Derrière un proxy**, `req.ip` vaut l'adresse du proxy tant qu'Express
 *    n'a pas reçu de `trust proxy`. Tous les visiteurs partagent alors un
 *    unique compteur : la zone publique se rend elle-même indisponible dès
 *    quelques dizaines de visiteurs simultanés. `trust proxy` est configuré
 *    dans `main.ts` avec un **nombre de sauts**, jamais `true`, de sorte
 *    qu'un `X-Forwarded-For` forgé par le client ne soit jamais retenu.
 *
 * 2. **Derrière une IP partagée** (entreprise, université, Wi-Fi public,
 *    NAT mobile), les visiteurs authentifiés se bloquaient mutuellement. Une
 *    requête authentifiée est désormais comptée sur son identifiant
 *    utilisateur, indépendamment de l'IP d'origine.
 *
 * Le compteur reste cloisonné par profil de throttling : saturer le
 * catalogue public n'entame pas le quota de connexion, et inversement.
 */
@Injectable()
export class ElintysThrottlerGuard extends ThrottlerGuard {
  /**
   * Identité retenue pour le comptage.
   *
   * `req.user` est renseigné par `JwtAuthGuard`. Si celui-ci ne s'est pas
   * encore exécuté, on retombe sur l'IP : moins fin, mais jamais moins sûr.
   */
  protected override async getTracker(request: Request): Promise<string> {
    const user = (request as Request & { user?: JwtPayload }).user;
    if (user?.sub) return `user:${user.sub}`;
    return `ip:${normalizeIp(request.ip)}`;
  }

  /**
   * Clé de compteur : identité × profil × route.
   *
   * Le nom du throttler (`default`, ou un tier surchargé localement) entre
   * dans la clé, ce qui empêche une catégorie de trafic d'épuiser le quota
   * d'une autre.
   */
  protected override generateKey(
    context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    const handler = context.getHandler().name;
    const controller = context.getClass().name;
    return `${name}:${controller}.${handler}:${suffix}`;
  }
}

/**
 * Normalise une adresse IP pour le comptage.
 *
 * Les adresses IPv4 encapsulées en IPv6 (`::ffff:203.0.113.7`) sont ramenées
 * à leur forme IPv4, faute de quoi un même client compterait deux fois selon
 * la pile réseau empruntée.
 */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'inconnue';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  return (mapped?.[1] ?? ip).toLowerCase();
}
