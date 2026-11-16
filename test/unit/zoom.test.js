/**
 * Unit tests for map + zoom (src/zoom.js) and the `whole` option it needs from
 * prune.js and data.js. No browser needed — hand-built trees.
 *
 * Run: node --test test/unit/zoom.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWithin, zoomSnapshot } from '../../src/zoom.js';
import { prune } from '../../src/prune.js';
import { dataSnapshot } from '../../src/data.js';
import { formatTree } from '../../src/aria.js';

let id = 0;
const node = (role, name = '', children = [], props = {}) => ({ nodeId: String(++id), role, name, properties: props, ignored: false, children });
const text = (t) => node('StaticText', t);
const item = (t) => node('listitem', '', [node('link', t, [text(t)])]);
const bigList = (name, tag, n = 40) => node('list', name, Array.from({ length: n }, (_, i) => item(`${tag} ${i} with some words`)));
const smallList = (name) => node('list', name, [item('tiny')]);
const rows = (n) => Array.from({ length: n }, (_, i) => node('row', '', [node('cell', `city ${i}`, [text(`city ${i}`)]), node('cell', `pop ${i * 1000}`, [text(`pop ${i * 1000}`)])]));
const bigTable = (name) => node('table', name, [node('row', '', [node('columnheader', 'City', [text('City')]), node('columnheader', 'Pop', [text('Pop')])]), ...rows(40)]);

// banner (nav + logo) | main: table "Cities", h2 "Top picks" + unnamed list, h2 "Other picks" + unnamed list, tiny list | footer
function fixture() {
  const banner = node('banner', '', [node('link', 'Home', [text('Home')]), smallList('')]);
  const table = bigTable('Cities');
  const top = bigList('', 'top');
  const other = bigList('', 'other');
  const tiny = smallList('Little');
  const main = node('main', '', [
    node('heading', 'Cities', [text('Cities')], { level: 1 }), table,
    node('heading', 'Top picks', [text('Top picks')], { level: 2 }), top,
    node('heading', 'Other picks', [text('Other picks')], { level: 2 }), other, tiny,
  ]);
  const footer = node('contentinfo', '', [node('link', 'Terms', [text('Terms')])]);
  return { tree: node('RootWebArea', 'T', [banner, main, footer]), banner, main, table, top, other, tiny, footer };
}
const run = (tree, o = {}) => zoomSnapshot(tree, { head: 'url: x\n', mode: 'act', links: false, ...o });
const zoom = (tree, within, o = {}) => run(tree, { selectors: parseWithin(within), ...o });

describe('parseWithin', () => {
  it('parses ref, number, role, role "name", role after "heading", both', () => {
    assert.deepEqual(parseWithin(563).map(({ raw, ...s }) => s), [{ ref: '563' }]);
    assert.deepEqual(parseWithin('12').map(({ raw, ...s }) => s), [{ ref: '12' }]);
    assert.deepEqual(parseWithin('table').map(({ raw, ...s }) => s), [{ role: 'table' }]);
    assert.deepEqual(parseWithin('list "Issues"').map(({ raw, ...s }) => s), [{ role: 'list', name: 'Issues' }]);
    assert.deepEqual(parseWithin('list after "Other flights"').map(({ raw, ...s }) => s), [{ role: 'list', after: 'Other flights' }]);
    assert.deepEqual(parseWithin('list "A" after "B"').map(({ raw, ...s }) => s), [{ role: 'list', name: 'A', after: 'B' }]);
    assert.equal(parseWithin([430, 'table', 'list "x"']).length, 3);
  });
  it('rejects empty and unparsable input', () => {
    assert.throws(() => parseWithin([]), /empty/);
    assert.throws(() => parseWithin('the big table'), /cannot parse/);
  });
});

describe('map', () => {
  it('lists boxes big enough, nested, with ref and size; unnamed boxes carry their preceding heading', () => {
    const f = fixture();
    const lines = run(f.tree, { map: true }).split('\n');
    assert.equal(lines[0], 'url: x');
    assert.ok(lines[1].startsWith('map: '), lines[1]);
    const body = lines.slice(2);
    const L = (n) => body.find((l) => l.includes(`[ref=${n.nodeId}]`));
    assert.match(L(f.main), /^- main \[ref=\d+\] \(\d+(\.\d)?k chars\)$/);
    assert.match(L(f.table), /^ {2}- table "Cities" \[ref=\d+\] \(\d+(\.\d)?k chars\)$/, 'nested under main');
    assert.match(L(f.top), /^ {2}- list after "Top picks" \[ref=\d+\] \(/);
    assert.match(L(f.other), /^ {2}- list after "Other picks" \[ref=\d+\] \(/);
    assert.equal(L(f.banner), undefined, 'small boxes are not listed');
    assert.equal(L(f.tiny), undefined);
    assert.equal(L(f.footer), undefined);
  });
});

describe('within: selection', () => {
  it('role + name picks one box and drops the noise (act mode)', () => {
    const f = fixture();
    const out = zoom(f.tree, 'table "Cities"');
    assert.match(out, /^url: x\nzoom table "Cities" \[ref=\d+\]: /);
    assert.ok(out.includes('city 3'));
    assert.ok(!/Home|Terms|top 1|other 1|Little/.test(out), out.slice(0, 400));
  });
  it('role alone matches when unique', () => {
    const f = fixture();
    assert.ok(zoom(f.tree, 'table').includes('city 3'));
  });
  it('after "heading" finds the right unnamed list', () => {
    const f = fixture();
    const out = zoom(f.tree, 'list after "Other picks"');
    assert.ok(out.includes('other 3') && !out.includes('top 3'), out.slice(0, 300));
    const out2 = zoom(f.tree, 'list after "Top picks"');
    assert.ok(out2.includes('top 3') && !out2.includes('other 3'));
  });
  it('a ref resolves through refNodes to the node id in this tree', () => {
    const f = fixture();
    const out = zoom(f.tree, 'ref-old'.replace('ref-old', '77'), { refNodes: new Map([['77', f.other.nodeId]]) });
    assert.ok(out.includes('other 3'));
  });
  it('several boxes come out in page order whatever the order asked', () => {
    const f = fixture();
    const out = zoom(f.tree, ['list after "Other picks"', 'list after "Top picks"', 'table "Cities"']);
    const at = (s) => out.indexOf(s);
    assert.ok(at('city 3') > 0 && at('city 3') < at('top 3') && at('top 3') < at('other 3'), 'table, then top, then other');
    assert.match(out.split('\n')[1], /^zoom table "Cities" \[ref=\d+\], list after "Top picks" \[ref=\d+\], list after "Other picks"/);
  });
  it('a box inside another picked box is not repeated', () => {
    const f = fixture();
    const body = (o) => o.split('\n').slice(2).join('\n');
    assert.equal(body(zoom(f.tree, ['main', 'table "Cities"'])), body(zoom(f.tree, 'main')), 'same as main alone');
  });
  it('ambiguity returns the map with the matches marked, never picks one', () => {
    const f = fixture();
    const out = zoom(f.tree, 'list');
    assert.match(out, /within matched more than one box: list \(4\)/);
    assert.ok(!out.includes('zoom '), 'no zoom output');
    const marked = out.split('\n').filter((l) => l.endsWith('<- match'));
    assert.equal(marked.length, 4, 'all four lists marked, even the small ones:\n' + out);
  });
  it('nothing matches: an error naming what was asked', () => {
    const f = fixture();
    assert.throws(() => zoom(f.tree, 'table "Nope"'), /nothing matches table "Nope"/);
    assert.throws(() => zoom(f.tree, 'list after "Nope"'), /nothing matches list after "Nope"/);
    assert.throws(() => zoom(f.tree, '99', { refNodes: new Map() }), /nothing matches 99/);
    assert.throws(() => zoom(f.tree, ['table', 'form']), /nothing matches form/);
  });
});

describe('within: modes', () => {
  it('landmark step is off inside a zoom: a banner zoom in act mode is not empty', () => {
    const f = fixture();
    const out = zoom(f.tree, 'banner');
    assert.ok(out.includes('link "Home"'), out);
    // contrast: the whole page in act mode keeps main only
    assert.ok(!formatTree(prune(f.tree, { mode: 'act' })).includes('link "Home"'));
  });
  it('contentinfo zoom works in read mode', () => {
    const f = fixture();
    assert.ok(zoom(f.tree, 'contentinfo', { mode: 'read' }).includes('Terms'));
  });
  it('data mode: the box is the whole page, not scoped to a main inside it', () => {
    const f = fixture();
    const wrapped = node('RootWebArea', 'T', [node('form', 'Page', [f.banner, f.main])]);
    assert.ok(zoom(wrapped, 'form "Page"', { mode: 'data' }).includes('Home'), 'banner next to main kept');
    assert.ok(!dataSnapshot(wrapped).includes('Home'), 'whole page: main only');
  });
  it('data mode with several boxes keeps one legend', () => {
    const f = fixture();
    const out = zoom(f.tree, ['table "Cities"', 'list after "Top picks"'], { mode: 'data' });
    assert.equal(out.split('# data mode').length, 2, 'one legend');
    assert.ok(out.includes('city 3') && out.includes('top 3'));
  });
  it('links annotate inside a zoom', () => {
    const f = fixture();
    f.top.children[0].children[0].urls = ['https://x.test/a'];
    assert.ok(zoom(f.tree, 'list after "Top picks"', { links: true, mode: 'read' }).includes('<https://x.test/a>'));
  });
});

describe('whole option', () => {
  it('prune without it is unchanged: landmark step keeps main only', () => {
    const f = fixture();
    const a = formatTree(prune(f.tree, { mode: 'act' }));
    assert.equal(a, formatTree(prune(f.tree, { mode: 'act', whole: false })));
    assert.ok(!a.includes('Home') && !a.includes('Terms'));
  });
});

describe('card groups', () => {
  const long = (i) => `Apartment number ${i} in a quiet street near the old town, rated very highly by guests`;
  const card = (i) => node('group', '', [
    node('heading', `Card ${i}`, [text(`Card ${i}`)], { level: 3 }),
    text(long(i)),
    node('link', `View ${i}`, [text(`View ${i}`)]),
    node('button', 'Save', [text('Save')]),
  ]);
  const grid = (n = 12) => node('generic', '', Array.from({ length: n }, (_, i) => card(i)));
  const page = (...mainKids) => node('RootWebArea', 'T', [
    node('banner', '', [node('link', 'Home', [text('Home')])]),
    node('main', '', mainKids),
    node('contentinfo', '', [node('link', 'Terms', [text('Terms')])]),
  ]);

  it('lists a card grid nested under its box: count, size, the parent\'s ref', () => {
    const g = grid();
    const out = run(page(node('heading', 'Results', [text('Results')], { level: 1 }), g), { map: true });
    assert.match(out, /^- main \[ref=\d+\] \([\d.]+k chars\)\n {2}- group ×12 \(\d+\.\dk chars\) \[ref=(\d+)\]$/m);
    assert.equal(out.match(/group ×12 .*\[ref=(\d+)\]/)[1], g.nodeId);
  });

  it('within the group\'s ref zooms to the cards, labelled as a group', () => {
    const g = grid();
    const t = page(g);
    const out = run(t, { selectors: parseWithin(g.nodeId), refNodes: new Map([[g.nodeId, g.nodeId]]) });
    assert.match(out, /zoom group ×12 \[ref=\d+\]/);
    assert.ok(out.includes('Card 0') && out.includes('Card 11'));
  });

  it('within "group": one grid zooms, two grids give the map with both marked', () => {
    const one = page(grid());
    assert.match(zoom(one, 'group'), /zoom group ×12/);
    const two = page(grid(), grid(10));
    const out = zoom(two, 'group');
    assert.match(out, /within matched more than one box: group \(2\)/);
    assert.equal(out.match(/\] <- match$/gm).length, 2);
  });

  it('skips link columns inside contentinfo/navigation/banner', () => {
    const col = (n) => node('generic', '', Array.from({ length: 8 }, (_, i) => card(i + n)));
    const t = node('RootWebArea', 'T', [
      node('main', '', [bigList('Items', 'it')]),
      node('contentinfo', '', [grid()]),
      node('navigation', '', [col(0)]),
      node('banner', '', [col(0)]),
    ]);
    assert.ok(!run(t, { map: true }).includes('group ×'));
  });

  it('does not repeat a box that is already in the map (a list of cards)', () => {
    const list = node('list', 'Stays', Array.from({ length: 12 }, (_, i) => node('listitem', '', [
      node('heading', `Card ${i}`, [text(`Card ${i}`)]), text(long(i)), node('link', `View ${i}`, [text(`View ${i}`)]), node('button', 'Save', [text('Save')]),
    ])));
    const out = run(page(list), { map: true });
    assert.match(out, /- list "Stays"/);
    assert.ok(!out.includes('group ×'));
  });

  it('ignores small and non-uniform siblings', () => {
    const tiny = node('generic', '', Array.from({ length: 12 }, (_, i) => node('generic', '', [text(`n${i}`)])));
    const mixed = node('generic', '', [
      card(1), node('table', '', rows(2)), node('form', '', [node('textbox', 'Name'), node('button', 'Go', [text('Go')])]),
      node('list', '', [item('one with some words in it')]), node('complementary', '', [text(long(9)), text(long(8))]),
      node('figure', '', [text(long(7)), node('image', 'x'), node('link', 'l', [text('l')]), node('button', 'b', [text('b')])]),
    ]);
    assert.ok(!run(page(tiny, mixed), { map: true }).includes('group ×'));
  });

  it('a pile of small groups below the size threshold is not listed', () => {
    const small = node('generic', '', Array.from({ length: 4 }, (_, i) => node('group', '', [
      node('heading', `C${i}`, [text(`C${i}`)]), text('some text here long enough'), node('link', 'a', [text('a')]), node('button', 'b', [text('b')]),
    ])));
    assert.ok(!run(page(small), { map: true }).includes('group ×'));
  });
});
