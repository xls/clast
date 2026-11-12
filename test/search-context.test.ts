import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { searchSymbols } from '../src/query/search.js';

let p: Project;

before(async () => {
  p = await createProject({
    'src/io/file.ts': `
export class FileSink {
  /** Appends the bytes to the open file. */
  write(data: Uint8Array): number { return this.fd.append(data); }
  private fd = { append(d: Uint8Array) { return d.length; } };
}
`,
    'src/io/log.ts': `
export class LogBuffer {
  write(line: string): void { this.lines.push(line); }
  private lines: string[] = [];
}
`,
    'src/net/transport.ts': `
interface Channel { send(d: Uint8Array): number; }
export class PlainTransport {
  constructor(private socketChannel: Channel) {}
  write(data: Uint8Array): number { return this.socketChannel.send(data); }
  socketChannel2(): Channel { return this.socketChannel; }
}
`,
    'src/net/socket.ts': `
export class SocketWriter {
  write(data: Uint8Array): number { return data.length; }
}
`,
    'src/imports.ts': `
/** Resolve the import paths of a file. */
export function resolveImports(paths: string[]): string[] { return paths.map(p => p.trim()); }
export class Resolver {
  resolve(name: string): string { return importPath(name); }
}
function importPath(n: string): string { return n; }
`,
  });
});
after(() => p.dispose());

const names = (q: string, n = 3): string[] => searchSymbols(p.ctx.db, q, { limit: n }).hits.map(h => h.sym.qname);

describe('search: a common name plus context words', () => {
  it('picks the definition whose container says it', () => {
    const hits = names('write socket');
    assert.ok(hits.slice(0, 2).includes('SocketWriter.write'), hits.join(', '));
  });

  it('uses what the body calls and on what receiver', () => {
    const hits = names('write socket channel');
    assert.ok(hits.slice(0, 2).includes('PlainTransport.write'), hits.join(', '));
    assert.ok(!hits.slice(0, 2).includes('LogBuffer.write'), hits.join(', '));
  });

  it('uses the doc comment', () => {
    assert.equal(names('write bytes file')[0], 'FileSink.write');
  });

  it('ranks same-named definitions with no context word near them below the ones that have it', () => {
    const hits = names('write socket', 10);
    const at = (n: string): number => (hits.includes(n) ? hits.indexOf(n) : 99);
    assert.ok(at('SocketWriter.write') < at('LogBuffer.write'), hits.join(', '));
    assert.ok(at('PlainTransport.write') < at('LogBuffer.write'), hits.join(', '));
  });

  it('does not outrank a name that covers more of the description', () => {
    assert.equal(names('resolve import path')[0], 'resolveImports');
  });
});
