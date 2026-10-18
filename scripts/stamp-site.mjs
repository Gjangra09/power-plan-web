// Stamps a built site with its version so browsers never run old files after a release.
// GitHub Pages lets browsers keep files for 10 minutes; with ?v=<version> on every script and
// stylesheet, a new release has new URLs. The page also compares its version with version.json
// (always fetched fresh) and reloads once when a newer release is out (js/ui.js).
//   node scripts/stamp-site.mjs <site dir> <version>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function stampHtml(html, version, builtAt = new Date().toISOString()) {
  return html
    .replace(/(<script[^>]+src="(?!https?:)[^"?]+\.js)"/g, `$1?v=${version}"`)
    .replace(/(<link[^>]+href="(?!https?:)[^"?]+\.css)"/g, `$1?v=${version}"`)
    .replace(/<head>/, `<head>\n  <meta name="app-version" content="${version}">\n  <meta name="app-built" content="${builtAt}">`);
}

export function stampJs(js, version) {
  // relative module imports: from './x.js' and import('./x.js')
  return js.replace(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"?]+\.(?:js|mjs))(['"])/g, `$1$2?v=${version}$3`);
}

export function stampSite(dir, version) {
  if (!/^[\w.-]{1,40}$/.test(version)) throw new Error('Bad version: ' + version);
  const builtAt = new Date().toISOString();
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return e.name === 'uat' ? [] : walk(p);   // the UAT copy is stamped on its own
    return [p];
  });
  for (const file of walk(dir)) {
    if (file.endsWith('.html')) fs.writeFileSync(file, stampHtml(fs.readFileSync(file, 'utf8'), version, builtAt));
    else if (file.endsWith('.js')) fs.writeFileSync(file, stampJs(fs.readFileSync(file, 'utf8'), version));
  }
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, builtAt }) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  stampSite(process.argv[2], process.argv[3]);
  console.log(`Stamped ${process.argv[2]} as ${process.argv[3]}`);
}
