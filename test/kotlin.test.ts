import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { callGraph, getContext, hierarchy, search } from '../src/tools/search.js';
import { impact } from '../src/tools/impact.js';

let p: Project;

before(async () => {
  p = await createProject({
    'app/src/main/kotlin/shapes/Shapes.kt': `package shapes

import shapes.store.Repo

interface Shape {
    fun area(): Double
}

abstract class Base(val n: Int) {
    open fun run() {}
}

class Circle(private val r: Double, repo: Repo) : Base(1), Shape {
    private val repo: Repo = repo

    constructor(r: Int) : this(r.toDouble(), Repo())

    override fun area(): Double = Math.PI * r * r

    override fun run() {
        super.run()
        helper(r)
        repo.save(this)
    }

    companion object {
        const val MAX = 3

        fun unit(): Circle = Circle(1.0, Repo())
    }
}

fun helper(x: Double): Double {
    return x
}

fun String.shout(): String = this.uppercase()

object Registry {
    val items = mutableListOf<Shape>()

    fun add(s: Shape) {
        items.add(s)
    }
}

enum class Color { RED, GREEN }
`,
    'app/src/main/kotlin/shapes/store/Repo.kt': `package shapes.store

class Repo {
    fun save(item: Any) {}
}

class OtherStore {
    fun save(item: Any) {}
}
`,
    'app/src/main/kotlin/engine/Native.kt': `package engine

object Native {
    external fun nativeStart(mode: Int): String
}

class Core {
    fun start(): String = Native.nativeStart(1)
}
`,
    'native/jni.cpp': `
#define FN(ret, name) extern "C" ret Java_engine_Native_##name
static int boot(int mode) { return mode; }
FN(jstring, nativeStart)(JNIEnv* e, jobject, jint mode) {
    boot(mode);
    return nullptr;
}
`,
  });
});
after(() => p.dispose());

describe('Kotlin', () => {
  it('indexes classes, interfaces, objects, enums, members and extension functions', async () => {
    const found = await search(p.ctx, { query: ['Circle', 'shout', 'Registry', 'MAX', 'RED'] });
    assert.match(found, /class Circle {2}app\/src\/main\/kotlin\/shapes\/Shapes\.kt:13-32/);
    assert.match(found, /method String\.shout/);
    assert.match(found, /class Registry/);
    assert.match(found, /constant Circle\.MAX/);
    assert.match(found, /constant Color\.RED/);
  });

  it('knows superclasses and interfaces', async () => {
    const h = await hierarchy(p.ctx, { name: 'Circle' });
    assert.match(h, /extends Base/);
    assert.match(h, /implements Shape/);
    const impl = await hierarchy(p.ctx, { name: 'Shape.area' });
    assert.match(impl, /method Circle\.area/);
  });

  it('resolves calls by the declared type of the receiver, super and plain functions', async () => {
    const save = await callGraph(p.ctx, { name: 'Repo.save', direction: 'callers' });
    assert.match(save, /Circle\.run {2}app\/src\/main\/kotlin\/shapes\/Shapes\.kt:23/);
    const other = await callGraph(p.ctx, { name: 'OtherStore.save', direction: 'callers' });
    assert.doesNotMatch(other, /Circle\.run/);
    const run = await getContext(p.ctx, { name: 'Circle.run' });
    assert.match(run, /Base\.run/);
    assert.match(run, /helper/);
  });

  it('counts a constructor call as a use of the class', async () => {
    const out = await callGraph(p.ctx, { name: 'Repo', direction: 'callers' });
    assert.match(out, /Circle\.unit/);
  });

  it('links an external fun to the C++ function behind it (JNI)', async () => {
    const callers = await callGraph(p.ctx, { name: 'native/jni.cpp:nativeStart', direction: 'callers' });
    assert.match(callers, /Core\.start {2}app\/src\/main\/kotlin\/engine\/Native\.kt:8/);
    const imp = await impact(p.ctx, { name: 'native/jni.cpp:nativeStart' });
    assert.match(imp, /change together .*\(1\):\n {2}method Native\.nativeStart/);
  });
});
