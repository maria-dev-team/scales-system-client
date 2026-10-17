import { expect, it } from 'vitest';

import type { ScaleBarcodeProfile } from '../../shared/catalog';
import { mergeScaleProfiles, scaleProfileSchema } from './profile';

const profile: ScaleBarcodeProfile = {
  format: 'ean13-weight-v1',
  prefix: '05',
  enabled: true,
  blocked_reason: null,
  revision: 2,
  issued_plu_ranges: [
    [1, 4],
    [8, 10],
  ],
};

it('accepts the current wire profile and rejects unsafe revisions and ranges', () => {
  expect(scaleProfileSchema.parse(profile)).toEqual(profile);
  for (const update of [
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { issued_plu_ranges: [[0, 1]] },
    { issued_plu_ranges: [[10, 8]] },
    { issued_plu_ranges: [[1, 100000]] },
    { issued_plu_ranges: [[1, 2, 3]] },
    { blocked_reason: 'barcode_conflict' },
    { prefix: '5' },
    { prefix: '27\n' },
  ])
    expect(
      scaleProfileSchema.safeParse({ ...profile, ...update }).success,
    ).toBe(false);
});

it('keeps known settings for stale and equally revised responses while accumulating PLU ranges', () => {
  expect(
    mergeScaleProfiles(profile, {
      ...profile,
      prefix: '27',
      enabled: false,
      revision: 1,
      issued_plu_ranges: [
        [4, 8],
        [15, 16],
      ],
    }),
  ).toEqual({
    ...profile,
    issued_plu_ranges: [
      [1, 10],
      [15, 16],
    ],
  });
  expect(
    mergeScaleProfiles(profile, {
      ...profile,
      prefix: '27',
      issued_plu_ranges: [[12, 13]],
    }),
  ).toEqual({
    ...profile,
    issued_plu_ranges: [
      [1, 4],
      [8, 10],
      [12, 13],
    ],
  });
});

it('accepts newer prefix settings without reducing previously issued PLUs', () => {
  const incoming = {
    ...profile,
    prefix: '27',
    revision: 3,
    issued_plu_ranges: [[25, 25]] as [number, number][],
  };
  expect(mergeScaleProfiles(profile, incoming)).toEqual({
    ...incoming,
    issued_plu_ranges: [
      [1, 4],
      [8, 10],
      [25, 25],
    ],
  });
  expect(
    mergeScaleProfiles(null, {
      ...profile,
      issued_plu_ranges: [
        [8, 10],
        [1, 4],
        [3, 5],
      ],
    }),
  ).toEqual({
    ...profile,
    issued_plu_ranges: [
      [1, 5],
      [8, 10],
    ],
  });
});
