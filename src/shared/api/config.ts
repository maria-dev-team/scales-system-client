const apiUrl = import.meta.env.VITE_API_URL as string | undefined;

if (!apiUrl) throw new Error('VITE_API_URL is required.');

export const apiConfig = {
  apiUrl: apiUrl.replace(/\/+$/g, ''),
};
