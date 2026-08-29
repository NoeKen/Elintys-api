import { Types } from 'mongoose';
import {
  TicketOrdersController,
  TicketOrdersMaintenanceController,
} from './ticket-orders.controller';
import { TicketOrdersService } from './ticket-orders.service';
import { JwtPayload } from '../../../shared/decorators/current-user.decorator';

const USER: JwtPayload = {
  sub: new Types.ObjectId().toString(),
  email: 'acheteur@example.ca',
  roles: ['participant'],
};

function buildController(): {
  controller: TicketOrdersController;
  maintenance: TicketOrdersMaintenanceController;
  service: Record<string, jest.Mock>;
} {
  const service = {
    createOrder: jest.fn().mockResolvedValue({ _id: 'order-1' }),
    findMine: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    findOne: jest.fn().mockResolvedValue({ _id: 'order-1' }),
    syncPayment: jest.fn().mockResolvedValue({ _id: 'order-1' }),
    cancelOrder: jest.fn().mockResolvedValue({ _id: 'order-1' }),
    sweepExpiredOrders: jest.fn().mockResolvedValue({ scanned: 0, expired: 0 }),
  };
  return {
    controller: new TicketOrdersController(service as unknown as TicketOrdersService),
    maintenance: new TicketOrdersMaintenanceController(
      service as unknown as TicketOrdersService,
    ),
    service,
  };
}

afterEach(() => jest.clearAllMocks());

describe('TicketOrdersController', () => {
  it("devrait transmettre l'identité serveur, jamais un buyerId du corps de requête", async () => {
    const { controller, service } = buildController();
    const dto = {
      lines: [{ ticketTypeId: 'tt-1', quantity: 2 }],
      buyerId: 'attaquant',
      paid: true,
    } as never;

    await controller.create(USER, dto, 'key-1', 'grant-1');

    expect(service.createOrder).toHaveBeenCalledWith(USER.sub, dto, 'key-1', 'grant-1');
    // L'identité passée au service est celle du JWT.
    expect(service.createOrder.mock.calls[0][0]).toBe(USER.sub);
  });

  it('devrait transmettre une clé d\'idempotence vide lorsque l\'en-tête est absent', async () => {
    const { controller, service } = buildController();
    await controller.create(USER, { lines: [] } as never);
    expect(service.createOrder).toHaveBeenCalledWith(USER.sub, { lines: [] }, '', undefined);
  });

  it('devrait déléguer la lecture paginée', async () => {
    const { controller, service } = buildController();
    await controller.findMine(USER, { page: 2, limit: 10 });
    expect(service.findMine).toHaveBeenCalledWith(USER.sub, { page: 2, limit: 10 });
  });

  it('devrait déléguer la lecture unitaire avec contrôle de propriété côté service', async () => {
    const { controller, service } = buildController();
    await controller.findOne(USER, 'order-1');
    expect(service.findOne).toHaveBeenCalledWith('order-1', USER.sub);
  });

  it('ne devrait accepter aucun statut de paiement du client lors de la synchronisation', async () => {
    const { controller, service } = buildController();
    await controller.syncPayment(USER, 'order-1');
    expect(service.syncPayment).toHaveBeenCalledWith('order-1', USER.sub);
    expect(service.syncPayment.mock.calls[0]).toHaveLength(2);
  });

  it('devrait déléguer l\'annulation', async () => {
    const { controller, service } = buildController();
    await controller.cancel(USER, 'order-1');
    expect(service.cancelOrder).toHaveBeenCalledWith('order-1', USER.sub);
  });
});

describe('TicketOrdersMaintenanceController', () => {
  it('devrait déclencher un balayage d\'expiration', async () => {
    const { maintenance, service } = buildController();
    await expect(maintenance.expire()).resolves.toEqual({ scanned: 0, expired: 0 });
    expect(service.sweepExpiredOrders).toHaveBeenCalledTimes(1);
  });
});

describe('Contrat de sécurité des routes de commande', () => {
  const routes = Reflect.ownKeys(TicketOrdersController.prototype).filter(
    (key) => key !== 'constructor',
  );

  it('ne devrait exposer aucune route publique', () => {
    for (const route of routes) {
      const handler = (TicketOrdersController.prototype as unknown as Record<string | symbol, unknown>)[route];
      expect(Reflect.getMetadata('isPublic', handler as object)).toBeUndefined();
    }
    expect(Reflect.getMetadata('isPublic', TicketOrdersController)).toBeUndefined();
  });

  it('devrait réserver la maintenance au rôle admin', () => {
    const roles = Reflect.getMetadata(
      'roles',
      TicketOrdersMaintenanceController.prototype.expire,
    ) as string[];
    expect(roles).toEqual(['admin']);
  });
});
