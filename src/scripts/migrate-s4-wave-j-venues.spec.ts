import { Types } from 'mongoose';
import type { Db } from 'mongodb';
import { runVenueMigration, venueMigration } from './migrate-s4-wave-j-venues';
import { RunnerDependencies, runGuardedMigration } from './lib/migration-runner';

describe('Wave J migration safety', () => {
  const owner = new Types.ObjectId();
  const venue = { _id: new Types.ObjectId(), user: owner, name: 'Existing venue', photos: ['existing-media'] };
  let venues: Record<string, jest.Mock>;
  let managers: Record<string, jest.Mock>;
  let db: Db;

  beforeEach(() => {
    venues = {
      find: jest.fn().mockReturnValue({ toArray: async () => [venue] }),
      indexes: jest.fn().mockResolvedValue([{ name: 'user_1', key: { user: 1 }, unique: true }]),
      updateOne: jest.fn(), createIndex: jest.fn(), dropIndex: jest.fn(), countDocuments: jest.fn(),
    };
    managers = {
      findOne: jest.fn(), createIndex: jest.fn(), findOneAndUpdate: jest.fn(),
      indexes: jest.fn(), countDocuments: jest.fn(),
    };
    const users = { find: () => ({ project: () => ({ toArray: async () => [{ _id: owner, fullName: 'Owner' }] }) }) };
    db = {
      databaseName: 'elintys-dev',
      collection: (name: string) => name === 'venueprofiles' ? venues : name === 'users' ? users : managers,
    } as unknown as Db;
  });
  afterEach(() => jest.restoreAllMocks());

  it('devrait ne faire aucune écriture ni mutation d’index en dry-run', async () => {
    const outcome = await runVenueMigration(db, false);
    expect(outcome.preflight).toEqual({ database: 'elintys-dev', venues: 1, pendingLinks: 1, legacyUniquePresent: true });
    expect(venues.updateOne).not.toHaveBeenCalled();
    expect(venues.dropIndex).not.toHaveBeenCalled();
    expect(managers.createIndex).not.toHaveBeenCalled();
    expect(managers.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('devrait exiger --backup-path avant toute connexion en mode apply', async () => {
    const deps: RunnerDependencies = {
      connect: jest.fn(), disconnect: jest.fn(), backup: jest.fn(), writeReport: jest.fn(), log: jest.fn(),
    };
    const env = { MONGODB_URI: 'mongodb://localhost/elintys-dev', ELINTYS_ENV: 'dev' };
    await expect(runGuardedMigration(venueMigration, ['--environment=dev', '--apply'], env, deps))
      .rejects.toThrow('BACKUP_PATH_REQUIRED');
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('devrait refuser la production avant toute connexion', async () => {
    const deps: RunnerDependencies = {
      connect: jest.fn(), disconnect: jest.fn(), backup: jest.fn(), writeReport: jest.fn(), log: jest.fn(),
    };
    const env = { MONGODB_URI: 'mongodb://localhost/elintys', ELINTYS_ENV: 'prod' };
    await expect(runGuardedMigration(venueMigration, ['--environment=prod'], env, deps)).rejects.toThrow();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('devrait refuser un index legacy inattendu avant mutation', async () => {
    venues.indexes.mockResolvedValue([{ name: 'user_1', key: { user: 1 }, unique: false }]);
    await expect(runVenueMigration(db, false)).rejects.toThrow('UNEXPECTED_LEGACY_INDEX');
    expect(venues.dropIndex).not.toHaveBeenCalled();
  });

  it('devrait refuser les salles orphelines et les liens gestionnaire incohérents', async () => {
    venues.find.mockReturnValue({ toArray: async () => [{ ...venue, user: new Types.ObjectId() }] });
    await expect(runVenueMigration(db, false)).rejects.toThrow('VENUE_OWNER_MISSING');
    venues.find.mockReturnValue({ toArray: async () => [{ ...venue, managerProfile: new Types.ObjectId() }] });
    managers.findOne.mockResolvedValue(null);
    await expect(runVenueMigration(db, false)).rejects.toThrow('VENUE_MANAGER_LINK_INVALID');
  });

  it('devrait accepter une salle déjà migrée sans changer son identité', async () => {
    const managerProfile = new Types.ObjectId();
    venues.find.mockReturnValue({ toArray: async () => [{ ...venue, managerProfile }] });
    managers.findOne.mockResolvedValue({ _id: managerProfile, user: owner });
    await runVenueMigration(db, false);
    expect(managers.findOne).toHaveBeenCalledWith({ _id: managerProfile, user: owner });
    expect(venues.updateOne).not.toHaveBeenCalled();
  });

  it('devrait lier, remplacer l’index legacy en dernier et valider après apply', async () => {
    const managerId = new Types.ObjectId();
    const calls: string[] = [];
    managers.createIndex.mockImplementation(async () => { calls.push('manager-index'); });
    managers.findOneAndUpdate.mockResolvedValue({ _id: managerId, user: owner });
    venues.updateOne.mockImplementation(async () => { calls.push('link'); return { matchedCount: 1 }; });
    venues.createIndex.mockImplementation(async () => { calls.push('ownership-index'); });
    venues.dropIndex.mockImplementation(async () => { calls.push('drop-legacy'); });
    venues.countDocuments.mockResolvedValue(0);
    venues.find
      .mockReturnValueOnce({ toArray: async () => [venue] })
      .mockReturnValueOnce({ toArray: async () => [{ ...venue, managerProfile: managerId }] });
    venues.indexes
      .mockResolvedValueOnce([{ name: 'user_1', key: { user: 1 }, unique: true }])
      .mockResolvedValueOnce([{ name: 'managerProfile_1_createdAt_-1__id_1', key: { managerProfile: 1 } }]);
    managers.indexes.mockResolvedValue([{ name: 'user_1', key: { user: 1 }, unique: true }]);
    managers.findOne.mockResolvedValue({ _id: managerId, user: owner });
    managers.countDocuments.mockResolvedValue(1);

    const outcome = await runVenueMigration(db, true);

    expect(calls).toEqual(['manager-index', 'link', 'ownership-index', 'drop-legacy']);
    expect(outcome.changes).toEqual({ linkedVenues: 1, legacyIndexDropped: true });
    expect(outcome.postValidation).toMatchObject({ passed: true, errors: [], checks: { orphanVenues: 0, venuesAfter: 1 } });
  });

  it('devrait signaler une modification concurrente', async () => {
    managers.findOneAndUpdate.mockResolvedValue({ _id: new Types.ObjectId(), user: owner });
    venues.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(runVenueMigration(db, true)).rejects.toThrow('CONCURRENT_VENUE_CHANGE');
    expect(venues.dropIndex).not.toHaveBeenCalled();
  });
});
