// Pushes apps-script/ to an Apps Script project and moves its web-app deployment to the new
// version (same /exec URL), so the .gs files never have to be pasted by hand.
//
//   npm run deploy:uat                 tests → push → new version → redeploy (UAT)
//   npm run deploy:prod -- --promote   the same for prod; refuses without --promote
//
// One-time setup (see README "Deploy without copy-paste"): Apps Script API switched on,
// `npx clasp login`, and the local, git-ignored files .clasp.<env>.json and deploy-targets.json.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = process.argv[2];
const promote = process.argv.includes('--promote');
const fail = msg => { console.error('✖ ' + msg); process.exit(1); };

if (env !== 'uat' && env !== 'prod') fail('Usage: node scripts/deploy-gs.mjs uat|prod [--promote]');
if (env === 'prod' && !promote) fail('Prod changes only on "promote": run npm run deploy:prod -- --promote');

const project = `.clasp.${env}.json`;
if (!fs.existsSync(root + project)) fail(`${project} is missing: {"scriptId": "<Project Settings → Script ID>", "rootDir": "apps-script"}`);
const targets = fs.existsSync(root + 'deploy-targets.json') ? JSON.parse(fs.readFileSync(root + 'deploy-targets.json', 'utf8')) : {};
const deploymentId = targets[env] && targets[env].deploymentId;
if (!deploymentId) fail(`deploy-targets.json needs {"${env}": {"deploymentId": "AKfy…"}} (the id in the web-app /exec URL)`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', shell: opts.shell });
// clasp's own entry file run by Node: no shell, so arguments with spaces stay whole
const claspBin = fileURLToPath(new URL('node_modules/@google/clasp/build/src/index.js', new URL('..', import.meta.url)));
const clasp = (args, capture) => run(process.execPath, [claspBin, '-P', project, ...args], { capture });

// 1. Nothing goes out unless the engine copy is current and every test passes
console.log('1/4 Checking Engine.gs and running the tests…');
run('node', ['scripts/build-gs.mjs', '--check']);
run(process.execPath, ['--test', 'tests/*.test.js'], { capture: true });
console.log('    all tests pass');

const commit = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true }).trim();
const dirty = run('git', ['status', '--porcelain', 'apps-script'], { capture: true }).trim() ? ' + local changes' : '';
const description = `${env} ${commit}${dirty} ${new Date().toISOString().slice(0, 16)}`;

// 2. Replace the project's files with apps-script/ (the manifest too)
console.log(`2/4 Pushing apps-script/ to the ${env.toUpperCase()} project…`);
clasp(['push', '--force']);

// 3. Freeze it as a version, 4. point the existing deployment (same URL) at it
console.log('3/4 Creating a version…');
const out = clasp(['--json', 'create-version', description], true);
let version;
try { version = JSON.parse(out).versionNumber; } catch { /* reported below */ }
if (!version) fail('Could not read the new version number from: ' + out);
console.log(`    version ${version}`);
console.log('4/4 Moving the web app to it (same /exec URL)…');
clasp(['update-deployment', deploymentId, '-V', version, '-d', description]);
console.log(`✔ ${env.toUpperCase()} backend is now version ${version} (${description}).`);
console.log('  Time triggers already run the pushed code. Run phase0Check in the editor after changes that add tabs.');
