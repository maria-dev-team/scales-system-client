import type { ReactNode } from 'react';

type AuthShellProps = {
  children: ReactNode;
  description: string;
  title: string;
};

export function AuthShell({ children, description, title }: AuthShellProps) {
  return (
    <main className="grid min-h-full place-items-center bg-workspace px-6 py-10">
      <section className="w-full max-w-[520px] rounded-2xl border border-border bg-card p-8 shadow-[var(--shadow-surface)] sm:p-10">
        <header className="mb-8 text-center">
          <div
            aria-hidden="true"
            className="mx-auto grid size-12 place-items-center rounded-xl bg-primary text-lg font-extrabold text-primary-foreground shadow-md shadow-primary/20"
          >
            D
          </div>
          <h1 className="mt-5 text-2xl font-bold tracking-[-0.03em] text-card-foreground">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </header>
        {children}
      </section>
    </main>
  );
}
