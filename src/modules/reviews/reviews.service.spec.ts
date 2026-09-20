import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ReviewsService } from './reviews.service';
import { Review, ReviewContextType, ReviewDirection, ReviewTargetType } from './review.schema';
import { Event, EventStatus } from '../events/event.schema';
import { VendorProfile, VendorRequest, VendorRequestStatus } from '../vendors/vendor.schema';
import { VenueBooking, VenueBookingStatus, VenueProfile } from '../venues/venue.schema';
import { EventRegistration } from '../event-registration/event-registration.schema';
import { TicketPurchase } from '../tickets/ticket.schema';
import { VenueManagerProfile } from '../venue-managers/venue-manager.schema';

const chain = (value: unknown) => {
  const q: Record<string, jest.Mock | ((resolve: (v: unknown) => unknown) => Promise<unknown>)> = {};
  for (const name of ['lean', 'select', 'sort', 'skip', 'limit', 'populate']) q[name] = jest.fn().mockReturnValue(q);
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(value).then(resolve);
  return q;
};

describe('ReviewsService verified relations', () => {
  let module: TestingModule;
  let service: ReviewsService;
  const id = () => new Types.ObjectId();
  const author = id(); const organizer = id(); const context = id(); const vendor = id(); const venue = id(); const manager = id();
  type MockModel = {
    collection: { name: string };
    exists: jest.Mock;
    findById: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
    countDocuments: jest.Mock;
    aggregate: jest.Mock;
    findByIdAndDelete: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  const models: Record<string, MockModel> = {};
  const provide = (token: string) => {
    const model = {
      collection: { name: token.toLowerCase() }, exists: jest.fn(), findById: jest.fn(), create: jest.fn(),
      find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(), findByIdAndDelete: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    models[token] = model;
    return { provide: getModelToken(token), useValue: model };
  };

  beforeEach(async () => {
    module = await Test.createTestingModule({ providers: [ReviewsService,
      provide(Review.name), provide(Event.name), provide(VendorProfile.name), provide(VenueProfile.name),
      provide(EventRegistration.name), provide(TicketPurchase.name), provide(VendorRequest.name),
      provide(VenueBooking.name), provide(VenueManagerProfile.name),
    ] }).compile();
    service = module.get(ReviewsService);
    models[Review.name].create.mockImplementation(async (value) => ({ ...value, toObject: () => value }));
  });
  afterEach(async () => module.close());

  const eventDto = { targetType: ReviewTargetType.EVENT, contextType: ReviewContextType.EVENT, contextId: context.toString(), rating: 5, comment: 'Excellent' };

  it('autorise le participant inscrit sur un événement terminé et dérive la cible', async () => {
    models[Event.name].findById.mockReturnValue(chain({ _id: context, organizer, status: EventStatus.COMPLETED }));
    models[EventRegistration.name].exists.mockResolvedValue({ _id: id() });
    models[TicketPurchase.name].exists.mockResolvedValue(null);
    await service.create(author.toString(), eventDto);
    expect(models[Review.name].create).toHaveBeenCalledWith(expect.objectContaining({
      targetId: context, direction: ReviewDirection.PARTICIPANT_EVENT, schemaVersion: 2,
    }));
  });

  it('refuse un participant sans inscription ni billet', async () => {
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[EventRegistration.name].exists.mockResolvedValue(null);
    models[TicketPurchase.name].exists.mockResolvedValue(null);
    await expect(service.create(author.toString(), eventDto)).rejects.toThrow(ForbiddenException);
  });

  it('refuse l’auto-avis de l’organisateur', async () => {
    models[Event.name].findById.mockReturnValue(chain({ organizer: author, status: EventStatus.COMPLETED }));
    await expect(service.create(author.toString(), eventDto)).rejects.toThrow(ForbiddenException);
  });

  it('dérive organizer vers vendor depuis une demande acceptée', async () => {
    models[VendorRequest.name].findById.mockReturnValue(chain({ event: context, vendor, organizer, status: VendorRequestStatus.ACCEPTED }));
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[VendorProfile.name].findById.mockReturnValue(chain({ _id: vendor, user: id() }));
    await service.create(organizer.toString(), { ...eventDto, targetType: ReviewTargetType.VENDOR, contextType: ReviewContextType.VENDOR_REQUEST });
    expect(models[Review.name].create).toHaveBeenCalledWith(expect.objectContaining({ targetId: vendor, direction: ReviewDirection.ORGANIZER_VENDOR }));
  });

  it('dérive vendor vers organizer sans page publique organisateur', async () => {
    models[VendorRequest.name].findById.mockReturnValue(chain({ event: context, vendor, organizer, status: VendorRequestStatus.ACCEPTED }));
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[VendorProfile.name].findById.mockReturnValue(chain({ _id: vendor, user: author }));
    await service.create(author.toString(), { ...eventDto, targetType: ReviewTargetType.ORGANIZER, contextType: ReviewContextType.VENDOR_REQUEST });
    expect(models[Review.name].create).toHaveBeenCalledWith(expect.objectContaining({ targetId: organizer, direction: ReviewDirection.VENDOR_ORGANIZER }));
  });

  it('expose l’éligibilité inverse prestataire vers organisateur par interaction', async () => {
    models[VendorRequest.name].findById.mockReturnValue(chain({ event: context, vendor, organizer, status: VendorRequestStatus.ACCEPTED }));
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[VendorProfile.name].findById.mockReturnValue(chain({ _id: vendor, user: author }));
    models[Review.name].exists.mockResolvedValue(null);

    await expect(service.eligibilityForContext(
      author.toString(), ReviewContextType.VENDOR_REQUEST, context.toString(),
    )).resolves.toEqual(expect.objectContaining({ canReview: true, targetType: ReviewTargetType.ORGANIZER }));
  });

  it('autorise le gestionnaire exact après réservation terminée et confirmée', async () => {
    models[VenueBooking.name].findById.mockReturnValue(chain({ event: context, venue, organizer, status: VenueBookingStatus.CONFIRMED, bookingEnd: new Date(0) }));
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[VenueProfile.name].findById.mockReturnValue(chain({ _id: venue, managerProfile: manager }));
    models[VenueManagerProfile.name].findById.mockReturnValue(chain({ user: author }));
    await service.create(author.toString(), { ...eventDto, targetType: ReviewTargetType.ORGANIZER, contextType: ReviewContextType.VENUE_BOOKING });
    expect(models[Review.name].create).toHaveBeenCalledWith(expect.objectContaining({ direction: ReviewDirection.VENUE_ORGANIZER }));
  });

  it('expose l’éligibilité inverse gestionnaire vers organisateur par réservation', async () => {
    models[VenueBooking.name].findById.mockReturnValue(chain({ event: context, venue, organizer, status: VenueBookingStatus.CONFIRMED, bookingEnd: new Date(0) }));
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[VenueProfile.name].findById.mockReturnValue(chain({ _id: venue, managerProfile: manager }));
    models[VenueManagerProfile.name].findById.mockReturnValue(chain({ user: author }));
    models[Review.name].exists.mockResolvedValue(null);

    await expect(service.eligibilityForContext(
      author.toString(), ReviewContextType.VENUE_BOOKING, context.toString(),
    )).resolves.toEqual(expect.objectContaining({ canReview: true, targetType: ReviewTargetType.ORGANIZER }));
  });

  it('refuse une réservation future même confirmée', async () => {
    models[VenueBooking.name].findById.mockReturnValue(chain({ event: context, venue, status: VenueBookingStatus.CONFIRMED, bookingEnd: new Date(Date.now() + 60_000) }));
    await expect(service.create(author.toString(), { ...eventDto, targetType: ReviewTargetType.VENUE, contextType: ReviewContextType.VENUE_BOOKING })).rejects.toThrow(ForbiddenException);
  });

  it('refuse une cible choisie qui ne correspond pas à la relation dérivée', async () => {
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[EventRegistration.name].exists.mockResolvedValue({ _id: id() });
    models[TicketPurchase.name].exists.mockResolvedValue(null);
    await expect(service.create(author.toString(), { ...eventDto, targetType: ReviewTargetType.VENUE })).rejects.toThrow(ConflictException);
  });

  it('traduit la concurrence d’insertion en conflit métier', async () => {
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[EventRegistration.name].exists.mockResolvedValue({ _id: id() });
    models[TicketPurchase.name].exists.mockResolvedValue(null);
    models[Review.name].create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));
    await expect(service.create(author.toString(), eventDto)).rejects.toThrow(ConflictException);
  });

  it('refuse une collaboration prestataire refusée', async () => {
    models[VendorRequest.name].findById.mockReturnValue(chain({ event: context, vendor, status: VendorRequestStatus.DECLINED }));
    await expect(service.create(author.toString(), { ...eventDto, targetType: ReviewTargetType.VENDOR, contextType: ReviewContextType.VENDOR_REQUEST })).rejects.toThrow(ForbiddenException);
  });

  it('résout l’éligibilité prestataire avec une agrégation bornée sans N+1', async () => {
    const requestId = id();
    models[VendorProfile.name].findById.mockReturnValue(chain({ user: vendor }));
    models[VendorRequest.name].aggregate.mockResolvedValue([{ _id: requestId }]);
    models[Review.name].exists.mockResolvedValue(null);

    const result = await service.eligibilityForTarget(
      organizer.toString(), ReviewTargetType.VENDOR, vendor.toString(),
    );

    expect(result).toEqual(expect.objectContaining({ canReview: true, contextId: requestId.toString() }));
    expect(models[VendorRequest.name].aggregate).toHaveBeenCalledTimes(1);
    expect(models[VendorRequest.name].findById).not.toHaveBeenCalled();
    expect(models[Event.name].findById).not.toHaveBeenCalled();
  });

  it('résout l’éligibilité lieu avec une agrégation bornée sans N+1', async () => {
    const bookingId = id();
    models[VenueProfile.name].findById.mockReturnValue(chain({ managerProfile: manager }));
    models[VenueManagerProfile.name].findById.mockReturnValue(chain({ user: id() }));
    models[VenueBooking.name].aggregate.mockResolvedValue([{ _id: bookingId }]);
    models[Review.name].exists.mockResolvedValue(null);

    const result = await service.eligibilityForTarget(
      organizer.toString(), ReviewTargetType.VENUE, venue.toString(),
    );

    expect(result).toEqual(expect.objectContaining({ canReview: true, contextId: bookingId.toString() }));
    expect(models[VenueBooking.name].aggregate).toHaveBeenCalledTimes(1);
    expect(models[VenueBooking.name].findById).not.toHaveBeenCalled();
    expect(models[Event.name].findById).not.toHaveBeenCalled();
  });

  it('refuse un tiers sur une collaboration prestataire', async () => {
    models[VendorRequest.name].findById.mockReturnValue(chain({ event: context, vendor, organizer, status: VendorRequestStatus.ACCEPTED }));
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[VendorProfile.name].findById.mockReturnValue(chain({ _id: vendor, user: id() }));
    await expect(service.create(author.toString(), { ...eventDto, targetType: ReviewTargetType.VENDOR, contextType: ReviewContextType.VENDOR_REQUEST })).rejects.toThrow(ForbiddenException);
  });

  it('refuse un gestionnaire qui ne possède pas le lieu réservé', async () => {
    models[VenueBooking.name].findById.mockReturnValue(chain({ event: context, venue, organizer, status: VenueBookingStatus.CONFIRMED, bookingEnd: new Date(0) }));
    models[Event.name].findById.mockReturnValue(chain({ organizer, status: EventStatus.COMPLETED }));
    models[VenueProfile.name].findById.mockReturnValue(chain({ _id: venue, managerProfile: manager }));
    models[VenueManagerProfile.name].findById.mockReturnValue(chain({ user: id() }));
    await expect(service.create(author.toString(), { ...eventDto, targetType: ReviewTargetType.ORGANIZER, contextType: ReviewContextType.VENUE_BOOKING })).rejects.toThrow(ForbiddenException);
  });

  it('retourne uniquement les avis V2 et leur agrégat vérifié', async () => {
    models[Event.name].exists.mockResolvedValue({ _id: context });
    models[Review.name].find.mockReturnValue(chain([{ rating: 5 }]));
    models[Review.name].countDocuments.mockResolvedValue(1);
    models[Review.name].aggregate.mockResolvedValue([{ average: 5, count: 1 }]);
    const result = await service.findForTarget(ReviewTargetType.EVENT, context.toString());
    expect(result.summary).toEqual({ average: 5, count: 1 });
    expect(models[Review.name].find).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 2 }));
  });

  it('retourne un agrégat vide sans inventer 0/5', async () => {
    models[VendorProfile.name].exists.mockResolvedValue({ _id: vendor });
    models[Review.name].find.mockReturnValue(chain([]));
    models[Review.name].countDocuments.mockResolvedValue(0);
    models[Review.name].aggregate.mockResolvedValue([]);
    const result = await service.findForTarget(ReviewTargetType.VENDOR, vendor.toString());
    expect(result.summary).toEqual({ average: 0, count: 0 });
  });

  it('isole les avis privés reçus par organisateur', async () => {
    models[Review.name].find.mockReturnValue(chain([]));
    models[Review.name].countDocuments.mockResolvedValue(0);
    models[Review.name].aggregate.mockResolvedValue([]);
    await service.findOrganizerReceived(organizer.toString());
    expect(models[Review.name].find).toHaveBeenCalledWith({ schemaVersion: 2, targetType: ReviewTargetType.ORGANIZER, targetId: expect.any(Types.ObjectId) });
  });

  it('permet à l’auteur de modifier uniquement note et commentaire', async () => {
    models[Review.name].findById.mockReturnValue(chain({ author }));
    models[Review.name].findOneAndUpdate.mockReturnValue(chain({ rating: 4, comment: 'Corrigé' }));
    await service.update(context.toString(), author.toString(), { rating: 4, comment: 'Corrigé' });
    expect(models[Review.name].findOneAndUpdate).toHaveBeenCalledWith(expect.anything(), { rating: 4, comment: 'Corrigé' }, expect.anything());
  });

  it('refuse la modification par un autre compte', async () => {
    models[Review.name].findById.mockReturnValue(chain({ author: id() }));
    await expect(service.update(context.toString(), author.toString(), { rating: 4, comment: 'Non' })).rejects.toThrow(ForbiddenException);
  });

  it('permet à l’auteur de supprimer son avis', async () => {
    models[Review.name].findById.mockReturnValue(chain({ author }));
    models[Review.name].findByIdAndDelete.mockResolvedValue({});
    await expect(service.remove(context.toString(), author.toString())).resolves.toBeUndefined();
    expect(models[Review.name].findByIdAndDelete).toHaveBeenCalledWith(context.toString());
  });
});
