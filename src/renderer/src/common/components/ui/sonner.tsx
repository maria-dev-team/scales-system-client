import { CircleCheck, Info, OctagonX, TriangleAlert } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

import { Spinner } from './spinner';

// shadcn Sonner, using the same placement and colours as the POS client.
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="top-center"
      richColors
      closeButton
      offset={72}
      mobileOffset={64}
      duration={6000}
      containerAriaLabel="Уведомления"
      className="toaster group"
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <OctagonX className="size-4" />,
        loading: <Spinner />,
      }}
      style={
        {
          '--normal-bg': 'var(--card)',
          '--normal-text': 'var(--card-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: 'Закрыть уведомление',
        classNames: {
          closeButton: 'min-h-0',
          actionButton: 'min-h-0',
          cancelButton: 'min-h-0',
        },
      }}
      {...props}
    />
  );
}
