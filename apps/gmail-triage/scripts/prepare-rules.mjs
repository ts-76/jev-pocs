import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const personal = new URL('../config/rules.json', import.meta.url);
const fallback = new URL('../config/rules.default.json', import.meta.url);
const target = new URL('../src/generated/rules-config.json', import.meta.url);
const source = existsSync(personal) ? personal : fallback;
const config = JSON.parse(readFileSync(source, 'utf8'));

mkdirSync(new URL('../src/generated/', import.meta.url), { recursive: true });
writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
console.log('Using ' + (source === personal ? 'personal' : 'default') + ' Gmail rule configuration.');
