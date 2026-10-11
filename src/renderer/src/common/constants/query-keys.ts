export const queryKeys = {
  auth: {
    selectContext: ['auth', 'select-context'] as const,
    context: (generation: number) => ['auth', 'context', generation] as const,
    currentUser: (generation: number) =>
      ['auth', 'current-user', generation] as const,
    organizations: (generation: number) =>
      ['auth', 'organizations', generation] as const,
  },
};
