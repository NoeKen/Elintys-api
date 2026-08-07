import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../shared/decorators/public.decorator';
import { normalizeIp } from '../../shared/guards/elintys-throttler.guard';

/** Diagnostic de résolution d'adresse derrière la chaîne de proxys. */
export interface ClientResolution {
  /** Adresse retenue pour le rate-limiting — celle de l'appelant lui-même. */
  resolvedIp: string;
  /**
   * `true` si l'adresse retenue est bien la tête de la chaîne de transfert,
   * c'est-à-dire celle du client réel.
   *
   * Quand c'est `false`, `TRUSTED_PROXY_HOPS` est inférieur au nombre réel de
   * proxys : l'adresse retenue est celle d'un intermédiaire, et tous les
   * visiteurs passant par lui partagent un unique compteur (F-019).
   */
  resolvedIsChainHead: boolean;
  /** Nombre d'adresses annoncées par la chaîne `X-Forwarded-For`. */
  forwardedChainLength: number;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: "Vérifier que l'API est disponible" })
  @ApiResponse({ status: 200, description: "L'API est opérationnelle" })
  check(): { status: 'ok'; service: 'elintys-api' } {
    return {
      status: 'ok',
      service: 'elintys-api',
    };
  }

  /**
   * Vérifie que l'adresse cliente est bien résolue derrière les proxys.
   *
   * `TRUSTED_PROXY_HOPS` doit correspondre au nombre réel de proxys devant
   * l'API. Une valeur trop basse fait retomber le comptage sur l'adresse d'un
   * proxy — et tous les visiteurs se partagent alors un seul quota, sans que
   * rien ne le signale. Cette route rend la configuration vérifiable depuis
   * l'extérieur au lieu de reposer sur une hypothèse.
   *
   * Aucune donnée d'un tiers n'est divulguée : l'appelant ne reçoit que sa
   * propre adresse, qu'il connaît déjà.
   */
  @Public()
  @Get('client')
  @ApiOperation({ summary: 'Adresse cliente résolue derrière les proxys' })
  @ApiResponse({ status: 200, description: 'Diagnostic de résolution' })
  client(@Req() request: Request): ClientResolution {
    const forwarded = request.headers['x-forwarded-for'];
    const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean);

    const resolvedIp = normalizeIp(request.ip);

    return {
      resolvedIp,
      // La tête de chaîne est l'adresse annoncée par le proxy le plus éloigné,
      // donc celle du client. S'arrêter avant, c'est compter un intermédiaire.
      resolvedIsChainHead: chain.length === 0 || resolvedIp === normalizeIp(chain[0]),
      forwardedChainLength: chain.length,
    };
  }
}
