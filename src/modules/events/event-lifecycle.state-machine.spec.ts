import { EventStatus } from './event.schema';
import {
  assertEventTransition,
  canTransitionEvent,
  isActiveEventStatus,
  isTerminalEventStatus,
} from './event-lifecycle.state-machine';

describe('Event lifecycle state machine', () => {
  const allowed: Array<[EventStatus, EventStatus]> = [
    [EventStatus.DRAFT, EventStatus.PUBLISHED],
    [EventStatus.PUBLISHED, EventStatus.ONGOING],
    [EventStatus.PUBLISHED, EventStatus.COMPLETED],
    [EventStatus.PUBLISHED, EventStatus.CANCELLED],
    [EventStatus.ONGOING, EventStatus.COMPLETED],
    [EventStatus.ONGOING, EventStatus.CANCELLED],
  ];

  it.each(allowed)('autorise %s -> %s', (from, to) => {
    expect(canTransitionEvent(from, to)).toBe(true);
    expect(() => assertEventTransition(from, to)).not.toThrow();
  });

  it.each([
    EventStatus.DRAFT,
    EventStatus.PUBLISHED,
    EventStatus.ONGOING,
    EventStatus.COMPLETED,
    EventStatus.CANCELLED,
  ])('refuse les transitions vers le même statut (%s)', (status) => {
    expect(canTransitionEvent(status, status)).toBe(false);
  });

  it.each([EventStatus.COMPLETED, EventStatus.CANCELLED])(
    'rend %s terminal',
    (status) => {
      expect(isTerminalEventStatus(status)).toBe(true);
      for (const target of Object.values(EventStatus)) {
        expect(canTransitionEvent(status, target)).toBe(false);
      }
    },
  );

  it('distingue les statuts opérationnels des statuts terminaux', () => {
    expect(isActiveEventStatus(EventStatus.PUBLISHED)).toBe(true);
    expect(isActiveEventStatus(EventStatus.ONGOING)).toBe(true);
    expect(isActiveEventStatus(EventStatus.DRAFT)).toBe(false);
    expect(isTerminalEventStatus(EventStatus.DRAFT)).toBe(false);
  });

  it('lève une erreur stable pour une transition illégale', () => {
    expect(() =>
      assertEventTransition(EventStatus.DRAFT, EventStatus.CANCELLED),
    ).toThrow('INVALID_EVENT_STATUS_TRANSITION');
  });
});
