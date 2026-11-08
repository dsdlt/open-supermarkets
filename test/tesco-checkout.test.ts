/** Offline checkout regression: authenticated pages must not be captured. */
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { chromium } from 'playwright';
import { tescoCheckout } from '../src/browser/tesco-checkout';

const fs = require('fs');
const sessionFile = `${os.homedir()}/.tesco/session.json`;
const originalExists = fs.existsSync;
const originalRead = fs.readFileSync;
const originalLaunch = chromium.launch;
const cookies = [{ name: 'synthetic-session', value: 'offline-fixture' }];

async function main() {
  fs.existsSync = (path: unknown) => path === sessionFile || originalExists(path);
  fs.readFileSync = (path: unknown, ...args: unknown[]) => path === sessionFile
    ? JSON.stringify({ cookies }) : originalRead(path, ...args);
  try {
    for (const outcome of ['preview', 'payment_required', 'completed', 'error'] as const) {
      let closed = false;
      let checkoutClicks = 0;
      let screenshots = 0;
      let authenticated = false;
      let url = '';
      const waits: number[] = [];
      const page = {
        context: () => ({ addCookies: async (loaded: unknown) => {
          assert.deepEqual(loaded, cookies);
          authenticated = true;
        } }),
        goto: async (target: string) => {
          assert.ok(authenticated);
          url = target;
        },
        click: async () => {},
        waitForTimeout: async (ms: number) => {
          waits.push(ms);
          if (ms === 300000 && outcome === 'completed') url = 'https://www.tesco.com/order-confirmation';
        },
        textContent: async () => {
          if (outcome === 'error') throw new Error('synthetic page failure');
          return 'Trolley total: £42 Delivery: £3 Order number: ABC-123';
        },
        screenshot: async () => { screenshots++; throw new Error('Authenticated page capture forbidden'); },
        $: async () => ({ click: async () => { checkoutClicks++; url = 'https://www.tesco.com/payment'; } }),
        url: () => url,
      };
      chromium.launch = async () => ({
        newPage: async () => page,
        close: async () => { closed = true; },
      }) as any;

      if (outcome === 'error') {
        await assert.rejects(tescoCheckout(), /synthetic page failure/);
      } else {
        const result = await tescoCheckout(outcome === 'preview');
        assert.equal(result.status, outcome);
        assert.equal(result.total, 42);
        assert.equal(result.delivery_cost, outcome === 'preview' ? 0 : 3);
        assert.equal(checkoutClicks, outcome === 'preview' ? 0 : 1);
        assert.equal(waits.includes(300000), outcome !== 'preview');
        if (outcome === 'completed') assert.equal(result.order_id, 'ABC-123');
        if (outcome === 'payment_required') assert.equal(result.payment_url, url);
      }
      assert.equal(screenshots, 0);
      assert.ok(closed, 'browser closes on success and failure');
    }
  } finally {
    fs.existsSync = originalExists;
    fs.readFileSync = originalRead;
    chromium.launch = originalLaunch;
  }
  console.log('Tesco checkout: preview, payment, confirmation and error checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
