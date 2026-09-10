/**
 * Inlines site/index.html into the Worker bundle.
 *
 * The page is kept as a real .html file so it can be edited as HTML; this turns
 * it into a module the Worker imports. Run before `wrangler deploy`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('site/index.html', 'utf8');
writeFileSync('worker/site.js', 'export const SITE_HTML = ' + JSON.stringify(html) + ';\n');
console.log('Inlined site/index.html (' + html.length + ' chars) into worker/site.js');
