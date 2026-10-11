export function isTrustedRendererUrl(value: string, devUrl?: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'maria:' &&
      url.hostname === 'app' &&
      url.pathname === '/'
    )
      return true;
    if (!devUrl) return false;
    const development = new URL(devUrl);
    return (
      ['http:', 'https:'].includes(development.protocol) &&
      url.origin === development.origin
    );
  } catch {
    return false;
  }
}
