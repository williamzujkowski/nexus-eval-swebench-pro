import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { main, VERSION } from './cli.js';

describe('CLI version', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the package version for --version', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(main(['node', 'cli.js', '--version'])).resolves.toBe(0);

    expect(VERSION).toBe(packageJson.version);
    expect(stdout).toHaveBeenCalledWith(`nexus-eval-swebench-pro ${packageJson.version}\n`);
  });
});
