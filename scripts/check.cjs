const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
if (!blocks.length) throw new Error('Script applicatif absent');
for (const [i, block] of blocks.entries()) new vm.Script(block[1], { filename: 'index-script-' + i + '.js' });
if (!html.includes('data:font/woff2')) throw new Error('Polices embarquées absentes');
console.log('HTML autonome : syntaxe JavaScript et polices embarquées vérifiées.');
