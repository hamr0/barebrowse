/**
 * Unit tests for data mode (src/data.js).
 * No browser needed — pure function tests on hand-built trees, plus trimmed
 * real-page fixtures (test/fixtures/data-*.json) and an act/read-unchanged guard.
 *
 * Run: node --test test/unit/data.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dataSnapshot, LEGEND } from '../../src/data.js';
import { prune } from '../../src/prune.js';
import { formatTree } from '../../src/aria.js';

let id = 0;
const node = (role, name = '', children = [], props = {}) => ({ nodeId: String(++id), role, name, properties: props, ignored: false, children });
const text = (t) => node('StaticText', t);
const link = (name) => node('link', name, [text(name)]);
const cell = (v) => node('cell', v, v ? [text(v)] : []);
const row = (...cells) => node('row', '', cells);
const hdr = (v) => node('columnheader', v, [text(v)]);
const rowhdr = (v) => node('rowheader', v, [text(v)]);
const page = (...kids) => node('RootWebArea', 'T', [node('main', '', kids)]);
const allLines = (tree) => dataSnapshot(tree).split('\n');
const lines = (tree) => allLines(tree).slice(1);          // without the legend
const recs = (tree) => lines(tree).map((l) => l.trim()).filter((l) => /^- (row|columns)/.test(l));
const fixture = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));
const golden = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');

describe('data: tables (T1-T4)', () => {
  it('maps cells to headers positionally, label from the row header, ref on interactive only', () => {
    const l = node('link', 'Boston', [text('Boston')]);
    const t = node('table', 'Stops', [
      row(hdr('Stop'), hdr('Arrives'), hdr('Platform')),
      row(node('rowheader', 'Boston', [l]), cell('6:02 AM'), cell('2')),
      row(rowhdr('Quincy'), cell('6:20 AM'), cell('1')),
    ]);
    const out = lines(page(t));
    assert.ok(out.some((x) => x.trim() === `- row "Boston" [ref=${l.nodeId}]: Arrives: 6:02 AM · Platform: 2`), out.join('\n'));
    assert.ok(out.some((x) => x.trim() === '- row "Quincy": Arrives: 6:20 AM · Platform: 1'));
    assert.ok(!out.join('\n').includes('Stop:'), 'row-header column is the label, not a value');
  });

  it('table without headers: bare values, no column names', () => {
    const t = node('table', '', [row(cell('a'), cell('b')), row(cell('c'), cell('d'))]);
    assert.deepEqual(recs(page(t)), ['- row: a · b', '- row: c · d']);
  });

  it('width mismatch guard: no positional mapping, columns printed once', () => {
    const t = node('table', '', [
      row(hdr('A'), hdr('B'), hdr('C')),
      row(cell('1'), cell('2')),                       // a colspan the AX tree can't express
      row(cell('3'), cell('4'), cell('5')),
    ]);
    const out = lines(page(t));
    assert.ok(out.some((l) => l.includes('columns: A · B · C') && l.includes('width mismatch')));
    assert.ok(out.some((l) => l.trim() === '- row: 1 · 2'));
    assert.ok(!out.join('\n').includes('A: 1'));
  });

  it('skips header-only and empty rows', () => {
    const t = node('table', '', [
      row(hdr('A'), hdr('B')),
      row(cell(''), cell('')),
      row(cell('x'), cell('y')),
    ]);
    assert.deepEqual(recs(page(t)), ['- row: A: x · B: y']);
  });

  it('modal-value compression states a repeated filler once', () => {
    const t = node('table', '', [
      row(hdr('Stop'), ...'abcdefgh'.split('').map(hdr)),
      row(rowhdr('Wick'), cell('n/a'), cell('n/a'), cell('n/a'), cell('n/a'), cell('n/a'), cell('6:02'), cell('n/a'), cell('7:02')),
    ]);
    const out = lines(page(t));
    assert.ok(out.some((x) => x.trim() === '- row "Wick" (other 6 columns: n/a): f: 6:02 · h: 7:02'), out.join('\n'));
  });
});

describe('data: repeated siblings (R1-R3)', () => {
  const heading = (t) => node('heading', t, [text(t)], { level: 2 });

  it('a run of 3 collapses into one line labelled by the preceding heading', () => {
    const a = link('a'), b = link('b'), c = link('c');
    const out = lines(page(heading('Items'), a, b, c));
    assert.deepEqual(out.slice(1), [`  - Items: a [ref=${a.nodeId}], b [ref=${b.nodeId}], c [ref=${c.nodeId}]`]);
  });

  it('a run of 2 does not collapse', () => {
    const out = lines(page(heading('Items'), link('a'), link('b')));
    assert.equal(out.filter((l) => l.includes('link')).length, 2);
    assert.ok(!out.join('\n').includes('Items:'));
  });

  it('a weak pair collapses when a 3-run of the same shape exists beside it', () => {
    const out = lines(page(heading('One'), link('a'), link('b'), link('c'), heading('Two'), link('d'), link('e')));
    assert.ok(out.some((l) => l.startsWith('  - One: a ')), out.join('\n'));
    assert.ok(out.some((l) => l.startsWith('  - Two: d ')), out.join('\n'));
    // ... but a lone pair with no 3-run next to it stays expanded
    const lone = lines(page(heading('Two'), link('d'), link('e')));
    assert.equal(lone.filter((l) => l.includes('link')).length, 2);
  });

  it('label: lead-in text leaves up to a heading anchor join the label', () => {
    const out = lines(page(heading('Cast'), text('Starring'), link('a'), link('b'), link('c')));
    assert.ok(out[1].startsWith('  - Cast · Starring: a '), out.join('\n'));
    assert.equal(out.length, 2, 'lead-in leaves are consumed, not repeated');
  });

  it('label: nearest preceding heading when the lead-in is broken by a non-leaf', () => {
    const out = lines(page(heading('Results'), node('paragraph', '', [text('x'), link('zzz')]), link('a'), link('b'), link('c')));
    assert.ok(out.some((l) => l.startsWith('  - Results: a ')), out.join('\n'));
  });

  it('label: a named non-content container supplies the label and stops the climb', () => {
    const nav = node('navigation', 'Main menu', [link('a'), link('b'), link('c')]);
    const out = lines(page(heading('Elsewhere'), nav));
    assert.ok(out.some((l) => l.startsWith('    - Main menu: a ')), out.join('\n'));
    assert.ok(!out.join('\n').includes('Elsewhere:'));
  });

  it('label: a name-from-content container does not collapse its children', () => {
    const b = ['A', 'B', 'C'].map((n) => node('button', n, [text(n)]));
    const item = node('listitem', 'Product X', b);
    const out = lines(page(item));
    assert.equal(out.filter((l) => l.includes('button')).length, 3, out.join('\n'));
    assert.ok(!out.join('\n').includes('Product X:'));
  });
});

describe('data: noise rules (N1-N6) and refs', () => {
  it('drops whitespace/punctuation StaticText and renders text without the role word', () => {
    const out = lines(page(node('generic', '', [text('Hello'), text(' '), text('|'), text('world')])));
    assert.deepEqual(out.slice(1), ['  - Hello world']);
    assert.ok(!out.join('\n').includes('StaticText'));
  });

  it('drops a child whose text is already in its parent name', () => {
    const l = node('link', 'Home', [text('Home')]);
    const out = lines(page(l));
    assert.deepEqual(out.slice(1), [`  - link "Home" [ref=${l.nodeId}]`]);
  });

  it('drops rendering noise and images', () => {
    const out = lines(page(node('image', 'logo'), node('InlineTextBox', 'x'), node('heading', 'Hi', [], { level: 1 })));
    assert.deepEqual(out.slice(1), ['  - heading "Hi" [level=1]']);
  });

  it('refs appear on interactive nodes only, including nested ones', () => {
    const b = node('button', 'Go', [text('Go')]);
    const out = lines(page(node('group', 'Tools', [node('heading', 'Hd', [], { level: 3 }), b])));
    const joined = out.join('\n');
    assert.ok(joined.includes(`button "Go" [ref=${b.nodeId}]`));
    assert.ok(!/heading "Hd".*\[ref=/.test(joined));
    assert.ok(!/group "Tools".*\[ref=/.test(joined));
  });

  it('scope: main landmark when present, whole page otherwise', () => {
    const withMain = node('RootWebArea', 'T', [node('banner', '', [link('ads')]), node('main', '', [node('heading', 'In', [], { level: 1 })])]);
    assert.ok(!dataSnapshot(withMain).includes('ads'));
    const noMain = node('RootWebArea', 'T', [node('heading', 'Only', [], { level: 1 })]);
    assert.ok(dataSnapshot(noMain).includes('heading "Only"'));
  });

  it('legend is the first line, exactly once', () => {
    for (const t of [page(node('table', '', [row(hdr('A')), row(cell('x'))])), page(), fixture('data-mbta.json'), fixture('data-movie.json')]) {
      const ls = allLines(t);
      assert.equal(ls[0], LEGEND);
      assert.equal(ls.filter((l) => l.startsWith('# data mode:')).length, 1);
    }
    assert.ok(!LEGEND.includes('\n'));
  });

  it('N5/N6: icon-font buttons and links (private-use glyph name) are dropped, real ones kept', () => {
    const icon = '\uece0';
    const out = dataSnapshot(page(
      node('button', icon, [text(icon)]),
      node('link', icon),
      node('button', `${icon} Save`, [text(`${icon} Save`)]),
      node('button', '+', [text('+')]),
    ));
    assert.ok(out.includes(`button "${icon} Save"`), out);        // mixed with real text: untouched
    assert.ok(out.includes('button "+"'), out);
    assert.equal((out.match(/button/g) || []).length, 2, out);
    assert.equal((out.match(/link/g) || []).length, 0, out);
  });

  it('returns empty string for no tree', () => {
    assert.equal(dataSnapshot(null), '');
  });
});

describe('data: real-page fixtures (trimmed)', () => {
  it('MBTA timetable: stop row keeps its trip times, with a ref on the row label', () => {
    const out = dataSnapshot(fixture('data-mbta.json'));
    const r = out.split('\n').find((l) => l.includes('row "Wickford Junction"'));
    assert.ok(r && /\[ref=\d+\]/.test(r) && r.includes('Trip 6008: 6:02 AM'), r);
  });

  it('Moviefone: a film line carries its showtimes', () => {
    const out = dataSnapshot(fixture('data-movie.json'));
    const r = out.split('\n').find((l) => l.includes('Clayface') && l.includes('3:30 PM'));
    assert.ok(r && r.includes('6:15 PM') && r.includes('9:00 PM'), out.slice(0, 800));
  });

  it('Flights: no StaticText role word anywhere', () => {
    const out = dataSnapshot(fixture('data-flights.json'));
    assert.ok(out.length > 500);
    assert.equal((out.match(/StaticText/g) || []).length, 0);
  });
});

describe('act and read output unchanged by data mode (golden from pre-change main)', () => {
  for (const k of ['mbta', 'movie', 'flights']) {
    for (const m of ['act', 'read']) {
      it(`${k} ${m}`, () => {
        assert.equal(formatTree(prune(fixture(`data-${k}.json`), { mode: m })), golden(`data-${k}.${m}.golden.txt`));
      });
    }
  }
});
