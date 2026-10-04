import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { resolveRendererFilePath } from './renderer-protocol';

describe('resolveRendererFilePath', () => {
  const rendererRoot = resolve('/app/out/renderer');

  it('maps the app root and assets inside the renderer bundle', () => {
    expect(resolveRendererFilePath(rendererRoot, 'maria://app/')).toBe(
      join(rendererRoot, 'index.html'),
    );
    expect(
      resolveRendererFilePath(rendererRoot, 'maria://app/assets/main.js'),
    ).toBe(join(rendererRoot, 'assets/main.js'));
  });

  it('rejects other hosts and encoded path traversal', () => {
    expect(
      resolveRendererFilePath(rendererRoot, 'maria://other/index.html'),
    ).toBeNull();
    expect(
      resolveRendererFilePath(rendererRoot, 'maria://app/%2E%2E%2Fsecret.txt'),
    ).toBeNull();
  });
});
