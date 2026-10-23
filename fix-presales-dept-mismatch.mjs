// One-time data fix: 37 tickets ("Pre-Sales": 35, "Pre-sales": 2) have
// current_department/original_dept set to a department name that no longer
// matches any real queue -- the live queue Vignesh (and 2 other people) are
// actually members of is "Pre-Sales-Old". Moves every such ticket (and its
// related per-ticket JSONB snapshots, SLA policies, round-robin config,
// linked email addresses, worklogs, and worked-on-credit rows) onto
// "Pre-Sales-Old", replicating the exact same multi-table migration the
// admin "rename queue" endpoint already does (custom-queues/:key/:id/rename
// in src/lib/jira-pg-api.ts), just run directly against a department STRING
// that was never actually a queue's real name instead of against a queue id.
//
// Also fixes the actual root cause so this can't keep happening: Dev, Infra
// and QA each still have a queue status literally named "Routed to
// Pre-sales" (qst_dev_waitingpresales / qst_infra_waitingpresales /
// qst_qa_waitingpresales) -- stale text from before "Pre-sales" was
// renamed/split into Pre-Sales-Old/Pre-Sales-Team. The department-handoff
// logic parses the TARGET department straight out of that status name
// (see the /^(?:waiting\s+for|routed\s+to)\s+(.+)$/i match in the PATCH
// issue handler), so every future handoff through that status would recreate
// today's exact bug. Renamed to "Routed to Pre-Sales-Old" so future handoffs
// land on the real, member-populated queue.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const OLD_NAMES = ['Pre-Sales', 'Pre-sales'];
const NEW_NAME = 'Pre-Sales-Old';
const STALE_STATUS_IDS = ['qst_dev_waitingpresales', 'qst_infra_waitingpresales', 'qst_qa_waitingpresales'];
const REASON_RANK = { closed: 3, worked: 2, returned: 1, passed: 0 };

async function main() {
  const spaceRow = await pool.query(`SELECT id FROM spaces WHERE key = $1 LIMIT 1`, [SPACE_KEY]);
  const spaceId = spaceRow.rows[0]?.id;
  if (!spaceId) throw new Error('Space not found');

  const client = await pool.connect();
  const result = { issuesCurrent: 0, issuesOriginal: 0, slaPolicies: 0, worklogs: 0, workedOnRows: 0, emailConfigs: 0, roundRobin: false, jsonbTouched: 0, statusesFixed: 0 };
  try {
    await client.query('BEGIN');

    for (const oldName of OLD_NAMES) {
      // 1. Plain string columns on issues.
      const curDeptRes = await client.query(
        `UPDATE issues SET current_department = $1 WHERE "spaceId" = $2 AND LOWER(current_department) = LOWER($3)`,
        [NEW_NAME, spaceId, oldName]
      );
      result.issuesCurrent += curDeptRes.rowCount || 0;
      const origDeptRes = await client.query(
        `UPDATE issues SET original_dept = $1 WHERE "spaceId" = $2 AND LOWER(original_dept) = LOWER($3)`,
        [NEW_NAME, spaceId, oldName]
      );
      result.issuesOriginal += origDeptRes.rowCount || 0;

      // 2. Per-ticket JSONB snapshots -- rename matching keys.
      const jsonbCols = ['dept_sla_log', 'dept_statuses', 'dept_assignees'];
      for (const col of jsonbCols) {
        const rows = await client.query(
          `SELECT id, ${col} FROM issues WHERE "spaceId" = $1 AND ${col} IS NOT NULL AND ${col} != '{}'::jsonb`,
          [spaceId]
        );
        for (const r of rows.rows) {
          const obj = r[col];
          if (!obj || typeof obj !== 'object') continue;
          const matchingKeys = Object.keys(obj).filter((k) => k.toLowerCase() === oldName.toLowerCase() && k !== NEW_NAME);
          if (!matchingKeys.length) continue;
          const next = { ...obj };
          if (col === 'dept_sla_log') {
            let totalElapsed = Number(next[NEW_NAME]?.elapsed_ms) || 0;
            let merged = next[NEW_NAME] || {};
            for (const k of matchingKeys) {
              totalElapsed += Number(next[k]?.elapsed_ms) || 0;
              merged = { ...merged, ...next[k] };
            }
            next[NEW_NAME] = { ...merged, elapsed_ms: totalElapsed };
          } else {
            for (const k of matchingKeys) next[NEW_NAME] = next[k];
          }
          for (const k of matchingKeys) delete next[k];
          await client.query(`UPDATE issues SET ${col} = $1 WHERE id = $2`, [JSON.stringify(next), r.id]);
          result.jsonbTouched++;
        }
      }

      // 3. SLA policies scoped to this department.
      const slaRes = await client.query(
        `UPDATE sla_definitions SET dept_name = $1 WHERE "spaceId" = $2 AND LOWER(dept_name) = LOWER($3)`,
        [NEW_NAME, spaceId, oldName]
      );
      result.slaPolicies += slaRes.rowCount || 0;

      // 4. Round-robin roster.
      const rrRow = await client.query(`SELECT departments FROM rr_config WHERE space_id = $1`, [spaceId]);
      const rrDepts = rrRow.rows[0]?.departments || [];
      const rrMatch = rrDepts.find((d) => (d.name || '').toLowerCase() === oldName.toLowerCase());
      if (rrMatch) {
        const nextRr = rrDepts.map((d) => d === rrMatch ? { ...d, name: NEW_NAME } : d);
        await client.query(`UPDATE rr_config SET departments = $1, updated_at = NOW() WHERE space_id = $2`, [JSON.stringify(nextRr), spaceId]);
        result.roundRobin = true;
      }

      // 5. Linked email addresses.
      const emailRes = await client.query(
        `UPDATE email_configs SET department = $1 WHERE space_key = $2 AND LOWER(department) = LOWER($3)`,
        [NEW_NAME, SPACE_KEY, oldName]
      );
      result.emailConfigs += emailRes.rowCount || 0;

      // 6. Worklog entries.
      const worklogRes = await client.query(
        `UPDATE issue_worklogs SET department = $1
         WHERE LOWER(department) = LOWER($2) AND "issueId" IN (SELECT id FROM issues WHERE "spaceId" = $3)`,
        [NEW_NAME, oldName, spaceId]
      );
      result.worklogs += worklogRes.rowCount || 0;

      // 7. Worked-on-credit rows, with the unique-constraint dedup merge.
      const candidateRows = await client.query(
        `SELECT id, user_id, issue_id, reason, worked_at FROM user_worked_on_tickets
         WHERE (LOWER(dept) = LOWER($1) OR LOWER(dept) = LOWER($2))
           AND issue_id IN (SELECT id FROM issues WHERE "spaceId" = $3)`,
        [oldName, NEW_NAME, spaceId]
      );
      const groupedByPair = new Map();
      for (const r of candidateRows.rows) {
        const key = `${r.user_id}:${r.issue_id}`;
        if (!groupedByPair.has(key)) groupedByPair.set(key, []);
        groupedByPair.get(key).push(r);
      }
      for (const group of groupedByPair.values()) {
        if (group.length <= 1) continue;
        group.sort((a, b) => {
          const rankDiff = (REASON_RANK[b.reason] ?? -1) - (REASON_RANK[a.reason] ?? -1);
          if (rankDiff !== 0) return rankDiff;
          return new Date(b.worked_at).getTime() - new Date(a.worked_at).getTime();
        });
        const [survivor, ...losers] = group;
        await client.query(`UPDATE user_worked_on_tickets SET reason = $1, worked_at = $2 WHERE id = $3`, [survivor.reason, survivor.worked_at, survivor.id]);
        for (const loser of losers) {
          await client.query(`DELETE FROM user_worked_on_tickets WHERE id = $1`, [loser.id]);
        }
      }
      const workedOnRes = await client.query(
        `UPDATE user_worked_on_tickets SET dept = $1
         WHERE LOWER(dept) = LOWER($2) AND issue_id IN (SELECT id FROM issues WHERE "spaceId" = $3)`,
        [NEW_NAME, oldName, spaceId]
      );
      result.workedOnRows += workedOnRes.rowCount || 0;
    }

    // 8. Fix the stale "Routed to Pre-sales" status labels on Dev/Infra/QA so
    // future handoffs through them land on the real, member-populated queue.
    const qRow = await client.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
    const queues = qRow.rows[0]?.queues || [];
    const nextQueues = queues.map((q) => ({
      ...q,
      queueStatuses: (q.queueStatuses || []).map((s) => {
        if (STALE_STATUS_IDS.includes(s.id)) {
          result.statusesFixed++;
          return { ...s, name: `Routed to ${NEW_NAME}` };
        }
        return s;
      }),
    }));
    await client.query(
      `UPDATE custom_queues SET queues = $1, updated_at = NOW() WHERE space_key = $2`,
      [JSON.stringify(nextQueues), SPACE_KEY]
    );

    await client.query('COMMIT');
    console.log('DONE:', result);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('FAILED, rolled back:', e?.message || e);
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
