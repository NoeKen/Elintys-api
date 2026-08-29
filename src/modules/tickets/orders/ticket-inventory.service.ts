import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { TicketType, TicketTypeDocument } from '../ticket.schema';
import { InsufficientCapacityError } from '../../../shared/consistency/errors/consistency.errors';

export const INVENTORY_RELEASE_FAILED = 'TICKET_INVENTORY_RELEASE_FAILED';
export const INVENTORY_CONSUME_FAILED = 'TICKET_INVENTORY_CONSUME_FAILED';

export class TicketInventoryConsistencyError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'TicketInventoryConsistencyError';
  }
}

/**
 * Expression du stock déjà engagé : `sold + reserved`.
 *
 * `$ifNull` couvre les documents antérieurs à la Vague 5 qui n'ont pas encore
 * le champ `reserved` : sans lui, `$add` renverrait `null` et la comparaison
 * échouerait silencieusement (aucune réservation ne serait plus possible).
 */
const COMMITTED_EXPR = {
  $add: [{ $ifNull: ['$sold', 0] }, { $ifNull: ['$reserved', 0] }],
};

/**
 * Gardien de l'invariant central de stock :
 *
 *     sold + reserved <= quantity        (à tout instant)
 *     sold >= 0                          (garanti par min: 0 + filtres conditionnels)
 *     reserved >= 0
 *
 * TOUTES les mutations passent par une mise à jour conditionnelle atomique sur
 * un document unique (`findOneAndUpdate` / `updateOne` avec `$expr`). MongoDB
 * garantit l'atomicité au niveau d'un document : deux instances API concurrentes
 * ne peuvent pas franchir le même filtre.
 *
 * INTERDIT ET ABSENT ICI :
 *   - lecture de disponibilité suivie d'une écriture non conditionnelle
 *   - mutex / Map / Set en mémoire de processus comme garantie
 *
 * Le service reste correct avec N instances API.
 */
@Injectable()
export class TicketInventoryService {
  constructor(
    @InjectModel(TicketType.name)
    private readonly ticketTypeModel: Model<TicketTypeDocument>,
  ) {}

  /**
   * Réserve `quantity` unités si et seulement si
   * `sold + reserved + quantity <= quantity totale`.
   *
   * Retourne le document mis à jour, ou lève `InsufficientCapacityError`.
   */
  async reserve(
    ticketTypeId: string | Types.ObjectId,
    quantity: number,
    session: ClientSession,
  ): Promise<TicketTypeDocument> {
    const reserved = await this.ticketTypeModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(ticketTypeId),
        isFree: false,
        $expr: { $lte: [{ $add: [COMMITTED_EXPR, quantity] }, '$quantity'] },
      },
      { $inc: { reserved: quantity } },
      { new: true, session },
    );
    if (!reserved) throw new InsufficientCapacityError();
    return reserved;
  }

  /**
   * Consomme une réservation : `reserved -= q` et `sold += q`.
   *
   * L'invariant `sold + reserved <= quantity` est préservé par construction
   * (transfert, pas augmentation). Le filtre `reserved >= q` empêche toute
   * double consommation d'aboutir à `reserved < 0`.
   */
  async consumeReservation(
    ticketTypeId: string | Types.ObjectId,
    quantity: number,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.ticketTypeModel.updateOne(
      {
        _id: new Types.ObjectId(ticketTypeId),
        $expr: { $gte: [{ $ifNull: ['$reserved', 0] }, quantity] },
      },
      { $inc: { reserved: -quantity, sold: quantity } },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new TicketInventoryConsistencyError(INVENTORY_CONSUME_FAILED);
    }
  }

  /**
   * Libère une réservation : `reserved -= q`.
   *
   * Le filtre `reserved >= q` rend `reserved < 0` impossible. La garantie
   * « libérée exactement une fois » vient de la transition ACTIVE → terminal
   * du TicketHold, écrite dans la MÊME transaction que ce décrément.
   */
  async releaseReservation(
    ticketTypeId: string | Types.ObjectId,
    quantity: number,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.ticketTypeModel.updateOne(
      {
        _id: new Types.ObjectId(ticketTypeId),
        $expr: { $gte: [{ $ifNull: ['$reserved', 0] }, quantity] },
      },
      { $inc: { reserved: -quantity } },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new TicketInventoryConsistencyError(INVENTORY_RELEASE_FAILED);
    }
  }

  /** Disponibilité observable : `quantity - sold - reserved`, jamais négative. */
  static availableFrom(ticketType: {
    quantity: number;
    sold?: number;
    reserved?: number;
  }): number {
    return Math.max(0, ticketType.quantity - (ticketType.sold ?? 0) - (ticketType.reserved ?? 0));
  }
}
