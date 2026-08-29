import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EventRegistrationDocument = HydratedDocument<EventRegistration>;

export enum EventRegistrationStatus {
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
}

/**
 * Inscription d'un participant à un événement (admission REGISTRATION_ONLY).
 *
 * Invariant métier garanti par DB :
 *   UN participant + UN événement = UNE inscription ACTIVE.
 *
 * Index partiel unique :
 *   - (eventId, participantId) où status = 'active'
 *
 * autoIndex: false — les index sont créés par le script de migration,
 * jamais implicitement au démarrage de l'API.
 */
@Schema({
  timestamps: true,
  collection: 'event_registrations',
  autoIndex: false,
})
export class EventRegistration {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  eventId!: Types.ObjectId;

  /** Identité serveur du participant authentifié. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  participantId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(EventRegistrationStatus),
    default: EventRegistrationStatus.ACTIVE,
  })
  status!: EventRegistrationStatus;
}

export const EventRegistrationSchema = SchemaFactory.createForClass(EventRegistration);

// Index de listing par événement (organisateur)
EventRegistrationSchema.index({ eventId: 1, status: 1 }, { name: 'event_reg_by_event' });

// Index de recherche par participant (mes inscriptions)
EventRegistrationSchema.index(
  { participantId: 1, status: 1 },
  { name: 'event_reg_by_participant', sparse: true },
);

/**
 * Contrainte DB principale — UN participant + UN événement = UNE inscription active.
 *
 * partial : ne s'applique qu'aux inscriptions ACTIVE pour un participant authentifié.
 * Une inscription annulée ne bloque pas la ré-inscription.
 */
EventRegistrationSchema.index(
  { eventId: 1, participantId: 1 },
  {
    unique: true,
    name: 'event_reg_unique_participant',
    partialFilterExpression: {
      participantId: { $type: 'objectId' },
      status: EventRegistrationStatus.ACTIVE,
    },
  },
);
