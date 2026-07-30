import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
export class MediaImage {
  @Prop({ required: true, trim: true })
  url!: string;

  @Prop({ required: true, trim: true })
  publicId!: string;

  @Prop({ required: true, min: 1 })
  width!: number;

  @Prop({ required: true, min: 1 })
  height!: number;
}

export const MediaImageSchema = SchemaFactory.createForClass(MediaImage);

export function isManagedMediaImage(value: unknown): value is MediaImage {
  if (!value || typeof value !== 'object') return false;
  const media = value as Partial<MediaImage>;
  return (
    typeof media.url === 'string' &&
    media.url.length > 0 &&
    typeof media.publicId === 'string' &&
    media.publicId.length > 0 &&
    typeof media.width === 'number' &&
    media.width > 0 &&
    typeof media.height === 'number' &&
    media.height > 0
  );
}
