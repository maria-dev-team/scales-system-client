import { z } from 'zod';

import type { ScaleBarcodeProfile } from '../../shared/catalog';

export const scaleProfileSchema = z.object({
  format: z.literal('ean13-weight-v1'),
  prefix: z
    .string()
    .regex(/^\d{2}$/)
    .nullable(),
  enabled: z.boolean(),
  blocked_reason: z.null(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  issued_plu_ranges: z
    .array(
      z
        .tuple([
          z.number().int().min(1).max(99999),
          z.number().int().min(1).max(99999),
        ])
        .refine(([start, end]) => start <= end),
    )
    .max(50000),
});

export function mergeScaleProfiles(
  current: ScaleBarcodeProfile | null,
  incoming: ScaleBarcodeProfile,
): ScaleBarcodeProfile {
  const ranges = [
    ...(current?.issued_plu_ranges ?? []),
    ...incoming.issued_plu_ranges,
  ]
    .map(([start, end]): [number, number] => [start, end])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 1)
      previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return {
    ...(!current || incoming.revision > current.revision ? incoming : current),
    issued_plu_ranges: merged,
  };
}
