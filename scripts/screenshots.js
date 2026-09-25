// Loads the unpacked extension into Chromium, opens a spec on GitHub, drives
// focus mode with the keyboard and saves screenshots along the way.
//
//   npm run screenshots -- [github-url] [output-dir]
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://github.com/github/spec-kit/blob/main/spec-driven.md';
const out = process.argv[3] ?? '.context/screenshots';
const extension = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(out, { recursive: true });

for (const colorScheme of ['dark', 'light']) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    colorScheme,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.markdown-body').first().waitFor();

  // Same path as clicking the toolbar button.
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    await toggle(tab);
  });
  await page.locator('#spec-focus-root').waitFor();
  const shot = (name) =>
    page.waitForTimeout(400).then(() => page.screenshot({ path: `${out}/${colorScheme}-${name}.png` }));

  await shot('1-open');
  for (let i = 0; i < 5; i++) await page.keyboard.press('j');
  await shot('2-reading');
  await page.keyboard.press('c');
  await shot('3-no-context');
  await page.keyboard.press('?');
  await shot('4-help');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/${colorScheme}-5-back-on-page.png` });
  console.log(
    colorScheme,
    await page.evaluate(() => (document.querySelector('#spec-focus-root') === null ? 'closed' : 'still open')),
  );
  await context.close();
}
