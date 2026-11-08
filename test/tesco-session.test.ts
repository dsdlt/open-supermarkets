/** Offline regression coverage for UK cookie import and outbound domain isolation. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tesco-session-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Load after isolating HOME so no real session is read or overwritten.
    const { importSession, importSessionFromHeader } = require('../src/providers/tesco/import-session');
    const { getCookieString, saveSession } = require('../src/providers/tesco/auth');
    const { TescoProvider } = require('../src/providers/tesco/index');
    const file = path.join(home, 'export.json');
    const sessionFile = path.join(home, '.tesco', 'session.json');
    const stored = () => JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const cookie = (domain?: string) => ({ name: 'session', value: 'synthetic', ...(domain === undefined ? {} : { domain }) });
    const rejected = ['example.com', '.tesco.hu', 'eviltesco.com', 'tesco.com.evil.test', 'other.tesco.com', '', undefined];

    for (const exportCookies of [
      [cookie('.tesco.com'), ...rejected.map(cookie)],
      { cookies: [cookie('.tesco.com'), ...rejected.map(cookie)], origins: [] },
      { '.tesco.com': [cookie()], 'example.com': [cookie()], 'www.tesco.com': [cookie('example.com')] },
    ]) {
      fs.writeFileSync(file, JSON.stringify(exportCookies));
      importSession(file);
      assert.deepEqual(stored().cookies.map((c: any) => c.domain), ['.tesco.com']);
    }
    fs.writeFileSync(file, JSON.stringify([{ Name: 'auth', Value: 'synthetic', Domain: 'WWW.TESCO.COM' }, cookie('xapi.tesco.com')]));
    importSession(file);
    assert.equal(getCookieString(stored()), 'auth=synthetic; session=synthetic');

    const before = fs.readFileSync(sessionFile, 'utf8');
    fs.writeFileSync(file, JSON.stringify(rejected.map(cookie)));
    assert.throws(() => importSession(file), /No usable cookies/);
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), before);

    const legacy = {
      cookies: [cookie('.tesco.com'), ...rejected.map(cookie)],
      expiresAt: new Date(Date.now() + 3600000).toISOString(), lastLogin: new Date().toISOString(),
    };
    saveSession(legacy);
    assert.equal(stored().cookies.length, 1);
    // Bypass the new save control to simulate a pre-existing mixed-site session.
    fs.writeFileSync(sessionFile, JSON.stringify(legacy));
    const provider = new TescoProvider();
    let requests = 0;
    (provider as any).api.client.defaults.adapter = async (config: any) => {
      requests++;
      assert.equal(config.url, 'https://xapi.tesco.com/');
      assert.equal(config.headers.get('Cookie'), 'session=synthetic');
      return { data: [{ data: { search: { results: [] } } }], status: 200, statusText: 'OK', headers: {}, config };
    };
    await provider.search('milk');
    assert.equal(requests, 1);

    importSessionFromHeader('Cookie: auth=synthetic=token; sid=synthetic');
    assert.equal(getCookieString(stored()), 'auth=synthetic=token; sid=synthetic');
    console.log('Tesco session domain isolation passed');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
