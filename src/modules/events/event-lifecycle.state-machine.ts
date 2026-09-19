import { EventStatus } from './event.schema';

export const EVENT_STATUS_TRANSITIONS: Readonly<
  Record<EventStatus, readonly EventStatus[]>
> = {
  [EventStatus.DRAFT]: [EventStatus.PUBLISHED],
  [EventStatus.PUBLISHED]: [
    EventStatus.ONGOING,
    EventStatus.COMPLETED,
    EventStatus.CANCELLED,
  ],
  [EventStatus.ONGOING]: [EventStatus.COMPLETED, EventStatus.CANCELLED],
  [EventStatus.COMPLETED]: [],
  [EventStatus.CANCELLED]: [],
};

export const ACTIVE_EVENT_STATUSES: readonly EventStatus[] = [
  EventStatus.PUBLISHED,
  EventStatus.ONGOING,
];

export function canTransitionEvent(from: EventStatus, to: EventStatus): boolean {
  return EVENT_STATUS_TRANSITIONS[from].includes(to);
}

export function assertEventTransition(from: EventStatus, to: EventStatus): void {
  if (!canTransitionEvent(from, to)) {
    throw new Error('INVALID_EVENT_STATUS_TRANSITION');
  }
}

export function isActiveEventStatus(status: EventStatus): boolean {
  return ACTIVE_EVENT_STATUSES.includes(status);
}

export function isTerminalEventStatus(status: EventStatus): boolean {
  return status === EventStatus.COMPLETED || status === EventStatus.CANCELLED;
}
