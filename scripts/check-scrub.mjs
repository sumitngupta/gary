#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const generic = [
  { name: 'home directory path', re: /\/home\/[a-z][a-z0-9_-]*\//g },
  { name: 'private IPv4 address', re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'tailnet address', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'non-fixture phone number', re: /(?<![\d.])\+?1?[ -]?\(?([2-9]\d{2})\)?[ -]?(\d{3})[ -]?(\d{4})(?!\d)/g, keep: (m) => m[1] !== '555' && m[2] !== '555' },
  { name: 'non-example email', re: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'secret-looking token', re: /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|EAA[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/g },
];

const privateTerms = process.env.GARY_SCRUB_DENYLIST && fs.existsSync(process.env.GARY_SCRUB_DENYLIST)
  ? fs.readFileSync(process.env.GARY_SCRUB_DENYLIST, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];
const allowEmails = new Set(['noreply@anthropic.com']);

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((f) => f && fs.existsSync(f) && !/\.(png|jpe?g|gif|webp|ico|woff2?|lock)$/.test(f) && f !== 'package-lock.json');

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('scrub-allow')) return;
    for (const rule of generic) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.keep && !rule.keep(m)) continue;
        if (rule.name === 'non-example email' && allowEmails.has(m[0])) continue;
        hits.push(`${file}:${i + 1} ${rule.name}`);
      }
    }
    for (const term of privateTerms) {
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line)) hits.push(`${file}:${i + 1} private term #${privateTerms.indexOf(term) + 1}`);
    }
  });
}

if (hits.length) {
  console.error(`scrub gate failed with ${hits.length} hit(s):`);
  for (const h of hits.slice(0, 200)) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`scrub gate passed: ${files.length} files, ${generic.length} generic rules, ${privateTerms.length} private terms`);
