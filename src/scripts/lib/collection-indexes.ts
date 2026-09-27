import type { IndexDescriptionInfo } from 'mongodb';

/** Code MongoDB `NamespaceNotFound` : la collection n'existe pas (encore). */
const NAMESPACE_NOT_FOUND = 26;

interface IndexedCollection {
  indexes(): Promise<IndexDescriptionInfo[]>;
}

/**
 * Liste les index d'une collection en traitant une collection absente comme
 * « aucun index ». Sur une base vierge (ex. première migration UAT), les
 * collections n'existent pas encore et `listIndexes` échoue en NamespaceNotFound.
 */
export async function listIndexesOrEmpty(collection: IndexedCollection): Promise<IndexDescriptionInfo[]> {
  try {
    return await collection.indexes();
  } catch (error) {
    const mongoError = error as { code?: unknown; codeName?: unknown };
    if (mongoError.code === NAMESPACE_NOT_FOUND || mongoError.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}
