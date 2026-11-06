import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initVault } from '../src/init.js';

let root: string;
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('initVault', () => {
  it('makes what a folder needs to keep memory, once, and leaves what is there alone', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'noto-init-'));
    mkdirSync(path.join(root, '.noto'));
    writeFileSync(path.join(root, '.noto', 'access.yaml'), '# mine\n');
    expect(initVault(root)).toEqual(['.noto/brain.yaml', '.noto/.gitignore']);
    expect(readFileSync(path.join(root, '.noto', 'access.yaml'), 'utf8')).toBe('# mine\n');
    expect(existsSync(path.join(root, '.noto', 'scripts'))).toBe(true);
    expect(readFileSync(path.join(root, '.noto', '.gitignore'), 'utf8')).toContain('index.sqlite*');
    expect(initVault(root)).toEqual([]);
  });
});
