import { ClientSession, Types } from 'mongoose';

/**
 * Modèle TicketType en mémoire reproduisant la SEULE garantie sur laquelle
 * repose la réservation de stock : l'atomicité MongoDB au niveau d'UN document.
 *
 * Utilisation : tests de concurrence déterministes exécutables en CI, sans
 * MongoDB. Ce n'est PAS une preuve que MongoDB se comporte ainsi — la preuve
 * réelle est produite par `src/scripts/verify-wave5-concurrency.ts`, exécuté
 * contre le replica set `elintys-dev`.
 *
 * Ce que le faux modèle reproduit fidèlement :
 *   - `findOneAndUpdate` / `updateOne` évaluent le filtre ET appliquent la
 *     mise à jour sans interruption (section critique indivisible) ;
 *   - un filtre non satisfait n'écrit rien et signale l'échec ;
 *   - les opérations concurrentes sont sérialisées dans un ordre arbitraire.
 *
 * Ce qu'il ne reproduit pas (hors périmètre) : transactions multi-documents,
 * niveaux de lecture, réseau.
 */
export interface FakeTicketTypeState {
  _id: Types.ObjectId;
  quantity: number;
  sold: number;
  /** `undefined` simule un document antérieur à la Vague 5. */
  reserved?: number;
  isFree: boolean;
}

type Filter = Record<string, unknown>;
type Update = { $inc?: Record<string, number> };

export class AtomicTicketTypeFakeModel {
  private readonly documents = new Map<string, FakeTicketTypeState>();
  /** Sérialise les sections critiques, comme le ferait le serveur MongoDB. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(documents: FakeTicketTypeState[]) {
    for (const document of documents) {
      this.documents.set(document._id.toString(), { ...document });
    }
  }

  snapshot(id: Types.ObjectId | string): FakeTicketTypeState {
    const found = this.documents.get(id.toString());
    if (!found) throw new Error('TICKET_TYPE_NOT_FOUND_IN_FAKE');
    return { ...found };
  }

  findOneAndUpdate(
    filter: Filter,
    update: Update,
    _options?: { new?: boolean; session?: ClientSession },
  ): Promise<FakeTicketTypeState | null> {
    return this.critical(() => {
      const document = this.match(filter);
      if (!document) return null;
      this.applyInc(document, update);
      return { ...document };
    });
  }

  updateOne(
    filter: Filter,
    update: Update,
    _options?: { session?: ClientSession },
  ): Promise<{ modifiedCount: number }> {
    return this.critical(() => {
      const document = this.match(filter);
      if (!document) return { modifiedCount: 0 };
      this.applyInc(document, update);
      return { modifiedCount: 1 };
    });
  }

  /**
   * Exécute la section critique de façon strictement sérialisée : deux appels
   * concurrents ne peuvent jamais entrelacer « évaluation du filtre » et
   * « application de la mise à jour ».
   */
  private critical<T>(work: () => T): Promise<T> {
    const result = this.tail.then(() => work());
    this.tail = result.catch(() => undefined);
    return result;
  }

  private match(filter: Filter): FakeTicketTypeState | undefined {
    const id = (filter._id as Types.ObjectId | undefined)?.toString();
    if (!id) return undefined;
    const document = this.documents.get(id);
    if (!document) return undefined;

    if (filter.isFree !== undefined && document.isFree !== filter.isFree) return undefined;
    if (filter.$expr && !evaluateExpr(filter.$expr as ExprNode, document)) return undefined;
    return document;
  }

  private applyInc(document: FakeTicketTypeState, update: Update): void {
    for (const [field, delta] of Object.entries(update.$inc ?? {})) {
      if (field === 'sold') document.sold += delta;
      if (field === 'reserved') document.reserved = (document.reserved ?? 0) + delta;
    }
  }
}

type ExprNode =
  | number
  | string
  | { $lte: [ExprNode, ExprNode] }
  | { $gte: [ExprNode, ExprNode] }
  | { $add: ExprNode[] }
  | { $ifNull: [ExprNode, ExprNode] };

/** Évaluateur minimal des expressions d'agrégation utilisées par le domaine. */
export function evaluateExpr(node: ExprNode, document: FakeTicketTypeState): number | boolean {
  if (typeof node === 'number') return node;
  if (typeof node === 'string') {
    const field = node.slice(1) as keyof FakeTicketTypeState;
    const value = document[field];
    return typeof value === 'number' ? value : Number.NaN;
  }
  if ('$lte' in node) {
    return (
      (evaluateExpr(node.$lte[0], document) as number) <=
      (evaluateExpr(node.$lte[1], document) as number)
    );
  }
  if ('$gte' in node) {
    return (
      (evaluateExpr(node.$gte[0], document) as number) >=
      (evaluateExpr(node.$gte[1], document) as number)
    );
  }
  if ('$add' in node) {
    return node.$add.reduce<number>(
      (sum, operand) => sum + (evaluateExpr(operand, document) as number),
      0,
    );
  }
  const candidate = evaluateExpr(node.$ifNull[0], document) as number;
  return Number.isNaN(candidate) ? (evaluateExpr(node.$ifNull[1], document) as number) : candidate;
}
