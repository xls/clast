import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { callersOf } from '../src/query/callgraph.js';
import { directSupertypes } from '../src/query/hierarchy.js';
import { findSymbols } from '../src/query/resolve.js';

// Found by the precision audit on rails: generator classes inherit from a class called `Base`
// (`Rails::Generators::Base < Thor::Group`), and a bare `say` in them was bound, as certain, to
// `ActiveRecord::Migration#say` because class families were compared by short name.
let p: Project;

before(async () => {
  p = await createProject({
    'lib/active_record/base.rb': `
module ActiveRecord
  class Base
    def persist; end
  end
end
`,
    'lib/active_record/migration.rb': `
module ActiveRecord
  class Migration < Base
    def say(message); end
    def say_with_time(message)
      say(message)
    end
  end
end
`,
    'lib/journey/group.rb': `
module Journey
  class Group
    def say(x); end
  end
end
`,
    'lib/generators/base.rb': `
module Generators
  class Base < Thor::Group
    include Thor::Actions
    include Generators::Actions
    def help_text
      say("usage")
    end
  end
end
`,
    'lib/generators/actions.rb': `
module Generators
  module Actions
    def gem_line(name); end
  end
end
`,
    'lib/generators/channel.rb': `
module Generators
  class ChannelGenerator < Base
    def install
      say("installing")
      gem_line("redis")
      persist
    end
  end
end
`,
  });
});
after(() => p.dispose());

const one = (ref: string) => {
  const hits = findSymbols(p.clast.db, ref, { exact: true });
  assert.equal(hits.length, 1, `${ref}: ${hits.map(h => h.qname).join(', ')}`);
  return hits[0]!;
};
const certainCallers = (ref: string): string[] =>
  callersOf(p.clast.db, p.ctx.resolver, one(ref))
    .filter(e => e.certain)
    .map(e => e.caller?.qname ?? '')
    .sort();

describe('Ruby classes are identified by qualified name', () => {
  it('a bare call in an unrelated class called Base is not a certain caller', () => {
    assert.deepEqual(certainCallers('ActiveRecord.Migration.say'), ['ActiveRecord.Migration.say_with_time']);
  });

  it('a qualified gem superclass is not a project class with the same short name', () => {
    const supers = directSupertypes(p.clast.db, p.ctx.resolver, one('Generators.Base'));
    const group = supers.find(s => s.name === 'Group');
    assert.ok(group, 'Thor::Group is listed');
    assert.equal(group!.sym, null, 'and is external, not Journey::Group');
    assert.deepEqual(certainCallers('Journey.Group.say'), []);
  });

  it('two mixins with the same short name are both supertypes', () => {
    const supers = directSupertypes(p.clast.db, p.ctx.resolver, one('Generators.Base'));
    const actions = supers.filter(s => s.name === 'Actions');
    assert.equal(actions.length, 2);
    assert.deepEqual(actions.map(a => a.sym?.qname ?? null).sort(), ['Generators.Actions', null].sort());
  });

  it('a bare call still reaches a mixin of the real ancestor', () => {
    assert.deepEqual(certainCallers('Generators.Actions.gem_line'), ['Generators.ChannelGenerator.install']);
  });

  it('a bare call does not reach a method of a different class called Base', () => {
    assert.deepEqual(certainCallers('ActiveRecord.Base.persist'), []);
  });
});
