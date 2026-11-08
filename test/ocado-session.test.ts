import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocado-session-'));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { OcadoProvider, importSession } = await import('../src/providers/ocado');
    const cookie = (name: string, overrides = {}) => ({
      name, value: 'synthetic', domain: '.ocado.com', path: '/', expires: -1, secure: true, ...overrides,
    });
    const cookies = [
      cookie('session', { domain: 'ocado.com', hostOnly: false }), cookie('host', { domain: 'www.ocado.com' }),
      cookie('other', { domain: '.example.com' }), cookie('suffix', { domain: '.ocado.com.evil.test' }),
      cookie('missing', { domain: undefined }), cookie('parent', { domain: '.com' }),
      cookie('expired', { expires: 1 }), cookie('api', { path: '/api' }),
      cookie('rootHost', { domain: 'ocado.com', hostOnly: true }),
      cookie('injected', { value: 'ok; stolen=secret' }), null,
    ];
    const input = path.join(home, 'export.json');
    fs.writeFileSync(input, JSON.stringify({ cookies }));
    importSession(input);
    const sessionFile = path.join(home, '.ocado/session.json');
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.deepEqual(saved.cookies.map((c: any) => c.name), ['session', 'host', 'expired', 'api', 'rootHost']);

    // Simulate a session saved by an older version: loading must also filter it.
    fs.writeFileSync(sessionFile, JSON.stringify({ cookies }));
    const provider = new OcadoProvider();
    const client = (provider as any).client;
    const sent: string[] = [];
    client.defaults.adapter = async (config: any) => {
      sent.push(config.headers.get('Cookie') ?? '');
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    await client.get('/api/cart');
    assert.equal(sent.pop(), 'api=synthetic; session=synthetic; host=synthetic');
    await client.get('/apix');
    assert.equal(sent.pop(), 'session=synthetic; host=synthetic');
    await assert.rejects(client.get('https://example.com/'), /outside the Ocado/);
    await assert.rejects(client.get('http://www.ocado.com/'), /outside the Ocado/);

    const redirect = client.defaults.beforeRedirect;
    const options = { protocol: 'https:', hostname: 'www.ocado.com', path: '/api/cart', headers: {} as any };
    redirect(options);
    assert.equal(options.headers.Cookie, 'api=synthetic; session=synthetic; host=synthetic');
    options.path = '/search';
    redirect(options);
    assert.equal(options.headers.Cookie, 'session=synthetic; host=synthetic');
    assert.throws(() => redirect({ ...options, hostname: 'evil.www.ocado.com' }), /outside the Ocado/);
    assert.throws(() => redirect({ ...options, protocol: 'http:' }), /outside the Ocado/);

    (provider as any).cookies.push(cookie('short', { expires: Date.now() / 1000 - 1 }));
    await client.get('/');
    assert.equal(sent.pop(), 'session=synthetic; host=synthetic');
    await provider.logout();
    await client.get('/api/cart');
    assert.equal(sent.pop(), '');

    fs.writeFileSync(input, JSON.stringify([cookie('other', { domain: '.example.com' })]));
    assert.throws(() => importSession(input), /No scoped Ocado cookies/);
    assert.equal(fs.existsSync(sessionFile), false);
    console.log('Ocado session scope, request matching, redirect and logout checks passed');
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
