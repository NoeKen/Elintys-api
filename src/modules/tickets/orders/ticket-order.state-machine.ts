import { ConflictException } from '@nestjs/common';
import { TicketOrderStatus } from './ticket-order.schema';
import { TicketHoldStatus } from './ticket-hold.schema';

export const ORDER_INVALID_TRANSITION = 'ORDER_INVALID_STATUS_TRANSITION';
export const HOLD_INVALID_TRANSITION = 'HOLD_INVALID_STATUS_TRANSITION';

/**
 * Machine d'état de la commande — table exhaustive et explicite.
 *
 *   PENDING_PAYMENT ──▶ PAID
 *   PENDING_PAYMENT ──▶ FAILED
 *   PENDING_PAYMENT ──▶ EXPIRED
 *   PENDING_PAYMENT ──▶ CANCELLED
 *
 * Aucun état terminal ne mène nulle part. En particulier :
 *   PAID ──▶ PENDING_PAYMENT est IMPOSSIBLE.
 *
 * Cette table décrit l'intention. La garantie effective est portée par la base :
 * chaque transition est écrite avec un filtre conditionnel sur le statut
 * courant, à l'intérieur d'une transaction.
 */
export const ORDER_TRANSITIONS: Readonly<Record<TicketOrderStatus, readonly TicketOrderStatus[]>> =
  Object.freeze({
    [TicketOrderStatus.PENDING_PAYMENT]: [
      TicketOrderStatus.PAID,
      TicketOrderStatus.FAILED,
      TicketOrderStatus.EXPIRED,
      TicketOrderStatus.CANCELLED,
    ],
    [TicketOrderStatus.PAID]: [],
    [TicketOrderStatus.FAILED]: [],
    [TicketOrderStatus.EXPIRED]: [],
    [TicketOrderStatus.CANCELLED]: [],
  });

export const TERMINAL_ORDER_STATUSES: readonly TicketOrderStatus[] = [
  TicketOrderStatus.PAID,
  TicketOrderStatus.FAILED,
  TicketOrderStatus.EXPIRED,
  TicketOrderStatus.CANCELLED,
] as const;

export function isTerminalOrderStatus(status: TicketOrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function canTransitionOrder(
  from: TicketOrderStatus,
  to: TicketOrderStatus,
): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function assertOrderTransition(
  from: TicketOrderStatus,
  to: TicketOrderStatus,
): void {
  if (!canTransitionOrder(from, to)) {
    throw new InvalidOrderTransitionError(from, to);
  }
}

export class InvalidOrderTransitionError extends ConflictException {
  constructor(
    public readonly from: TicketOrderStatus,
    public readonly to: TicketOrderStatus,
  ) {
    super(ORDER_INVALID_TRANSITION);
  }
}

/**
 * Machine d'état de la réservation.
 *
 *   ACTIVE ──▶ CONSUMED | RELEASED | EXPIRED
 *
 * Les états terminaux sont définitifs : une réservation ne peut être consommée
 * qu'une fois et libérée qu'une fois.
 */
export const HOLD_TRANSITIONS: Readonly<Record<TicketHoldStatus, readonly TicketHoldStatus[]>> =
  Object.freeze({
    [TicketHoldStatus.ACTIVE]: [
      TicketHoldStatus.CONSUMED,
      TicketHoldStatus.RELEASED,
      TicketHoldStatus.EXPIRED,
    ],
    [TicketHoldStatus.CONSUMED]: [],
    [TicketHoldStatus.RELEASED]: [],
    [TicketHoldStatus.EXPIRED]: [],
  });

export function canTransitionHold(from: TicketHoldStatus, to: TicketHoldStatus): boolean {
  return (HOLD_TRANSITIONS[from] ?? []).includes(to);
}

export class InvalidHoldTransitionError extends ConflictException {
  constructor(
    public readonly from: TicketHoldStatus,
    public readonly to: TicketHoldStatus,
  ) {
    super(HOLD_INVALID_TRANSITION);
  }
}

export function assertHoldTransition(from: TicketHoldStatus, to: TicketHoldStatus): void {
  if (!canTransitionHold(from, to)) {
    throw new InvalidHoldTransitionError(from, to);
  }
}

/**
 * Correspondance entre l'issue du fournisseur de paiement et l'état terminal
 * de la commande. Volontairement exhaustive et sans défaut implicite.
 */
export const ORDER_STATUS_TIMESTAMP_FIELD: Readonly<
  Record<Exclude<TicketOrderStatus, TicketOrderStatus.PENDING_PAYMENT>, string>
> = Object.freeze({
  [TicketOrderStatus.PAID]: 'paidAt',
  [TicketOrderStatus.FAILED]: 'failedAt',
  [TicketOrderStatus.EXPIRED]: 'expiredAt',
  [TicketOrderStatus.CANCELLED]: 'cancelledAt',
});
