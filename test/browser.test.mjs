import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createApplication } from '../src/server.mjs';
import { cases } from '../public/cases.js';

let browser;
let server;
let origin;
let data;
before(async () => {
  data = mkdtempSync(join(tmpdir(), 'release-review-browser-'));
  ({ server } = createApplication({ data, boardEnabled: false }));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.KANE_CLI_CHROME_PATH ?? (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium'),
    headless: true,
  });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  if (data) rmSync(data, { recursive: true, force: true });
});

const expected = {
  1: { 'Restore response': '409', 'Confirmed owners after reload': 'Junho',
    'Customer notification': 'Restore blocked because the original slot is unavailable.' },
  2: { 'At zero minutes': 'Confirmed', '12:00 start option': 'Unavailable', '12:30 start option': 'Available',
    '12:00 response': '409', '12:30 response': 'Confirmed', 'Edit response': '409', 'Junho saved time': '12:30–13:30' },
  3: { 'Observed booking ID': '1', 'Observed booking status': 'Confirmed',
    'Confirmed count before restore': '0', 'Confirmed count after restore': '1' },
  4: { 'Zero-minute owner': 'Junho', 'Waiting owners at 30 minutes': 'Junho, Yuna', 'Lens owner at 12:30': 'none',
    'Thirty-minute owner': 'Junho' },
  5: { 'Concurrent confirmed': '1', 'Concurrent waiting': '1', 'Concurrent allocations': '2',
    'Persisted confirmed': '1', 'Persisted waiting': '1', 'Persisted allocations': '2' },
  6: { 'Parallel response IDs': '1, 1', 'Replay ID': '1', 'Changed request response': '409', 'New-key duplicate ID': '1',
    'Active reservations': '1', 'Cancellation replay': 'Same receipt' },
  7: { 'Browser received': 'Connection closed before response', 'Original receipt status': 'Waiting',
    'Observed booking ID': '2', 'Observed booking status': 'Confirmed', 'Live allocations': '2' },
  8: { 'Release first result': 'Junho Cancelled, Yuna Confirmed, 2 allocations',
    'Withdrawal first result': 'Junho Cancelled, Yuna Confirmed, 2 allocations' },
  9: { 'Observed booking ID': '3', 'Waiting owners after promotion': 'Yuna, Jimin', 'Cancellation response': '200',
    'Observed booking status': 'Cancelled', 'Jimin status': 'Waiting', 'Junho status': 'Confirmed' },
  10: { 'Old lookup': 'Waiting response held', 'Before releasing old lookup': 'Confirmed',
    'Late response status': 'Waiting', 'Rendered status afterward': 'Confirmed' },
  11: { 'Actual pointer target': 'Open reservation form' },
  12: { 'Observed booking ID': '1', 'Displayed owner': 'Minji', 'Permission check': '403', 'Observed booking status': 'Confirmed' },
};

for (const scenario of cases) {
  test(`Chrome ${scenario.id}. ${scenario.title}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    try {
      await page.goto(`${origin}/scenario?case=${scenario.id}`);
      await page.getByRole('heading', { name: `Scenario ${scenario.id} · ${scenario.title}` }).waitFor();
      for (const [index, { label }] of scenario.steps.entries()) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.getByRole('button', { name: `${label} ✓`, exact: true }).waitFor();
        if (scenario.id === 4) {
          const owner = index === 1 ? /No.*Lens/ : /Junho/;
          const lens = page.locator('#inventory').getByRole('row', { name: /^Lens/ });
          if (index === 1) assert.equal(await lens.count(), 0);
          else assert.match(await lens.innerText(), owner);
        }
        if (scenario.id === 12 && index === 0) {
          const ownerRow = page.locator('#reservations').getByRole('row', { name: /Minji/ });
          assert.equal(await ownerRow.getByRole('button').count(), 0);
        }
      }
      const values = await page.locator('#facts > div').evaluateAll((entries) =>
        Object.fromEntries(entries.map((entry) => [entry.firstElementChild.textContent, entry.lastElementChild.textContent])));
      for (const [key, value] of Object.entries(expected[scenario.id])) {
        assert.equal(values[key], value, key);
      }
      if ([1, 5, 12].includes(scenario.id)) {
        await page.reload();
        await page.getByText('Camera inspection gap:', { exact: false }).waitFor();
        const confirmed = page.locator('#reservations').getByRole('row', { name: /Confirmed/ });
        assert.equal(await confirmed.count(), 1);
        if (scenario.id === 1) assert.match(await confirmed.innerText(), /Junho/);
        if (scenario.id === 12) assert.match(await confirmed.innerText(), /Minji/);
      }
      if (scenario.id === 11) {
        await page.getByRole('button', { name: 'Open reservation form' }).click();
        await page.getByRole('heading', { name: 'Reservation form', exact: true }).waitFor();
      }
    } finally {
      await page.close();
    }
  });
}
