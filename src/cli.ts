#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Clast } from './engine.js';
import { SourceParser } from './parser/index.js';

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'index': {
      const root = resolve(rest.find(a => !a.startsWith('-')) ?? process.cwd());
      const clast = new Clast(root);
      const r = await clast.indexer.indexAll({ force: rest.includes('--force') });
      const s = clast.db.stats();
      console.log(
        `indexed ${root}: scanned ${r.scanned}, parsed ${r.parsed}, unchanged ${r.unchanged}, removed ${r.removed} ` +
        `in ${r.durationMs}ms (${r.workers} worker${r.workers === 1 ? '' : 's'})\n` +
        `files ${s.files}, symbols ${s.symbols}, calls ${s.calls}, names ${s.names}, imports ${s.imports}`
      );
      clast.close();
      break;
    }
    case 'parse':
    case 'ast': {
      const file = rest[0];
      if (!file) throw new Error(`usage: clast-ai ${cmd} <file>`);
      const source = readFileSync(file, 'utf-8');
      const parser = new SourceParser();
      if (cmd === 'ast') {
        console.log(await parser.dumpTree(file, source));
      } else {
        const ex = await parser.extract(file, source);
        if (!ex) throw new Error('unsupported file');
        if (rest.includes('--json')) {
          console.log(JSON.stringify(ex, null, 1));
        } else {
          for (const s of ex.symbols) {
            console.log(
              `${String(s.startLine).padStart(5)}-${String(s.endLine).padEnd(5)} ${s.kind.padEnd(10)} ${s.qname}` +
              `${s.exported ? ' [exported]' : ''}\n${' '.repeat(12)}sig: ${s.signature}` +
              (s.doc ? `\n${' '.repeat(12)}doc: ${s.doc.split('\n')[0]}` : '')
            );
          }
          console.log(`\ncalls (${ex.calls.length}):`);
          for (const c of ex.calls) {
            const caller = c.caller >= 0 ? ex.symbols[c.caller]!.qname : '<file>';
            console.log(`  ${caller} -> ${c.receiver ? c.receiver + '.' : ''}${c.name} @${c.line}${c.count > 1 ? ' x' + c.count : ''}`);
          }
          console.log(`\nimports (${ex.imports.length}):`);
          for (const i of ex.imports) console.log(`  ${i.source} {${i.names.join(', ')}} @${i.line}`);
          console.log(`\nheritage (${ex.heritage.length}):`);
          for (const h of ex.heritage) console.log(`  ${ex.symbols[h.symbol]!.qname} ${h.kind} ${h.name}`);
          console.log(`\nidentifiers: ${ex.occ.length} distinct, parse errors: ${ex.hadError}`);
        }
      }
      break;
    }
    default:
      console.error('usage: clast-ai <index|parse|ast> ...');
      process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
