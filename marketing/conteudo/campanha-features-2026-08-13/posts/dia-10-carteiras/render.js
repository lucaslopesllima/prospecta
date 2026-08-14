const { chromium } = require('../../../../e2e/node_modules/playwright');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
    await page.goto('file://' + path.join(__dirname, 'carrossel.html'));
    const slides = page.locator('.slide');
    for (let i = 0; i < await slides.count(); i += 1) await slides.nth(i).screenshot({ path: path.join(__dirname, 'instagram', 'slide-' + String(i + 1).padStart(2, '0') + '.png') });
  } finally { await browser.close(); }
})();
