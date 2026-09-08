import { chromium } from 'playwright-core';

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await p.goto('http://127.0.0.1:8787', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
await p.screenshot({ path: '/tmp/civicfolio_ui.png' });
await b.close();
console.log('shot saved');