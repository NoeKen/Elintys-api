import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { CreateReviewDto } from './create-review.dto';
import { ReviewTargetType } from '../review.schema';

describe('CreateReviewDto', () => {
  const valid = {
    targetType: ReviewTargetType.EVENT,
    targetId: new Types.ObjectId().toString(),
    rating: 5,
    comment: 'Une expérience remarquable.',
  };

  it.each(['', '   '])('refuse un commentaire vide après normalisation (%p)', async (comment) => {
    const dto = plainToInstance(CreateReviewDto, { ...valid, comment });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'comment')).toBe(true);
  });

  it('accepte un commentaire non vide et normalise ses espaces externes', async () => {
    const dto = plainToInstance(CreateReviewDto, {
      ...valid,
      comment: '  Une expérience remarquable.  ',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.comment).toBe('Une expérience remarquable.');
  });
});
