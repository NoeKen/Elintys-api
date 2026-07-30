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
