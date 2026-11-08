import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import { savePrivateScreenshot } from '../src/browser/screenshot';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'screenshot-test-'));
  const oldTmpdir = process.env.TMPDIR;
  const oldUmask = process.umask(0);
  process.env.TMPDIR = root;
  const image = Buffer.from('synthetic private image');
  const page = {
    screenshot: async (options: unknown) => {
      assert.deepEqual(options, { fullPage: true, type: 'png' });
      return image;
    },
  } as unknown as Page;
  try {
    const first = await savePrivateScreenshot(page, 'preview.png');
    const second = await savePrivateScreenshot(page, 'preview.png');
    assert.notEqual(dirname(first), dirname(second));
    for (const path of [first, second]) {
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(await readFile(path), image);
    }
    const before = await readdir(root);
    const failure = new Error('capture failed');
    await assert.rejects(savePrivateScreenshot({
      screenshot: async () => { throw failure; },
    } as unknown as Page, 'failure.png'), (error) => error === failure);
    assert.deepEqual(await readdir(root), before, 'failed captures must leave no directory');
    // A failed write must also remove its private directory.
    await assert.rejects(savePrivateScreenshot(page, '.'));
    assert.deepEqual(await readdir(root), before);
    console.log('Private screenshot permissions, isolation, contents and failure cleanup passed');
  } finally {
    process.umask(oldUmask);
    if (oldTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmpdir;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
