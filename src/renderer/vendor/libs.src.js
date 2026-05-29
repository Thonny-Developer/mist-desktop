/* Vendor bundle SOURCE.
 *
 * This file is NOT loaded by the app directly — it is bundled by esbuild into
 * `libs.js` (an offline, browser-ready ESM module) via `npm run build:vendor`,
 * which also runs automatically on `postinstall`. Bundling is required because
 * highlight.js's ESM entry chains to CommonJS internals that a browser ESM
 * loader cannot consume on its own.
 *
 * Only a curated set of languages is registered to keep the bundle lean — add
 * more by importing the matching highlight.js/lib/languages/*.js file below.
 */
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';

import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);

export { marked, hljs };
