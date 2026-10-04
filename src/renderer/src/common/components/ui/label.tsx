import type { ComponentProps } from 'react';

import { cn } from '@renderer/common/lib/utils';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn(
        'text-sm font-semibold leading-none text-foreground',
        className,
      )}
      data-slot="label"
      {...props}
    />
  );
}
