import { HealthController } from './health.controller';

describe('HealthController', () => {
  it("retourne un état stable exploitable par l'orchestrateur", () => {
    const controller = new HealthController();

    expect(controller.check()).toEqual({
      status: 'ok',
      service: 'elintys-api',
    });
  });
});

describe('HealthController — résolution de l’adresse cliente', () => {
  const controller = new HealthController();

  /** Requête minimale, telle qu'Express la présente au contrôleur. */
  const requete = (options: {
    ip: string;
    socket: string;
    forwarded?: string;
  }) =>
    ({
      ip: options.ip,
      socket: { remoteAddress: options.socket },
      headers: options.forwarded ? { 'x-forwarded-for': options.forwarded } : {},
    }) as never;

  it('devrait signaler une chaîne de proxys correctement traversée', () => {
    // `req.ip` diffère de la socket : un saut au moins a été franchi.
    expect(
      controller.client(
        requete({ ip: '203.0.113.7', socket: '10.0.0.1', forwarded: '203.0.113.7' }),
      ),
    ).toEqual({
      resolvedIp: '203.0.113.7',
      resolvedIsChainHead: true,
      forwardedChainLength: 1,
    });
  });

  it('devrait signaler un saut de trop peu dans la chaîne', () => {
    // C'est le défaut F-019 : l'adresse retenue est celle d'un intermédiaire,
    // donc commune à tous les visiteurs qui passent par lui.
    expect(
      controller.client(
        requete({ ip: '172.16.0.9', socket: '10.0.0.1', forwarded: '203.0.113.7, 172.16.0.9' }),
      ),
    ).toMatchObject({ resolvedIsChainHead: false, forwardedChainLength: 2 });
  });

  it('devrait rester neutre en l’absence de proxy', () => {
    expect(
      controller.client(requete({ ip: '::ffff:127.0.0.1', socket: '::ffff:127.0.0.1' })),
    ).toEqual({
      resolvedIp: '127.0.0.1',
      resolvedIsChainHead: true,
      forwardedChainLength: 0,
    });
  });
});
