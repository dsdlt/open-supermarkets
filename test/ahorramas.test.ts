import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AhorramasProvider, AHORRAMAS_MAX_HTML_BYTES, parseProductTile, parseSearchPage, parseUnitPrice } from '../src/providers/ahorramas';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

async function main() {
  console.log('ahorramas provider');

  await check('parses multiple products and the normal product fields', () => {
    const products = parseSearchPage(fixture('ahorramas-products.html'));
    assert.strictEqual(products.length, 3);
    assert.deepStrictEqual(products[0], {
      product_uid: '70865',
      name: 'Leche Alipende 1l semidesnatada',
      retail_price: { price: 0.84 },
      unit_price: { measure: 'LITRO', price: 0.84 },
      in_stock: true,
      image_url: 'https://static.example.test/70865.jpg',
      provider: 'ahorramas',
      currency: 'EUR',
    });
  });

  await check('preserves an explicit out-of-stock value', () => {
    const products = parseSearchPage(fixture('ahorramas-products.html'));
    assert.strictEqual(products[1].in_stock, false);
    assert.deepStrictEqual(products[1].unit_price, { measure: 'KILO', price: 8.95 });
  });

  await check('allows products without optional fields or unit price', () => {
    const product = parseSearchPage(fixture('ahorramas-products.html'))[2];
    assert.strictEqual(product.product_uid, '90002');
    assert.strictEqual(product.unit_price, undefined);
    assert.strictEqual(product.image_url, undefined);
  });

  await check('parses comma and point decimal unit prices', () => {
    assert.deepStrictEqual(parseUnitPrice('0,84€/LITRO'), { measure: 'LITRO', price: 0.84 });
    assert.deepStrictEqual(parseUnitPrice('8.95€/KILO'), { measure: 'KILO', price: 8.95 });
    assert.deepStrictEqual(parseUnitPrice('2,50€/UNIDAD'), { measure: 'UNIDAD', price: 2.5 });
    assert.strictEqual(parseUnitPrice('2,50€'), undefined);
  });

  await check('bounds untrusted unit-price labels before matching', () => {
    const label = '0,84€/LITRO';
    assert.deepStrictEqual(parseUnitPrice(label.padStart(256)), { measure: 'LITRO', price: 0.84 });
    assert.strictEqual(parseUnitPrice(label.padStart(257)), undefined);
    assert.strictEqual(parseUnitPrice('9'.repeat(100_000)), undefined);
    assert.strictEqual(parseUnitPrice('9'.repeat(100_000) + '€/KILO'), undefined);
    assert.strictEqual(parseUnitPrice('9'.repeat(256)), undefined);
  });

  await check('omits oversized HTML unit prices while preserving the product', () => {
    const html = fixture('ahorramas-products.html').replace('0,84€/LITRO', '9'.repeat(100_000));
    const products = parseSearchPage(html);
    assert.strictEqual(products.length, 3);
    assert.strictEqual(products[0].unit_price, undefined);
    assert.deepStrictEqual(products[0].retail_price, { price: 0.84 });
    assert.deepStrictEqual(products[1].unit_price, { measure: 'KILO', price: 8.95 });
  });

  await check('returns an empty array for a genuine no-results page', () => {
    assert.deepStrictEqual(parseSearchPage(fixture('ahorramas-no-results.html')), []);
  });

  await check('rejects unexpected HTML instead of returning an empty array', () => {
    assert.throws(
      () => parseSearchPage(fixture('ahorramas-unexpected.html')),
      /unexpected search HTML/i
    );
  });

  await check('treats script and style contents as raw text', () => {
    const html = `${fixture('ahorramas-products.html')}
      <script type="application/ld+json">{"@type":"Product","sku":"raw-text","name":"Marker <!-- stays text","offers":{"price":"1.25","availability":"InStock"}}</script>
      <style>.example::before { content: "<!--"; }</style>
      <div class="product" data-pid="raw-text"></div>`;
    const products = parseSearchPage(html);
    assert.strictEqual(products.length, 4);
    assert.strictEqual(products[3].name, 'Marker <!-- stays text');
  });

  await check('bounds malformed-token processing in both exported parsers', () => {
    // A separate process lets the timeout interrupt a synchronous regression.
    const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', `
      const assert = require('node:assert');
      const { parseSearchPage, parseProductTile } = require('./src/providers/ahorramas');
      for (const parse of [parseSearchPage, parseProductTile]) {
        for (const prefix of ['<a', '</a', '<!', '<!--']) {
          assert.throws(() => parse(prefix.repeat(100000)), /unterminated HTML/);
        }
      }
    `], { cwd: path.join(__dirname, '..'), timeout: 5000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
  });

  await check('enforces the UTF-8 HTML size limit before parsing either entrypoint', () => {
    for (const parse of [parseSearchPage, parseProductTile]) {
      assert.throws(() => parse('x'.repeat(AHORRAMAS_MAX_HTML_BYTES + 1)), /size limit/);
      assert.throws(() => parse('é'.repeat(AHORRAMAS_MAX_HTML_BYTES / 2 + 1)), /size limit/);
    }
    const emptyPage = '<!-- ignored --> <p>sin resultados</p>';
    assert.deepStrictEqual(parseSearchPage(emptyPage.padEnd(AHORRAMAS_MAX_HTML_BYTES)), []);
    const products = fixture('ahorramas-products.html');
    assert.strictEqual(parseProductTile(products).product_uid, '70865');
  });

  await check('propagates oversized retailer HTML as an error', async () => {
    const provider = new AhorramasProvider();
    assert.strictEqual((provider as any).http.defaults.maxContentLength, AHORRAMAS_MAX_HTML_BYTES);
    (provider as any).http.get = async () => ({ data: 'x'.repeat(AHORRAMAS_MAX_HTML_BYTES + 1) });
    await assert.rejects(() => provider.search('leche'), /size limit/);
  });

  await check('rejects an empty query before making an HTTP request', async () => {
    const provider = new AhorramasProvider();
    let called = false;
    (provider as any).fetchPage = async () => {
      called = true;
      return [];
    };
    await assert.rejects(() => provider.search('   '), /query must not be empty/i);
    assert.strictEqual(called, false);
  });

  await check('applies limit and offset without fetching another page', async () => {
    const provider = new AhorramasProvider();
    const pages = new Map<number, any[]>([
      [0, Array.from({ length: 20 }, (_, i) => ({ product_uid: String(i), name: `p${i}` }))],
    ]);
    const calls: number[] = [];
    (provider as any).fetchPage = async (_query: string, start: number) => {
      calls.push(start);
      return pages.get(start) ?? [];
    };
    const products = await provider.search('leche', { offset: 10, limit: 5 });
    assert.deepStrictEqual(products.map((product: any) => product.product_uid), ['10', '11', '12', '13', '14']);
    assert.deepStrictEqual(calls, [0]);
  });

  await check('walks upstream pages for a request larger than 20', async () => {
    const provider = new AhorramasProvider();
    const page = (start: number) => Array.from({ length: 20 }, (_, i) => ({
      product_uid: String(start + i),
      name: `p${start + i}`,
    }));
    const calls: number[] = [];
    (provider as any).fetchPage = async (_query: string, start: number) => {
      calls.push(start);
      return page(start);
    };
    const products = await provider.search('leche', { offset: 10, limit: 50 });
    assert.strictEqual(products.length, 50);
    assert.strictEqual(products[0].product_uid, '10');
    assert.strictEqual(products[49].product_uid, '59');
    assert.deepStrictEqual(calls, [0, 20, 40]);
  });

  await check('stops at a short upstream page', async () => {
    const provider = new AhorramasProvider();
    const calls: number[] = [];
    (provider as any).fetchPage = async (_query: string, start: number) => {
      calls.push(start);
      return Array.from({ length: 3 }, (_, i) => ({ product_uid: String(start + i), name: `p${i}` }));
    };
    const products = await provider.search('leche', { limit: 50 });
    assert.strictEqual(products.length, 3);
    assert.deepStrictEqual(calls, [0]);
  });

  await check('propagates HTTP status errors with provider context', async () => {
    const provider = new AhorramasProvider();
    (provider as any).http.get = async () => {
      const error: any = new Error('Request failed with status code 429');
      error.response = { status: 429 };
      error.isAxiosError = true;
      throw error;
    };
    await assert.rejects(() => provider.search('leche'), /AhorraMás search failed \(HTTP 429\)/);
  });

  await check('registry declares only anonymous search', async () => {
    const { getManifest, createProvider } = await import('../src/providers/registry');
    const manifest = getManifest('ahorramas');
    assert.deepStrictEqual(manifest.capabilities, ['search']);
    assert.strictEqual(manifest.auth, 'none');
    assert.strictEqual((await createProvider('ahorramas')).name, 'ahorramas');
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
