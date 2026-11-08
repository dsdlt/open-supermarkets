import type { Page } from 'playwright';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename } from 'path';

/** Retain a diagnostic capture for the shopper in an owner-only directory. */
export async function savePrivateScreenshot(page: Page, filename: string): Promise<string> {
  // mkdtemp creates the directory with mode 0700, independent of a permissive umask.
  const directory = await mkdtemp(join(tmpdir(), 'open-supermarkets-'));
  const path = join(directory, basename(filename));
  try {
    // Do not let Playwright create a file using its default permissions.
    const image = await page.screenshot({ fullPage: true, type: 'png' });
    await writeFile(path, image, { mode: 0o600, flag: 'wx' });
    return path;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
