import type { ComponentProps } from 'react';

import { cn } from '@renderer/common/lib/utils';

type ButtonProps = ComponentProps<'button'> & {
  size?: 'default' | 'icon';
  variant?: 'default' | 'ghost';
};

export function Button({
  className,
  size = 'default',
  variant = 'default',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex min-w-0 max-w-full touch-manipulation select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-base font-semibold transition-[color,background-color,border-color,box-shadow,transform] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:active:translate-y-0 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-5',
        variant === 'ghost'
          ? 'border border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground'
          : 'bg-primary text-primary-foreground shadow-sm shadow-primary/15 hover:bg-primary/90',
        size === 'icon' ? 'size-12 shrink-0' : 'h-12 px-5 py-3',
        className,
      )}
      data-slot="button"
      {...props}
    />
  );
}
