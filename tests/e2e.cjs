// End-to-end browser tests: drives the real app in headless Chromium.
// Run: npm run e2e   (needs the "playwright" package and its Chromium)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.gs': 'text/plain', '.md': 'text/plain' };

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newProject(p, name, members, opts = {}) {
  await p.waitForSelector('#npName');
  await p.fill('#npName', name);
  await p.fill('#npMembers', members);
  if (opts.trays) await p.fill('#npTrays', String(opts.trays));
  if (opts.cap) await p.fill('#npCap', String(opts.cap));
  await p.click('#dialogForm button[value=ok]');
  await p.waitForSelector('body:not(.choosing)');
}

async function scan(p, text) {
  await p.fill('#scanInput', text);
  await p.press('#scanInput', 'Enter');
  await sleep(120);
}

const SAMSUNG = (n) => `(L)64GB 2Rx4 PC5-6400B-RA1-1312-XT(S)80CE0426074390${String(n).padStart(4, '0')}(P)MDRR644QDBC2-3L000(M)H0D8000`;
const MICRON = (n) => `(L)64GB 2RX4 PC5-6400B-RA1-1312-XT(S)802C1A2634D4${String(n).padStart(6, '0')}(P)MTC40F2046S1RC64BH1(c)QSFF`;

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const launch = { args: ['--no-sandbox'] };
  if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: '<-loopback>,localhost,127.0.0.1' };
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const pageErrors = [];
  p.on('pageerror', (e) => pageErrors.push(e.message));

  // --- start screen
  await p.goto(base);
  await p.waitForSelector('#startScreen:not([hidden])');
  check('start screen shows on first visit', await p.isVisible('[data-start=new]'));
  check('nothing is opened or created automatically', !(await p.isVisible('.tabs')) && (await p.$$('.proj')).length === 0);

  // --- create + scan
  await p.click('[data-start=new]');
  await newProject(p, 'Alpha', 'Ashu\nRonny', { trays: 10, cap: 2 });
  check('new project opens on the Scan tab', (await p.textContent('#wsName')) === 'Alpha');
  await scan(p, SAMSUNG(1));
  check('real Samsung label → tray 1, brand + gen detected', (await p.textContent('#result .result-tray')).trim() === '1' && /Samsung/.test(await p.textContent('#result')) && /DDR5/.test(await p.textContent('#result')));
  await scan(p, SAMSUNG(2));
  await scan(p, SAMSUNG(3));
  check('tray limit 2 → third stick opens tray 2', (await p.textContent('#result .result-tray')).trim() === '2');
  await scan(p, MICRON(1));
  check('real Micron label → part without "(c)QSFF"', /MTC40F2046S1RC64BH1(?!\(c\))/.test(await p.textContent('#result .result-side')) && !/QSFF/.test(await p.textContent('#result .result-side')));
  await scan(p, SAMSUNG(1));
  check('same serial again → duplicate, not placed', /Duplicate serial/i.test(await p.textContent('#result .result-kicker')));

  // --- persistence across reload
  await p.reload();
  await p.waitForSelector('#startScreen:not([hidden])');
  check('reload returns to the start screen with the project listed', /Alpha[\s\S]*5 scans/.test(await p.textContent('#startScreen')));
  await p.click('.proj:has-text("Alpha") [data-start=open]');
  await p.click('[data-view=log]');
  check('scans survive a reload', /5 scans/.test(await p.textContent('#logPager')));

  // --- second project + switcher
  await p.click('#wsButton');
  await p.click('[data-pm=new]');
  await newProject(p, 'Beta', 'Sam');
  await scan(p, MICRON(2));
  await p.click('#wsButton');
  await p.waitForSelector('#projMenu:not([hidden])');
  check('switcher lists the other project', /Alpha/.test(await p.textContent('#projMenu')));
  await p.click('[data-pm=open]');
  await sleep(300);
  check('switcher opens it', (await p.textContent('#wsName')) === 'Alpha');
  await p.click('#wsButton');
  await p.keyboard.press('Escape');
  check('switcher closes with Escape', await p.isHidden('#projMenu'));

  // --- data check flags a manual mistake
  await p.click('[data-view=log]');
  await p.click('#logTable tr:has-text("MTC40F2046S1RC64BH1") [data-edit]');
  await p.fill('#edTray', '1');
  await p.click('#dialogForm button[value=save]');
  await p.click('[data-view=dashboard]');
  check('data check flags a tray with two different parts', /more than one part number/.test(await p.textContent('#health')));

  // --- excel export
  await p.click('[data-view=log]');
  const [xl] = await Promise.all([p.waitForEvent('download'), p.click('#exportXlsxBtn')]);
  const xlPath = await xl.path();
  check('Excel export downloads a file', xlPath && fs.statSync(xlPath).size > 5000);

  // --- backup all + restore
  await p.click('[data-view=settings]');
  const [bk] = await Promise.all([p.waitForEvent('download'), p.click('#backupAllBtn')]);
  const bkFile = path.join(ROOT, 'tests', '.tmp-backup.json');
  await bk.saveAs(bkFile);
  const bkData = JSON.parse(fs.readFileSync(bkFile, 'utf8'));
  check('backup-all contains both projects', bkData.projects.length === 2 && bkData.projects.reduce((n, x) => n + x.scans.length, 0) === 6);

  // --- delete → recently deleted → restore → delete forever
  await p.click('#deleteWsBtn');
  await p.waitForSelector('#dialog[open]');
  check('delete shows a warning with the scan count', /Warning[\s\S]*5 scans/.test(await p.textContent('#dialogForm')));
  await p.click('#dialogForm button[value=cancel]');
  check('cancel keeps the project', (await p.textContent('#wsName')) === 'Alpha');
  await p.click('#deleteWsBtn');
  await p.click('#dialogForm button[value=trash]');
  await p.waitForSelector('#startScreen:not([hidden])');
  check('deleted project goes to Recently deleted', /Recently deleted \(1\)/.test(await p.textContent('#startScreen')));
  await p.click('.trash summary');
  await p.click('[data-start=restore]');
  await sleep(300);
  check('restore brings it back', (await p.$$('.proj:has-text("Alpha") [data-start=open]')).length === 1);
  await p.click('.proj:has-text("Alpha") [data-start=open]');
  await p.click('[data-view=settings]');
  await p.click('#deleteWsBtn');
  await p.click('#dialogForm button[value=trash]');
  await p.waitForSelector('#startScreen:not([hidden])');
  await p.click('.trash summary');
  await p.click('[data-start=purge]');
  await p.fill('#purgeName', 'Alph');
  check('delete forever needs the exact name', await p.isDisabled('#dialogForm button[value=purge]'));
  await p.fill('#purgeName', 'Alpha');
  await p.click('#dialogForm button[value=purge]');
  await sleep(300);
  check('delete forever removes it', !/Alpha/.test(await p.textContent('#startScreen')));

  // --- restore from the backup file adds projects, replaces nothing
  await p.setInputFiles('[data-start=restorefile]', bkFile);
  await p.waitForSelector('#dialog[open]');
  await p.click('#dialogForm button[value=ok]');
  await sleep(600);
  const names = await p.$$eval('.proj .name', (n) => n.map((x) => x.textContent));
  check('restoring adds "(restored)" copies next to existing projects', names.includes('Beta') && names.includes('Alpha (restored)') && names.includes('Beta (restored)'));
  fs.unlinkSync(bkFile);

  // --- a failed save never shows a tray number
  await p.click('.proj:has-text("Beta (restored)") [data-start=open]');
  await p.evaluate(() => {
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (this.name === 'scans') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return orig.apply(this, a);
    };
  });
  await scan(p, MICRON(3));
  check('storage failure shows NOT SAVED', /NOT SAVED/.test(await p.textContent('#result')));
  check('…and the scan is not listed as placed', !/D4000003/.test(await p.textContent('#recentTable')));
  await p.click('[data-view=settings]');
  // The panel refreshes asynchronously; earlier visits to Settings left older text in it.
  await p.waitForFunction(() => /Recent problems: 1/.test(document.querySelector('#aboutInfo').textContent), null, { timeout: 5000 }).catch(() => {});
  check('the problem is recorded in About & diagnostics', /Recent problems: 1/.test(await p.textContent('#aboutInfo')), await p.textContent('#aboutInfo'));

  check('no unexpected page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // --- phone layout
  const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await m.newPage();
  await mp.goto(base);
  await mp.waitForSelector('#startScreen:not([hidden])');
  check('phone: start screen fits without sideways scrolling', !(await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await m.close();

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
