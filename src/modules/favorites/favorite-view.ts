import { FavoriteTargetType } from './favorite.schema';

/**
 * Représentation d'un favori telle qu'exposée par l'API.
 *
 * `target` porte les informations métier nécessaires à l'affichage : sans elles
 * le client n'a qu'un ObjectId et ne peut afficher qu'une donnée technique
 * brute. `target` vaut `null` lorsque la cible a été supprimée depuis la mise
 * en favori — le client doit distinguer ce cas d'une erreur de chargement.
 */
export interface FavoriteTargetView {
  _id: string;
  /** Libellé métier : titre d'événement, nom commercial, nom de salle. */
  label: string;
  /** Chemin public canonique, calculé serveur (slug pour les événements).
   *  Absent quand la cible n'a pas de page publique (événement sans slug). */
  href?: string;
  imageUrl?: string;
  subtitle?: string;
  startDate?: string;
}

export interface FavoriteView {
  _id: string;
  targetType: FavoriteTargetType;
  targetId: string;
  createdAt?: string;
  /** `null` si la cible n'existe plus. */
  target: FavoriteTargetView | null;
}
