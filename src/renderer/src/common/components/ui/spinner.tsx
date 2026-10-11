import { Loader2 } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '@renderer/common/lib/utils';

export function Spinner({
  className,
  ...props
}: ComponentProps<typeof Loader2>) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn(
        'size-4 shrink-0 animate-spin motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}
