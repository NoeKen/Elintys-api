import { TicketOrderStatus } from './ticket-order.schema';
import { TicketHoldStatus } from './ticket-hold.schema';
import {
  assertHoldTransition,
  assertOrderTransition,
  canTransitionHold,
  canTransitionOrder,
  InvalidHoldTransitionError,
  InvalidOrderTransitionError,
  isTerminalOrderStatus,
  ORDER_INVALID_TRANSITION,
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
} from './ticket-order.state-machine';

const ALL_ORDER_STATUSES = Object.values(TicketOrderStatus);
const ALL_HOLD_STATUSES = Object.values(TicketHoldStatus);

describe('Machine d\'état TicketOrder', () => {
  it.each([
    TicketOrderStatus.PAID,
    TicketOrderStatus.FAILED,
    TicketOrderStatus.EXPIRED,
    TicketOrderStatus.CANCELLED,
  ])('devrait autoriser PENDING_PAYMENT → %s', (target) => {
    expect(canTransitionOrder(TicketOrderStatus.PENDING_PAYMENT, target)).toBe(true);
    expect(() => assertOrderTransition(TicketOrderStatus.PENDING_PAYMENT, target)).not.toThrow();
  });

  it('devrait rendre PAID → PENDING_PAYMENT impossible', () => {
    expect(canTransitionOrder(TicketOrderStatus.PAID, TicketOrderStatus.PENDING_PAYMENT)).toBe(false);
    expect(() =>
      assertOrderTransition(TicketOrderStatus.PAID, TicketOrderStatus.PENDING_PAYMENT),
    ).toThrow(InvalidOrderTransitionError);
  });

  it('devrait rendre tous les états terminaux définitifs', () => {
    for (const from of TERMINAL_ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[from]).toEqual([]);
      for (const to of ALL_ORDER_STATUSES) {
        expect(canTransitionOrder(from, to)).toBe(false);
      }
    }
  });

  it('devrait refuser la transition vers soi-même depuis PENDING_PAYMENT', () => {
    expect(
      canTransitionOrder(TicketOrderStatus.PENDING_PAYMENT, TicketOrderStatus.PENDING_PAYMENT),
    ).toBe(false);
  });

  it('devrait exposer un code d\'erreur stable', () => {
    expect(
      new InvalidOrderTransitionError(TicketOrderStatus.PAID, TicketOrderStatus.CANCELLED).message,
    ).toBe(ORDER_INVALID_TRANSITION);
  });

  it('devrait identifier exactement quatre états terminaux', () => {
    expect(ALL_ORDER_STATUSES.filter(isTerminalOrderStatus)).toEqual([
      TicketOrderStatus.PAID,
      TicketOrderStatus.FAILED,
      TicketOrderStatus.EXPIRED,
      TicketOrderStatus.CANCELLED,
    ]);
    expect(isTerminalOrderStatus(TicketOrderStatus.PENDING_PAYMENT)).toBe(false);
  });
});

describe('Machine d\'état TicketHold', () => {
  it.each([TicketHoldStatus.CONSUMED, TicketHoldStatus.RELEASED, TicketHoldStatus.EXPIRED])(
    'devrait autoriser ACTIVE → %s',
    (target) => {
      expect(canTransitionHold(TicketHoldStatus.ACTIVE, target)).toBe(true);
      expect(() => assertHoldTransition(TicketHoldStatus.ACTIVE, target)).not.toThrow();
    },
  );

  it('devrait interdire toute sortie d\'un état terminal', () => {
    const terminals = [
      TicketHoldStatus.CONSUMED,
      TicketHoldStatus.RELEASED,
      TicketHoldStatus.EXPIRED,
    ];
    for (const from of terminals) {
      for (const to of ALL_HOLD_STATUSES) {
        expect(canTransitionHold(from, to)).toBe(false);
      }
    }
  });

  it('devrait interdire CONSUMED → RELEASED (double libération impossible)', () => {
    expect(() =>
      assertHoldTransition(TicketHoldStatus.CONSUMED, TicketHoldStatus.RELEASED),
    ).toThrow(InvalidHoldTransitionError);
  });
});
