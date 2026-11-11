import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `<?php
declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Support\\Collection;
use Foo\\Bar as Baz, Foo\\Qux;
use A\\B\\{C, D as E, sub\\F};
use function App\\helper;
use const App\\LIMIT;
require_once 'vendor/autoload.php';
include __DIR__ . '/x.php';
require($dynamic);

const TOP = 1;
define('DEFD', 2);

/**
 * A user.
 *
 * @property string $name
 */
#[Attr]
abstract class User extends Base\\Model implements \\JsonSerializable, Countable
{
    use HasFactory, Notifiable;
    use SoftDeletes { restore as protected traitRestore; }

    public const A = 1, B = 2;
    private const C = 3;

    /** The name. */
    protected static ?string $name = 'x', $other;
    public int $count = 0;
    var $legacy;

    public function __construct(private readonly Foo $foo, protected int $n = 1, public $pub = 2, $plain = null)
    {
        parent::__construct();
        $this->foo->bar();
        $x = new Collection([1]);
        $y = new \\Foo\\Thing;
        self::make();
        static::boot();
        Foo\\Util::run($x);
        helper(1);
        \\App\\other();
        $this?->maybe();
        $fn = function ($a) use ($x) { return strlen($a); };
        $g = fn($a) => trim($a);
        $s = <<<EOT
        hello {$this->label()} world
        EOT;
        $dyn = 'x';
        $dyn();
        $this->$dyn();
    }

    /**
     * Compute the area.
     */
    abstract protected function area(): float;

    public static function make(int ...$args): static
    {
        return new static();
    }

    function implicit() {}
    private function hidden() {}
    final public function &ref(array &$a): ?array { return $a; }
}

interface Shape extends A, B
{
    const X = 1;
    public function area(): float;
}

trait Hello
{
    public $p;
    public function hi() { echo 'hi'; }
}

enum Suit: string implements HasLabel
{
    use T;
    case Hearts = 'H';
    case Spades = 'S';
    const Wild = self::Spades;
    public function label(): string { return ucfirst($this->value); }
}

final class Leaf {}

// Top function.
function top(int $a, string ...$rest): void
{
    $o = new class($a) extends Leaf implements Shape {
        public function area(): float { return compute(); }
    };
}
`;

describe('php extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.php', SRC);
    assert.deepEqual(symbolList(ex), [
      'constant TOP',
      'constant DEFD',
      'class User',
      'property User.foo',
      'property User.n',
      'property User.pub',
      'constant User.A',
      'constant User.B',
      'constant User.C',
      'property User.name',
      'property User.other',
      'property User.count',
      'property User.legacy',
      'method User.__construct',
      'method User.area',
      'method User.make',
      'method User.implicit',
      'method User.hidden',
      'method User.ref',
      'interface Shape',
      'constant Shape.X',
      'method Shape.area',
      'trait Hello',
      'property Hello.p',
      'method Hello.hi',
      'enum Suit',
      'constant Suit.Hearts',
      'constant Suit.Spades',
      'constant Suit.Wild',
      'method Suit.label',
      'class Leaf',
      'function top',
      'class top.class@anonymous',
      'method top.class@anonymous.area',
    ]);
    assert.equal(ex.hadError, false);
  });

  it('captures signatures', async () => {
    const ex = await extractSource('a.php', SRC);
    assert.equal(
      sym(ex, 'User').signature,
      'abstract class User extends Base\\Model implements \\JsonSerializable, Countable'
    );
    assert.equal(
      sym(ex, 'User.__construct').signature,
      'public function __construct(private readonly Foo $foo, protected int $n = 1, public $pub = 2, $plain = null)'
    );
    assert.equal(sym(ex, 'User.area').signature, 'abstract protected function area(): float');
    assert.equal(sym(ex, 'User.make').signature, 'public static function make(int ...$args): static');
    assert.equal(sym(ex, 'User.ref').signature, 'final public function &ref(array &$a): ?array');
    assert.equal(sym(ex, 'User.name').signature, 'protected static ?string $name');
    assert.equal(sym(ex, 'User.other').signature, 'protected static ?string $other');
    assert.equal(sym(ex, 'User.legacy').signature, 'var $legacy');
    assert.equal(sym(ex, 'User.foo').signature, 'private readonly Foo $foo');
    assert.equal(sym(ex, 'User.A').signature, 'public const A = 1');
    assert.equal(sym(ex, 'User.B').signature, 'public const B = 2');
    assert.equal(sym(ex, 'TOP').signature, 'const TOP = 1');
    assert.equal(sym(ex, 'DEFD').signature, "define('DEFD', 2)");
    assert.equal(sym(ex, 'Shape').signature, 'interface Shape extends A, B');
    assert.equal(sym(ex, 'Shape.area').signature, 'public function area(): float');
    assert.equal(sym(ex, 'Suit').signature, 'enum Suit: string implements HasLabel');
    assert.equal(sym(ex, 'Suit.Hearts').signature, "case Hearts = 'H'");
    assert.equal(sym(ex, 'Leaf').signature, 'final class Leaf');
    assert.equal(sym(ex, 'top').signature, 'function top(int $a, string ...$rest): void');
    assert.equal(sym(ex, 'top.class@anonymous').signature, 'class($a) extends Leaf implements Shape');
  });

  it('captures docs, ranges and exported flags', async () => {
    const ex = await extractSource('a.php', SRC);
    const user = sym(ex, 'User');
    assert.equal(user.doc, 'A user.\n\n@property string $name');
    assert.equal(user.docLine, 18);
    assert.equal(user.startLine, 23);
    assert.equal(sym(ex, 'User.name').doc, 'The name.');
    assert.equal(sym(ex, 'User.area').doc, 'Compute the area.');
    assert.equal(sym(ex, 'top').doc, 'Top function.');
    assert.equal(sym(ex, 'User.make').doc, '');
    const make = sym(ex, 'User.make');
    assert.equal(make.endLine - make.startLine, 3);

    assert.equal(user.exported, true);
    assert.equal(sym(ex, 'top').exported, true);
    assert.equal(sym(ex, 'User.__construct').exported, true);
    assert.equal(sym(ex, 'User.implicit').exported, true);
    assert.equal(sym(ex, 'User.make').exported, true);
    assert.equal(sym(ex, 'User.ref').exported, true);
    assert.equal(sym(ex, 'User.area').exported, false);
    assert.equal(sym(ex, 'User.hidden').exported, false);
    assert.equal(sym(ex, 'User.A').exported, true);
    assert.equal(sym(ex, 'User.C').exported, false);
    assert.equal(sym(ex, 'User.name').exported, false);
    assert.equal(sym(ex, 'User.count').exported, true);
    assert.equal(sym(ex, 'User.legacy').exported, true);
    assert.equal(sym(ex, 'User.foo').exported, false);
    assert.equal(sym(ex, 'User.n').exported, false);
    assert.equal(sym(ex, 'User.pub').exported, true);
    assert.equal(sym(ex, 'Shape.area').exported, true);
    assert.equal(sym(ex, 'Suit.Hearts').exported, true);
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('a.php', SRC);
    const calls = callList(ex);
    for (const want of [
      'User.__construct -> parent.__construct',
      'User.__construct -> $this->foo.bar',
      'User.__construct -> Collection',
      'User.__construct -> Thing',
      'User.__construct -> self.make',
      'User.__construct -> static.boot',
      'User.__construct -> Util.run',
      'User.__construct -> helper',
      'User.__construct -> other',
      'User.__construct -> $this.maybe',
      'User.__construct -> strlen',
      'User.__construct -> trim',
      'User.__construct -> $this.label',
      'Suit.label -> ucfirst',
      'top.class@anonymous.area -> compute',
    ]) {
      assert.ok(calls.includes(want), `missing '${want}' in ${JSON.stringify(calls)}`);
    }
    // `new static`, dynamic calls and define() are not recorded.
    for (const name of ['static', 'dyn', 'define', 'Leaf']) {
      assert.ok(!ex.calls.some(c => c.name === name), `unexpected call to ${name}`);
    }
  });

  it('extracts imports', async () => {
    const ex = await extractSource('a.php', SRC);
    assert.deepEqual(importList(ex), [
      'Illuminate\\Support\\Collection',
      'Foo\\Bar',
      'Foo\\Qux',
      'A\\B\\C',
      'A\\B\\D',
      'A\\B\\sub\\F',
      'App\\helper',
      'App\\LIMIT',
      'vendor/autoload.php',
      './x.php',
    ]);
    assert.deepEqual(ex.imports.map(i => i.names[0] ?? ''), [
      'Collection', 'Baz', 'Qux', 'C', 'E', 'F', 'helper', 'LIMIT', '', '',
    ]);
    assert.equal(ex.imports[0]!.line, 6);
  });

  it('extracts extends, implements and trait use', async () => {
    const ex = await extractSource('a.php', SRC);
    assert.deepEqual(heritageList(ex), [
      'User extends Model',
      'User implements JsonSerializable',
      'User implements Countable',
      'User implements HasFactory',
      'User implements Notifiable',
      'User implements SoftDeletes',
      'Shape extends A',
      'Shape extends B',
      'Suit implements HasLabel',
      'Suit implements T',
      'top.class@anonymous extends Leaf',
      'top.class@anonymous implements Shape',
    ]);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.php', SRC);
    assert.deepEqual(occLines(ex, 'Collection'), [6, 41]);
    assert.deepEqual(occLines(ex, 'helper'), [9, 46]);
    assert.deepEqual(occLines(ex, 'Leaf'), [95, 100]);
    // Variables are indexed without the `$`.
    assert.deepEqual(occLines(ex, 'foo'), [37, 40]);
    assert.deepEqual(occLines(ex, '$foo'), []);
  });

  it('handles both namespace forms without a qualified-name prefix', async () => {
    const ex = await extractSource('ns.php', `<?php
namespace First {
    const N = 1;
    class Inner { function m() { return nf(); } }
    function nf() {}
}
namespace Second\\Deep {
    interface I {}
}
`);
    assert.deepEqual(symbolList(ex), [
      'constant N',
      'class Inner',
      'method Inner.m',
      'function nf',
      'interface I',
    ]);
    assert.deepEqual(callList(ex), ['Inner.m -> nf']);
    assert.equal(sym(ex, 'Inner').exported, true);
  });

  it('handles PHP mixed with HTML', async () => {
    const ex = await extractSource('page.php', `<html><?php echo title(); ?>
<body>
<?php if ($x): ?>
  <p><?= e($name) ?></p>
<?php endif; ?>
<?php
/** Render. */
function render(Page $p) { return $p->body(); }
class View { public function show() { render(new Page); } }
?>
<footer>class Fake { function nope() {} }</footer>
</html>
`);
    assert.deepEqual(symbolList(ex), ['function render', 'class View', 'method View.show']);
    assert.equal(sym(ex, 'render').doc, 'Render.');
    assert.deepEqual(callList(ex), [
      '<file> -> title',
      '<file> -> e',
      'render -> $p.body',
      'View.show -> render',
      'View.show -> Page',
    ]);
    assert.deepEqual(occLines(ex, 'Fake'), []);
  });

  it('handles closures, migrations and helper-style guarded functions', async () => {
    const ex = await extractSource('m.php', `<?php

use Illuminate\\Database\\Migrations\\Migration;

if (! function_exists('tap_it')) {
    /**
     * Tap.
     */
    function tap_it($value, ?callable $cb = null) { return $cb ? $cb($value) : $value; }
}

$handler = function () { return run(); };
$arrow = fn () => go();

return new class extends Migration
{
    protected $connection = 'x';

    public function up(): void
    {
        Schema::create('t', function (Blueprint $table) {
            $table->id();
        });
    }
};
`);
    assert.deepEqual(symbolList(ex), [
      'function tap_it',
      'class class@anonymous',
      'property class@anonymous.connection',
      'method class@anonymous.up',
    ]);
    assert.equal(sym(ex, 'tap_it').doc, 'Tap.');
    assert.equal(sym(ex, 'class@anonymous').signature, 'class extends Migration');
    assert.deepEqual(heritageList(ex), ['class@anonymous extends Migration']);
    const calls = callList(ex);
    assert.ok(calls.includes('<file> -> function_exists'));
    assert.ok(calls.includes('<file> -> run'));
    assert.ok(calls.includes('<file> -> go'));
    assert.ok(calls.includes('class@anonymous.up -> Schema.create'));
    assert.ok(calls.includes('class@anonymous.up -> $table.id'));
  });

  it('tolerates broken and empty input', async () => {
    const broken = await extractSource('broken.php', '<?php\nclass Foo extends {\n  public function (\n  use ;\n const = ;\n new ;\n');
    assert.ok(Array.isArray(broken.symbols));
    const empty = await extractSource('empty.php', '');
    assert.deepEqual(empty.symbols, []);
    const htmlOnly = await extractSource('html.php', '<html><body>class X {}</body></html>\n');
    assert.deepEqual(htmlOnly.symbols, []);
  });
});
