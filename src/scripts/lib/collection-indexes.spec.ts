import { listIndexesOrEmpty } from './collection-indexes';

describe('listIndexesOrEmpty', () => {
  it('devrait renvoyer les index d’une collection existante', async () => {
    const indexes = [{ name: '_id_', key: { _id: 1 } }];
    await expect(listIndexesOrEmpty({ indexes: jest.fn().mockResolvedValue(indexes) })).resolves.toEqual(indexes);
  });

  it('devrait traiter une collection absente (code 26) comme sans index', async () => {
    const error = Object.assign(new Error('ns does not exist'), { code: 26 });
    await expect(listIndexesOrEmpty({ indexes: jest.fn().mockRejectedValue(error) })).resolves.toEqual([]);
  });

  it('devrait traiter le codeName NamespaceNotFound comme sans index', async () => {
    const error = Object.assign(new Error('ns does not exist'), { codeName: 'NamespaceNotFound' });
    await expect(listIndexesOrEmpty({ indexes: jest.fn().mockRejectedValue(error) })).resolves.toEqual([]);
  });

  it('devrait propager toute autre erreur', async () => {
    const error = Object.assign(new Error('unauthorized'), { code: 13 });
    await expect(listIndexesOrEmpty({ indexes: jest.fn().mockRejectedValue(error) })).rejects.toBe(error);
  });
});
