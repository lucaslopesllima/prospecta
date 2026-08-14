const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../../../e2e/node_modules/playwright');

(async () => {
  const postsRoot = path.join(__dirname, 'posts');
  const posts = fs.readdirSync(postsRoot)
    .filter((name) => name.startsWith('dia-'))
    .sort();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const post of posts) {
      const postDir = path.join(postsRoot, post);
      const outputDir = path.join(postDir, 'instagram');
      fs.mkdirSync(outputDir, { recursive: true });
      const page = await browser.newPage({
        viewport: { width: 1080, height: 1350 },
        deviceScaleFactor: 1,
      });
      await page.goto(`file://${path.join(postDir, 'carrossel.html')}`, {
        waitUntil: 'networkidle',
      });
      await page.evaluate(() => document.fonts.ready);
      const slides = page.locator('.slide');
      const count = await slides.count();
      if (count < 1 || count > 10) {
        throw new Error(`${post}: quantidade inválida de slides (${count})`);
      }
      for (let index = 0; index < count; index += 1) {
        await slides.nth(index).screenshot({
          path: path.join(
            outputDir,
            `slide-${String(index + 1).padStart(2, '0')}.jpg`,
          ),
          type: 'jpeg',
          quality: 90,
        });
      }
      await page.close();
      process.stdout.write(`${post}: ${count} slides\n`);
    }
  } finally {
    await browser.close();
  }
})();
