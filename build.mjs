/**
 * Inlines site/index.html into the Worker bundle.
 *
 * The page is kept as a real .html file so it can be edited as HTML; this turns
 * it into a module the Worker imports. Run before `wrangler deploy`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('site/index.html', 'utf8');

// The page's own script is just a string as far as the Worker is concerned, so
// nothing would otherwise catch a syntax error in it until it hit a browser.
// new Function compiles the source without running it.
const script = html.match(/<script>([\s\S]*?)<\/script>/);
if (!script) {
  console.error('No inline <script> found in site/index.html — expected one.');
  process.exit(1);
}

try {
  // eslint-disable-next-line no-new-func
  new Function(script[1].replace('__AUTHED__', 'false').replace('__CONFIGURED__', 'false'));
} catch (err) {
  console.error('Page script failed to parse: ' + err.message);
  process.exit(1);
}

// Both placeholders must survive into the bundle for the Worker to substitute.
for (const token of ['__AUTHED__', '__CONFIGURED__']) {
  if (!html.includes(token)) {
    console.error('Missing ' + token + ' placeholder in site/index.html.');
    process.exit(1);
  }
}

writeFileSync('worker/site.js', 'export const SITE_HTML = ' + JSON.stringify(html) + ';\n');
console.log('Page script parses OK');
console.log('Inlined site/index.html (' + html.length + ' chars) into worker/site.js');
