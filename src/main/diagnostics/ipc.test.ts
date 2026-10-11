// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isTrustedRendererUrl } from './trusted-renderer';

describe('diagnostics sender URL', () => {
  it('allows the packaged renderer and only the configured development origin', () => {
    expect(isTrustedRendererUrl('maria://app/')).toBe(true);
    expect(
      isTrustedRendererUrl('http://localhost:5173/', 'http://localhost:5173'),
    ).toBe(true);
    expect(
      isTrustedRendererUrl('http://localhost:5174/', 'http://localhost:5173'),
    ).toBe(false);
    expect(isTrustedRendererUrl('https://example.org/')).toBe(false);
    expect(isTrustedRendererUrl('maria://other/')).toBe(false);
    expect(isTrustedRendererUrl('file:///tmp/evil.html')).toBe(false);
    expect(isTrustedRendererUrl('not a URL')).toBe(false);
  });
});
