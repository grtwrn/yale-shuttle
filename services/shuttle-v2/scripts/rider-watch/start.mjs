import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedTestId } from '../testId.mjs';
import { attach } from './runner.mjs';

const base = process.env.BOT_BASE_URL || 'https://yale-shuttle.fly.dev';
const outputDir = path.resolve(process.env.WATCHER_DIR || 'scripts/.rider-watcher');
const executablePath = process.env.BOT_CHROMIUM_PATH ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium']
    .find(existsSync);
mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(outputDir, 'watcher.pid'), String(process.pid));
let browser, watcher, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await watcher?.stop();
  await browser?.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// Restart the browser after transport failures without running extra riders.
while (!stopping) {
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      permissions: ['geolocation'], geolocation: { latitude: 41.31, longitude: -72.925 },
    });
    await seedTestId(ctx);
    const page = await ctx.newPage();
    const response = await ctx.request.get(`${base}/api/buses`, { timeout: 30000 });
    if (!response.ok()) throw new Error(`Feed HTTP ${response.status()}`);
    const initialFeed = await response.json();
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    watcher = await attach({ page, ctx, initialFeed, outputDir, randomLines: true });
    console.log(`Watcher started: ${base}; artifacts: ${outputDir}`);
    while (!stopping && browser.isConnected() && !page.isClosed() && watcher.status().running)
      await new Promise(resolve => setTimeout(resolve, 5000));
    if (!stopping) throw new Error('Browser or instrumentation stopped');
  } catch (error) {
    console.error(new Date().toISOString(), error);
  } finally {
    await watcher?.stop().catch(console.error);
    await browser?.close().catch(console.error);
    watcher = undefined;
  }
  if (!stopping) await new Promise(resolve => setTimeout(resolve, 30000));
}
