/**
 * Run with:  npm test
 *
 * Follows the convention set by src/analytics/hotjar.test.ts -- node:test plus
 * node:assert/strict, no framework, no mocking library, colocated beside the
 * source file.
 *
 * dept-map.ts has zero imports, so these run without resolving anything from
 * node_modules. That is deliberate: the module was extracted partly so its
 * rule could be tested directly instead of only through utils.ts, which pulls
 * in clsx.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deptMapFindKey, deptMapGet, deptMapSet, deptMapDelete } from './dept-map.ts';

describe('deptMapGet', () => {
  test('finds an entry stored under the exact same casing', () => {
    const map = { 'Pre-Sales': { id: 'qst_1', name: 'Waiting for Dev' } };
    assert.deepEqual(deptMapGet(map, 'Pre-Sales'), { id: 'qst_1', name: 'Waiting for Dev' });
  });

  test('finds an entry stored under different casing -- the CF-29995 regression', () => {
    // current_department was "Pre-sales"; the snapshot key was "Pre-Sales".
    // A plain map[dept] read returned undefined here, which is what made the
    // ticket display a leftover QA status while it sat in Pre-Sales.
    const map = { 'Pre-Sales': { id: 'qst_1', name: 'In Progress' } };
    assert.equal(map['Pre-sales' as keyof typeof map], undefined, 'precondition: plain lookup misses');
    assert.deepEqual(deptMapGet(map, 'Pre-sales'), { id: 'qst_1', name: 'In Progress' });
  });

  test('ignores surrounding whitespace on the requested department', () => {
    const map = { Dev: { id: 'qst_2' } };
    assert.deepEqual(deptMapGet(map, '  dev  '), { id: 'qst_2' });
  });

  test('does NOT trim the stored key -- preserves the replaced implementation exactly', () => {
    // Asymmetric on purpose: the looked-up name is trimmed, the stored key is
    // not, matching `k.toLowerCase() === dept.trim().toLowerCase()` from the
    // private version this replaced. An earlier draft trimmed both, which
    // read better but changed stored data at the 39 handler call sites --
    // a write for "DEV" would have overwritten an existing " Dev " entry
    // instead of adding its own. Caught by the QA equivalence harness.
    //
    // A whitespace-padded stored key is therefore still missed. That is a real
    // latent bug, deliberately left for its own change rather than smuggled
    // into a casing fix.
    const map = { ' Dev ': { id: 'qst_3' } };
    assert.equal(deptMapGet(map, 'dev'), undefined);
    assert.equal(deptMapGet(map, ' Dev '), undefined);
  });

  test('returns undefined when the department was never recorded', () => {
    assert.equal(deptMapGet({ Dev: { id: 'qst_2' } }, 'Migration'), undefined);
  });

  test('returns undefined for a null, undefined or blank department', () => {
    const map = { Dev: { id: 'qst_2' } };
    assert.equal(deptMapGet(map, null), undefined);
    assert.equal(deptMapGet(map, undefined), undefined);
    assert.equal(deptMapGet(map, '   '), undefined);
  });

  test('a blank department never collides with a literal empty-string key', () => {
    // getEffectiveIssueStatus passes a nullable current_department straight
    // in, so a null must not resolve to whatever sits under ''.
    const map = { '': { id: 'qst_bogus' }, Dev: { id: 'qst_2' } };
    assert.equal(deptMapGet(map, null), undefined);
    assert.equal(deptMapGet(map, ''), undefined);
  });

  test('returns undefined for a null or undefined map instead of throwing', () => {
    assert.equal(deptMapGet(null, 'Dev'), undefined);
    assert.equal(deptMapGet(undefined, 'Dev'), undefined);
  });

  test('returns a stored falsy value rather than treating it as a miss', () => {
    // deptMapSet(deptAssignees, currentDept, null) is a real call in
    // jira-pg-api.ts -- null means "explicitly unassigned here", which must
    // stay distinguishable from "this department has no entry".
    const map = { Dev: null };
    assert.equal(deptMapGet(map, 'Dev'), null);
    assert.equal(deptMapFindKey(map, 'Dev'), 'Dev');
  });
});

describe('deptMapFindKey', () => {
  test('returns the key as actually stored, not the requested casing', () => {
    assert.equal(deptMapFindKey({ 'Pre-Sales': 1 }, 'PRE-SALES'), 'Pre-Sales');
  });

  test('returns undefined when absent', () => {
    assert.equal(deptMapFindKey({ Dev: 1 }, 'QA'), undefined);
  });
});

describe('deptMapSet', () => {
  test('reuses the casing already present so one ticket keeps one entry', () => {
    const map: Record<string, any> = { Dev: { id: 'old' } };
    deptMapSet(map, 'dev', { id: 'new' });
    assert.deepEqual(Object.keys(map), ['Dev']);
    assert.deepEqual(map.Dev, { id: 'new' });
  });

  test('creates the key with the given casing when the department is new', () => {
    const map: Record<string, any> = {};
    deptMapSet(map, 'Migration', { id: 'x' });
    assert.deepEqual(Object.keys(map), ['Migration']);
  });

  test('does not create a blank key for a null or empty department', () => {
    const map: Record<string, any> = {};
    deptMapSet(map, null, { id: 'x' });
    deptMapSet(map, '  ', { id: 'y' });
    assert.deepEqual(Object.keys(map), []);
  });

  test('stores an explicit null without creating a second casing', () => {
    const map: Record<string, any> = { 'Pre-Sales': { id: 'a' } };
    deptMapSet(map, 'pre-sales', null);
    assert.deepEqual(Object.keys(map), ['Pre-Sales']);
    assert.equal(map['Pre-Sales'], null);
  });
});

describe('deptMapDelete', () => {
  test('removes the entry whatever casing it was stored under', () => {
    const map: Record<string, any> = { 'Pre-Sales': { id: 'a' }, Dev: { id: 'b' } };
    deptMapDelete(map, 'PRE-SALES');
    assert.deepEqual(Object.keys(map), ['Dev']);
  });

  test('is a no-op when the department is absent, null or blank', () => {
    const map: Record<string, any> = { Dev: { id: 'b' } };
    deptMapDelete(map, 'QA');
    deptMapDelete(map, null);
    deptMapDelete(map, '');
    assert.deepEqual(Object.keys(map), ['Dev']);
  });
});
