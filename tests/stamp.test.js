// The release stamp: every local script/stylesheet/import gets ?v=<version>; CDN URLs untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stampHtml, stampJs, stampSite } from '../scripts/stamp-site.mjs';

test('HTML: local script and stylesheet get the version, CDN ones do not; the page knows its version', () => {
  const out = stampHtml(fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8'), 'abc1234');
  assert.match(out, /<meta name="app-version" content="abc1234">/);
  assert.match(out, /src="js\/admin\.js\?v=abc1234"/);
  assert.match(out, /href="css\/style\.css\?v=abc1234"/);
  assert.match(out, /src="https:\/\/accounts\.google\.com\/gsi\/client"/);
  assert.ok(!/fonts\.googleapis\.com[^"]*\?v=/.test(out));
});

test('JS: every relative import of every page module is stamped; absolute ones are not', () => {
  for (const f of fs.readdirSync(new URL('../js/', import.meta.url))) {
    const out = stampJs(fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), 'abc1234');
    const left = [...out.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(m => m[1]).filter(s => !s.endsWith('?v=abc1234'));
    assert.deepEqual(left, [], f);
  }
  assert.equal(stampJs("import { x } from './a.js';", 'v1'), "import { x } from './a.js?v=v1';");
  assert.equal(stampJs("await import(PDFJS + 'pdf.min.mjs')", 'v1'), "await import(PDFJS + 'pdf.min.mjs')");
});

test('a whole site folder: pages, modules and version.json; the uat/ copy is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  fs.mkdirSync(path.join(dir, 'js')); fs.mkdirSync(path.join(dir, 'uat'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<head></head><script type="module" src="js/app.js"></script>');
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), "import { a } from './ui.js';");
  fs.writeFileSync(path.join(dir, 'uat', 'index.html'), '<head></head><script src="js/app.js"></script>');
  stampSite(dir, 'r2');
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /js\/app\.js\?v=r2/);
  assert.match(fs.readFileSync(path.join(dir, 'js', 'app.js'), 'utf8'), /\.\/ui\.js\?v=r2/);
  assert.equal(fs.readFileSync(path.join(dir, 'uat', 'index.html'), 'utf8'), '<head></head><script src="js/app.js"></script>');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')), { version: 'r2' });
  assert.throws(() => stampSite(dir, 'bad version!'), /Bad version/);
});
