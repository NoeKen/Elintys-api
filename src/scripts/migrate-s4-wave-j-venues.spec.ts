import mongoose, { Types } from 'mongoose';
import { migrateVenues } from './migrate-s4-wave-j-venues';

describe('Wave J migration safety', () => {
  const original = { ...process.env };
  const owner = new Types.ObjectId();
  const venue = { _id: new Types.ObjectId(), user: owner, name: 'Existing venue', photos: ['existing-media'] };
  let venues: Record<string, jest.Mock>;
  let managers: Record<string, jest.Mock>;
  beforeEach(() => {
    process.env.MONGODB_URI = 'mongodb://localhost/elintys-dev';
    process.env.ELINTYS_ENV = 'dev';
    venues = {
      find: jest.fn().mockReturnValue({ toArray: async () => [venue] }),
      indexes: jest.fn().mockResolvedValue([{ name: 'user_1', key: { user: 1 }, unique: true }]),
      updateOne: jest.fn(), createIndex: jest.fn(), dropIndex: jest.fn(),
    };
    managers = { findOne: jest.fn(), createIndex: jest.fn(), findOneAndUpdate: jest.fn() };
    const users = { find: () => ({ project: () => ({ toArray: async () => [{ _id: owner, fullName: 'Owner' }] }) }) };
    jest.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);
    jest.spyOn(mongoose, 'disconnect').mockResolvedValue();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    Object.defineProperty(mongoose.connection, 'db', { configurable: true, value: {
      databaseName: 'elintys-dev', collection: (name: string) => name === 'venueprofiles' ? venues : name === 'users' ? users : managers,
    } });
  });
  afterEach(() => { process.env = { ...original }; jest.restoreAllMocks(); });

  it('dry run performs no writes or index mutations and disconnects', async () => {
    await migrateVenues(false);
    expect(venues.updateOne).not.toHaveBeenCalled();
    expect(venues.dropIndex).not.toHaveBeenCalled();
    expect(managers.createIndex).not.toHaveBeenCalled();
    expect(managers.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mongoose.disconnect).toHaveBeenCalled();
  });
  it('requires backup before any connection in apply mode', async () => {
    await expect(migrateVenues(true)).rejects.toThrow('BACKUP_DIRECTORY_REQUIRED');
    expect(mongoose.connect).not.toHaveBeenCalled();
  });
  it('rejects production before connecting', async () => {
    process.env.ELINTYS_ENV = 'production';
    await expect(migrateVenues(false)).rejects.toThrow();
    expect(mongoose.connect).not.toHaveBeenCalled();
  });
  it('rejects unexpected legacy index before mutation', async () => {
    venues.indexes.mockResolvedValue([{ name: 'user_1', key: { user: 1 }, unique: false }]);
    await expect(migrateVenues(false)).rejects.toThrow('UNEXPECTED_LEGACY_INDEX');
    expect(venues.dropIndex).not.toHaveBeenCalled();
  });
  it('rejects orphan venues and mismatched manager links', async () => {
    venues.find.mockReturnValue({ toArray: async () => [{ ...venue, user: new Types.ObjectId() }] });
    await expect(migrateVenues(false)).rejects.toThrow('VENUE_OWNER_MISSING');
    venues.find.mockReturnValue({ toArray: async () => [{ ...venue, managerProfile: new Types.ObjectId() }] });
    managers.findOne.mockResolvedValue(null);
    await expect(migrateVenues(false)).rejects.toThrow('VENUE_MANAGER_LINK_INVALID');
  });
  it('accepts already migrated venue without changing identity', async () => {
    const managerProfile = new Types.ObjectId();
    venues.find.mockReturnValue({ toArray: async () => [{ ...venue, managerProfile }] });
    managers.findOne.mockResolvedValue({ _id: managerProfile, user: owner });
    await migrateVenues(false);
    expect(managers.findOne).toHaveBeenCalledWith({ _id: managerProfile, user: owner });
    expect(venues.updateOne).not.toHaveBeenCalled();
  });
});
