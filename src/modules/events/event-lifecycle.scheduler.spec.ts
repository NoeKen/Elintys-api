import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Event, EventStatus } from './event.schema';
import { EventLifecycleScheduler } from './event-lifecycle.scheduler';

describe('EventLifecycleScheduler', () => {
  let moduleRef: TestingModule;
  const exec = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  const eventModel = {
    updateMany: jest.fn<
      { exec: typeof exec },
      [Record<string, unknown>, Record<string, unknown>]
    >(
      () => ({ exec }),
    ),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        EventLifecycleScheduler,
        { provide: getModelToken(Event.name), useValue: eventModel },
      ],
    }).compile();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await moduleRef.close();
  });

  it('termine avant de démarrer afin de gérer un cycle manqué en un passage', async () => {
    const now = new Date('2026-09-14T16:00:00.000Z');

    await moduleRef.get(EventLifecycleScheduler).synchronize(now);

    expect(eventModel.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        status: { $in: [EventStatus.PUBLISHED, EventStatus.ONGOING] },
        endDate: { $lte: now },
      },
      { $set: { status: EventStatus.COMPLETED, completedAt: now } },
    );
    expect(eventModel.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        status: EventStatus.PUBLISHED,
        startDate: { $lte: now },
        $or: [
          { endDate: { $gt: now } },
          { endDate: null },
          { endDate: { $exists: false } },
        ],
      },
      { $set: { status: EventStatus.ONGOING, startedAt: now } },
    );
  });

  it('est idempotent grâce aux filtres sur le statut source', async () => {
    const scheduler = moduleRef.get(EventLifecycleScheduler);
    const now = new Date('2026-09-14T16:00:00.000Z');

    await scheduler.synchronize(now);
    await scheduler.synchronize(now);

    expect(eventModel.updateMany).toHaveBeenCalledTimes(4);
    for (const [filter] of eventModel.updateMany.mock.calls) {
      expect(filter.status).toBeDefined();
    }
  });

  it.each([
    ['juste avant le début', '2026-09-14T15:59:59.999Z'],
    ['au début exact', '2026-09-14T16:00:00.000Z'],
    ['pendant', '2026-09-14T16:30:00.000Z'],
    ['à la fin exacte', '2026-09-14T17:00:00.000Z'],
    ['juste après la fin', '2026-09-14T17:00:00.001Z'],
  ])('applique les bornes UTC Mongo pour %s', async (_label, instant) => {
    const now = new Date(instant);

    await moduleRef.get(EventLifecycleScheduler).synchronize(now);

    const [completedFilter] = eventModel.updateMany.mock.calls[0];
    const [ongoingFilter] = eventModel.updateMany.mock.calls[1];
    expect(completedFilter).toEqual(expect.objectContaining({
      endDate: { $lte: now },
    }));
    expect(ongoingFilter).toEqual(expect.objectContaining({
      startDate: { $lte: now },
      $or: expect.arrayContaining([{ endDate: { $gt: now } }]),
    }));
  });

  it('reste fondé sur l’instant UTC pendant le changement DST America/Toronto', async () => {
    const localAfterDstJump = new Date('2026-03-08T03:00:00-04:00');

    await moduleRef.get(EventLifecycleScheduler).synchronize(localAfterDstJump);

    expect(localAfterDstJump.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(eventModel.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ endDate: { $lte: localAfterDstJump } }),
      expect.any(Object),
    );
  });
});
