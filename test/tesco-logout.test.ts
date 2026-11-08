/** Offline regression: logout removes credentials from a reused Tesco client. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mock } from 'node:test';

// Capture the session path in a temporary home before loading the auth module.
const os = require('node:os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tesco-logout-'));
const homedir = mock.method(os, 'homedir', () => directory);
const { TescoProvider } = require('../src/providers/tesco');
homedir.mock.restore();
const sessionFile = path.join(directory, '.tesco', 'session.json');

async function main() {
  try {
    fs.mkdirSync(path.dirname(sessionFile));
    fs.writeFileSync(sessionFile, JSON.stringify({
      cookies: [{ name: 'session', value: 'synthetic-account' }],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }));
    const provider = new TescoProvider();
    const api = provider.getAPI();
    const requests: { operation: string; cookie: unknown }[] = [];
    // Keep Axios's real header merging; intercept only the network transport.
    (api as any).client.defaults.adapter = async (config: any) => {
      const operation = JSON.parse(config.data)[0].operationName;
      const cookie = config.headers.get('Cookie');
      requests.push({ operation, cookie });
      if (!cookie) throw new Error('Unauthenticated synthetic request');
      return {
        data: [{ data: { basket: { id: 'synthetic-basket' }, orders: [] } }],
        status: 200, statusText: 'OK', headers: {}, config,
      };
    };
    assert.equal(await provider.isAuthenticated(), true);
    assert.equal(requests[0].cookie, 'session=synthetic-account');

    await provider.logout();
    assert.equal(fs.existsSync(sessionFile), false);
    assert.equal(provider.getAPI(), api);
    assert.equal(await provider.isAuthenticated(), false);
    await assert.rejects(provider.getBasket(), /Unauthenticated/);
    await assert.rejects(provider.getOrders(), /Unauthenticated/);
    await assert.rejects(provider.addToBasket('123', 1), /Unauthenticated/);
    await assert.rejects(api.getBasket(), /Unauthenticated/);
    assert.ok(requests.slice(1).every(request => !request.cookie));
    await provider.logout(); // Idempotent when the saved session is absent.

    // Even a filesystem cleanup failure must clear the in-memory credential.
    api.setAuthCookies('session=synthetic-account');
    fs.mkdirSync(sessionFile);
    await assert.rejects(provider.logout());
    assert.equal(await provider.isAuthenticated(), false);
    assert.ok(!requests.at(-1)?.cookie);
    console.log('Tesco logout: saved session and reused client credentials cleared');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
