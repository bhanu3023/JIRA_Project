/**
 * Run with:  npm test
 *
 * Covers getEffectiveIssueStatus's department lookup -- the actual user-facing
 * behaviour the dept-map extraction was made to fix. Same conventions as
 * src/analytics/hotjar.test.ts: node:test, node:assert/strict, no framework.
 *
 * Unlike dept-map.test.ts, this file does resolve node_modules, because
 * utils.ts imports clsx at module scope.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getEffectiveIssueStatus } from './utils.ts';

/** A global status shaped the way getIssueStatus requires (id/name/color strings). */
const QA_IN_PROGRESS = { id: 'status_qa_inprogress', name: 'In Progress', color: '#3B82F6', category: 'in_progress' };
const DONE = { id: 'status_done', name: 'Resolved', color: '#10B981', category: 'done' };

describe('getEffectiveIssueStatus -- department snapshot lookup', () => {
  test('prefers the per-department queue status when the casing matches', () => {
    const issue = {
      status: QA_IN_PROGRESS,
      dept_statuses: { 'Pre-Sales': { id: 'qst_presales_1', name: 'Awaiting Scope', category: 'todo' } },
      current_department: 'Pre-Sales',
    };
    assert.equal(getEffectiveIssueStatus(issue).name, 'Awaiting Scope');
  });

  test('CF-29995 regression: still prefers it when the casing differs', () => {
    // The ticket's current_department was stored as "Pre-sales" while its own
    // dept_statuses key was written as "Pre-Sales". The old case-sensitive
    // lookup missed, fell through, and rendered status_qa_inprogress -- a
    // leftover from the ticket's earlier trip through QA -- while it sat in
    // Pre-Sales. Its status dropdown then matched no transition at all.
    const issue = {
      status: QA_IN_PROGRESS,
      dept_statuses: { 'Pre-Sales': { id: 'qst_presales_1', name: 'Awaiting Scope', category: 'todo' } },
      current_department: 'Pre-sales',
    };
    const result = getEffectiveIssueStatus(issue);
    assert.equal(result.name, 'Awaiting Scope');
    assert.equal(result.id, 'qst_presales_1');
    assert.notEqual(result.id, 'status_qa_inprogress');
  });

  test('the same mismatch through an explicit viewDept, as the Filters page passes', () => {
    const issue = {
      status: QA_IN_PROGRESS,
      dept_statuses: { Migration: { id: 'qst_mig_1', name: 'In Migration', category: 'in_progress' } },
      current_department: 'Dev',
    };
    assert.equal(getEffectiveIssueStatus(issue, 'migration').name, 'In Migration');
  });

  test('falls through to the global status when the department has no snapshot', () => {
    const issue = {
      status: QA_IN_PROGRESS,
      dept_statuses: { Dev: { id: 'qst_dev_1', name: 'In Dev', category: 'in_progress' } },
      current_department: 'Pre-Sales',
    };
    assert.equal(getEffectiveIssueStatus(issue).id, 'status_qa_inprogress');
  });

  test('falls through when there is no current department at all', () => {
    const issue = {
      status: QA_IN_PROGRESS,
      dept_statuses: { Dev: { id: 'qst_dev_1', name: 'In Dev', category: 'in_progress' } },
      current_department: null,
    };
    assert.equal(getEffectiveIssueStatus(issue).id, 'status_qa_inprogress');
  });

  test('a stale "Routed to X" label still yields to a genuinely done status', () => {
    // Pre-existing behaviour, retained: once the ticket is actually resolved,
    // the routing department's frozen handoff label must stop winning.
    // Asserted with mismatched casing so the fix cannot resurrect it.
    const issue = {
      status: DONE,
      dept_statuses: { 'Pre-Sales': { id: 'qst_route_1', name: 'Routed to Dev', category: 'todo' } },
      current_department: 'pre-sales',
    };
    assert.equal(getEffectiveIssueStatus(issue).name, 'Resolved');
  });

  test('a virtual placeholder entry (empty id with a name) is still preferred', () => {
    const issue = {
      status: QA_IN_PROGRESS,
      dept_statuses: { 'Pre-Sales': { id: '', name: 'Waiting for Migration', color: '#F59E0B' } },
      current_department: 'PRE-SALES',
    };
    assert.equal(getEffectiveIssueStatus(issue).name, 'Waiting for Migration');
  });

  test('no dept_statuses at all is safe', () => {
    const issue = { status: QA_IN_PROGRESS, dept_statuses: null, current_department: 'Dev' };
    assert.equal(getEffectiveIssueStatus(issue).id, 'status_qa_inprogress');
  });
});
