import type { ComponentProps } from 'react';

import { cn } from '@renderer/common/lib/utils';

export function FormField({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid gap-3', className)}
      data-slot="form-field"
      {...props}
    />
  );
}
