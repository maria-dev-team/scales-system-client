export const queryKeys = {
  auth: {
    currentUser: (generation: number) =>
      ['auth', 'current-user', generation] as const,
  },
};
