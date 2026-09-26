import {
  isElintysEnvironment,
  type ElintysEnvironment,
} from '../../config/elintys-environment';

/** Segment de dossier Cloudinary autorisé (CLOUDINARY_FOLDER). */
const MEDIA_FOLDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Racine Cloudinary des médias : `Elintys/<dossier>`.
 *
 * - `CLOUDINARY_FOLDER` (optionnel) fixe explicitement le dossier (ex. `uat`) ;
 * - sinon le dossier est dérivé de ELINTYS_ENV. `local` conserve `dev` : c'est
 *   le dossier historique des postes de développement branchés sur la base
 *   `elintys-dev`, dont les médias existants doivent rester supprimables.
 *   Définir `CLOUDINARY_FOLDER=local` pour isoler un poste.
 *
 * La même racine sert à créer les publicId ET à vérifier qu'un média
 * appartient bien à l'environnement courant avant suppression.
 */
export function getMediaRootPrefix(
  environment: ElintysEnvironment | undefined,
  folderOverride?: string,
): string {
  if (!isElintysEnvironment(environment)) {
    throw new Error('MEDIA_ENVIRONMENT_INVALID');
  }
  const folder = folderOverride?.trim();
  if (folder) {
    if (!MEDIA_FOLDER_PATTERN.test(folder)) throw new Error('MEDIA_FOLDER_INVALID');
    return `Elintys/${folder}`;
  }
  return `Elintys/${environment === 'local' ? 'dev' : environment}`;
}
