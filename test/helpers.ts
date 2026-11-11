import { SourceParser } from '../src/parser/index.js';
import type { ExSymbol, Extraction } from '../src/types.js';

const parser = new SourceParser();

/** Parse a source string as if it were the file `path` and return the extraction. */
export async function extractSource(path: string, source: string): Promise<Extraction> {
  const ex = await parser.extract(path, source);
  if (!ex) throw new Error(`unsupported file: ${path}`);
  return ex;
}

/** Compact, order-preserving view of symbols for assertions: "kind qname". */
export function symbolList(ex: Extraction): string[] {
  return ex.symbols.map(s => `${s.kind} ${s.qname}`);
}

export function sym(ex: Extraction, qname: string): ExSymbol {
  const s = ex.symbols.find(x => x.qname === qname);
  if (!s) throw new Error(`symbol not found: ${qname}. Have: ${ex.symbols.map(x => x.qname).join(', ')}`);
  return s;
}

/** Calls as "callerQname -> [receiver.]name" ("<file>" for file-level calls). */
export function callList(ex: Extraction): string[] {
  return ex.calls.map(c => {
    const caller = c.caller >= 0 ? ex.symbols[c.caller]!.qname : '<file>';
    return `${caller} -> ${c.receiver ? c.receiver + '.' : ''}${c.name}`;
  });
}

export function importList(ex: Extraction): string[] {
  return ex.imports.map(i => i.source);
}

export function heritageList(ex: Extraction): string[] {
  return ex.heritage.map(h => `${ex.symbols[h.symbol]!.qname} ${h.kind} ${h.name}`);
}

/** Lines on which an identifier occurs, or [] if never. */
export function occLines(ex: Extraction, name: string): number[] {
  const hit = ex.occ.find(([n]) => n === name);
  return hit ? hit[1].split(',').map(Number) : [];
}
