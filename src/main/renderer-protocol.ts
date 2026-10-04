import { isAbsolute, relative, resolve, sep } from 'path';

export const resolveRendererFilePath = (
  rendererRoot: string,
  requestUrl: string,
): string | null => {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== 'maria:' || url.host !== 'app') return null;

    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0')) return null;

    const requestedPath =
      pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolvedPath = resolve(rendererRoot, requestedPath);
    const relativePath = relative(rendererRoot, resolvedPath);

    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return null;
    }

    return resolvedPath;
  } catch {
    return null;
  }
};
