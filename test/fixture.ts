import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Clast } from '../src/engine.js';
import { parseConfig } from '../src/config/index.js';
import { ToolContext } from '../src/tools/context.js';

/** Files of a small multi-language project used by the integration tests. */
export const FIXTURE: Record<string, string> = {
  '.gitignore': 'ignored_dir/\n*.gen.ts\n',
  'src/math/area.ts': `/** Area of a circle. */
export function circleArea(radius: number): number {
  return Math.PI * square(radius);
}

export function square(x: number): number {
  return x * x;
}
`,
  'src/math/volume.ts': `import { circleArea } from './area.js';

/** Volume of a cylinder. */
export function cylinderVolume(radius: number, height: number): number {
  return circleArea(radius) * height;
}
`,
  'src/shapes/shape.ts': `export interface Shape {
  area(): number;
  describe(): string;
}

export abstract class BaseShape implements Shape {
  abstract area(): number;

  /** Human readable description. */
  describe(): string {
    return this.format(this.area());
  }

  protected format(value: number): string {
    return value.toFixed(2);
  }
}
`,
  'src/shapes/circle.ts': `import { circleArea } from '../math/area.js';
import { BaseShape } from './shape.js';

export class Circle extends BaseShape {
  constructor(private readonly radius: number) {
    super();
  }

  area(): number {
    return circleArea(this.radius);
  }
}

export function makeCircle(radius: number): Circle {
  return new Circle(radius);
}
`,
  'src/shapes/square.ts': `import { BaseShape } from './shape.js';
import { square } from '../math/area.js';

export class Square extends BaseShape {
  constructor(private readonly side: number) {
    super();
  }

  area(): number {
    return square(this.side);
  }
}
`,
  // A second, unrelated function with the same name as src/math/area.ts:square.
  'src/ui/layout.ts': `export function square(el: { width: number; height: number }): void {
  el.height = el.width;
}

export function resetLayout(el: { width: number; height: number }): void {
  square(el);
}
`,
  'src/app.ts': `import { makeCircle } from './shapes/circle.js';
import { Square } from './shapes/square.js';
import { cylinderVolume } from './math/volume.js';

export const DEFAULT_RADIUS = 2;

export function main(): void {
  const shapes = [makeCircle(DEFAULT_RADIUS), new Square(3)];
  for (const s of shapes) console.log(s.describe());
  console.log(cylinderVolume(DEFAULT_RADIUS, 10)); // prints the cylinder volume
}
`,
  'src/app.test.ts': `import { main } from './app.js';
import { circleArea } from './math/area.js';

function testMain(): void {
  main();
  circleArea(1);
}
`,
  'tools/report.py': `"""Reporting helpers."""
from .util import format_row


class Report:
    """Builds a text report."""

    def __init__(self, rows):
        self.rows = rows

    def render(self):
        """Render all rows."""
        return "\\n".join(self.render_row(r) for r in self.rows)

    def render_row(self, row):
        return format_row(row)


def build_report(rows):
    return Report(rows).render()
`,
  'tools/util.py': `def format_row(row):
    """Format a single row."""
    return ", ".join(str(c) for c in row)
`,
  'ignored_dir/secret.ts': `export function shouldNotBeIndexed(): void {}\n`,
  'src/schema.gen.ts': `export function generatedThing(): void {}\n`,
  'node_modules/dep/index.js': `function dependencyCode() {}\n`,
};

export interface Project {
  root: string;
  clast: Clast;
  ctx: ToolContext;
  write(rel: string, content: string): void;
  remove(rel: string): void;
  dispose(): void;
}

/** Create the fixture project in a temp directory and index it. */
export async function createProject(files: Record<string, string> = FIXTURE): Promise<Project> {
  const root = mkdtempSync(join(tmpdir(), 'clast-test-'));
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);

  const clast = new Clast(root, parseConfig({ watch: { enabled: false } }));
  await clast.indexer.indexAll();
  const ctx = new ToolContext(clast);
  return {
    root,
    clast,
    ctx,
    write,
    remove: rel => rmSync(join(root, rel), { force: true }),
    dispose: () => {
      try { clast.close(); } catch { /* already closed */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
