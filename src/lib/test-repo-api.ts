/**
 * test-repo-api.ts
 * Test Repository: a per-Space folder tree of test cases, matching the
 * format of the standalone QA tool at qaagent.cftools.live/test-repository
 * (Folders sidebar with per-folder test counts, a searchable test list,
 * Manual/Automated + status badges, step-by-step detail). Imported test
 * cases (source='imported', from that tool's own data dump) and ones
 * created directly in this app (source='local') live in the same tables,
 * same as that tool's own local-vs-synced split.
 *
 * Folder test counts are always computed live from the real rows (COUNT
 * WHERE "folderPath" = ...), never stored/cached -- this engagement found
 * repeated bugs elsewhere in this app from trusting a frozen snapshot
 * count instead of the real data (stale sla_snapshot, stale updatedAt,
 * etc.), so this module doesn't repeat that mistake.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pgPool as pool } from '@/lib/pg-pool';

export const testRepoSchemaReady = pool.query(`
  CREATE TABLE IF NOT EXISTS test_repo_folders (
    id TEXT PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    "parentPath" TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`)
  .then(() => pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS test_repo_folders_space_path_idx ON test_repo_folders("spaceId", path)`))
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS test_repo_folders_space_parent_idx ON test_repo_folders("spaceId", "parentPath")`))
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS test_cases (
      id TEXT PRIMARY KEY,
      "spaceId" TEXT NOT NULL,
      "jiraKey" TEXT,
      "issueId" TEXT,
      summary TEXT NOT NULL,
      description TEXT,
      "testType" TEXT NOT NULL DEFAULT 'Manual',
      status TEXT NOT NULL DEFAULT 'To Do',
      "folderPath" TEXT NOT NULL DEFAULT '/',
      steps JSONB NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'local',
      "authorId" TEXT,
      "authorName" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `))
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS test_cases_space_folder_idx ON test_cases("spaceId", "folderPath")`))
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS test_cases_space_idx ON test_cases("spaceId")`))
  .then(() => pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS test_cases_jira_key_idx ON test_cases("jiraKey") WHERE "jiraKey" IS NOT NULL`))
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS test_case_attachments (
      id TEXT PRIMARY KEY,
      "testCaseId" TEXT NOT NULL,
      "stepNumber" INTEGER NOT NULL,
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      "mimeType" TEXT,
      size INTEGER,
      "authorName" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `))
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS test_case_attachments_test_idx ON test_case_attachments("testCaseId")`))
  .catch(() => {});

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function rid() {
  return `tc_${Math.random().toString(36).slice(2, 12)}`;
}

function normalizePath(p: string): string {
  const trimmed = (p || '/').trim();
  if (!trimmed || trimmed === '/') return '/';
  const parts = trimmed.split('/').filter(Boolean);
  return '/' + parts.join('/');
}

function parentOf(path: string): string {
  if (path === '/') return '';
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '/';
}

function nameOf(path: string): string {
  if (path === '/') return 'Test Repository';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

async function resolveSpaceId(spaceKey: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [spaceKey.toUpperCase()]);
  return rows[0]?.id || null;
}

export async function handleTestRepoApi(
  req: NextRequest,
  path: string,
  method: string,
  url: URL,
  ctx: { userId: string; currentUser: any },
): Promise<NextResponse | null> {
  if (path !== 'test-repository' && !path.startsWith('test-repository/')) return null;
  const { userId, currentUser } = ctx;
  if (!userId) return json({ error: 'Unauthorized' }, 401);
  await testRepoSchemaReady;

  const sub = path.slice('test-repository'.length).replace(/^\//, '');

  // GET test-repository/folders?spaceKey= -- every folder in this space,
  // flat (path/parentPath), each with a CUMULATIVE test count -- every test
  // directly in that folder PLUS every test in any of its subfolders,
  // matching the source tool's own sidebar counts (confirmed for real:
  // qaagent.cftools.live shows "CloudFuze Manage (1965)" in the tree and,
  // on opening that folder, "Total Tests: 1965 (includes subfolders)" --
  // the exact same rolled-up number, not a direct-only count).
  if (sub === 'folders' && method === 'GET') {
    const spaceKey = url.searchParams.get('spaceKey');
    if (!spaceKey) return json({ error: 'spaceKey is required' }, 400);
    const spaceId = await resolveSpaceId(spaceKey);
    if (!spaceId) return json({ error: 'Space not found' }, 404);

    const { rows: folders } = await pool.query(
      `SELECT id, name, path, "parentPath" FROM test_repo_folders WHERE "spaceId" = $1 ORDER BY path ASC`,
      [spaceId],
    );
    const { rows: counts } = await pool.query(
      `SELECT "folderPath", COUNT(*)::int AS count FROM test_cases WHERE "spaceId" = $1 GROUP BY "folderPath"`,
      [spaceId],
    );
    const directCountByPath = new Map<string, number>(counts.map((c: any) => [c.folderPath, c.count]));
    const allPaths = ['/', ...folders.map((f: any) => f.path)];
    const cumulativeCount = (path: string) => {
      let total = 0;
      for (const p of allPaths) {
        if (p === path || p.startsWith(path === '/' ? '/' : `${path}/`)) total += directCountByPath.get(p) || 0;
      }
      return total;
    };

    return json([
      { id: 'root', name: 'Test Repository', path: '/', parentPath: '', testsCount: cumulativeCount('/') },
      ...folders.map((f: any) => ({ ...f, testsCount: cumulativeCount(f.path) })),
    ]);
  }

  // POST test-repository/folders {spaceKey, name, parentPath}
  if (sub === 'folders' && method === 'POST') {
    const body: any = await req.json().catch(() => ({}));
    const spaceKey = String(body.spaceKey || '');
    const spaceId = await resolveSpaceId(spaceKey);
    if (!spaceId) return json({ error: 'Space not found' }, 404);
    const name = String(body.name || '').trim();
    if (!name) return json({ error: 'Folder name is required' }, 400);
    const parentPath = normalizePath(body.parentPath || '/');
    const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;

    const existing = await pool.query(`SELECT id FROM test_repo_folders WHERE "spaceId" = $1 AND path = $2`, [spaceId, path]);
    if (existing.rows.length) return json({ error: 'A folder with this name already exists here' }, 409);

    const id = rid();
    await pool.query(
      `INSERT INTO test_repo_folders (id, "spaceId", name, path, "parentPath", source) VALUES ($1,$2,$3,$4,$5,'local')`,
      [id, spaceId, name, path, parentPath === '/' ? '/' : parentPath],
    );
    return json({ id, name, path, parentPath, testsCount: 0 }, 201);
  }

  // DELETE test-repository/folders/:id -- only when empty (no direct tests,
  // no subfolders), same safety rule the source tool enforces.
  const folderDel = sub.match(/^folders\/([^/]+)$/);
  if (folderDel && method === 'DELETE') {
    const { rows } = await pool.query(`SELECT * FROM test_repo_folders WHERE id = $1`, [folderDel[1]]);
    const folder = rows[0];
    if (!folder) return json({ error: 'Folder not found' }, 404);
    const { rows: childFolders } = await pool.query(`SELECT 1 FROM test_repo_folders WHERE "spaceId" = $1 AND "parentPath" = $2 LIMIT 1`, [folder.spaceId, folder.path]);
    const { rows: childTests } = await pool.query(`SELECT 1 FROM test_cases WHERE "spaceId" = $1 AND "folderPath" = $2 LIMIT 1`, [folder.spaceId, folder.path]);
    if (childFolders.length || childTests.length) return json({ error: 'Folder is not empty -- move or delete its contents first' }, 409);
    await pool.query(`DELETE FROM test_repo_folders WHERE id = $1`, [folderDel[1]]);
    return json({ ok: true });
  }

  // GET test-repository/tests?spaceKey=&folderPath=&q=&page=&limit=
  if (sub === 'tests' && method === 'GET') {
    const spaceKey = url.searchParams.get('spaceKey');
    if (!spaceKey) return json({ error: 'spaceKey is required' }, 400);
    const spaceId = await resolveSpaceId(spaceKey);
    if (!spaceId) return json({ error: 'Space not found' }, 404);

    const folderPath = url.searchParams.get('folderPath');
    const q = (url.searchParams.get('q') || '').trim();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const offset = (page - 1) * limit;

    const where: string[] = [`"spaceId" = $1`];
    const params: any[] = [spaceId];
    let n = 2;
    // A selected folder shows its own tests PLUS every subfolder's, same as
    // the folder tree's own cumulative counts above (and the source tool's
    // "Total Tests: X (includes subfolders)" list view) -- root ('/') needs
    // no filter at all, since every folderPath already starts with '/'.
    const normalizedFolder = folderPath ? normalizePath(folderPath) : null;
    if (normalizedFolder && normalizedFolder !== '/') {
      where.push(`("folderPath" = $${n} OR "folderPath" LIKE $${n + 1})`);
      params.push(normalizedFolder, `${normalizedFolder}/%`);
      n += 2;
    }
    if (q) { where.push(`(summary ILIKE $${n} OR "jiraKey" ILIKE $${n})`); params.push(`%${q}%`); n++; }

    const totalRes = await pool.query(`SELECT COUNT(*)::int AS count FROM test_cases WHERE ${where.join(' AND ')}`, params);
    const rows = await pool.query(
      `SELECT id, "jiraKey", "issueId", summary, "testType", status, "folderPath", source, "createdAt", "updatedAt"
       FROM test_cases WHERE ${where.join(' AND ')}
       ORDER BY "createdAt" DESC LIMIT $${n} OFFSET $${n + 1}`,
      [...params, limit, offset],
    );
    return json({ total: totalRes.rows[0].count, page, limit, tests: rows.rows });
  }

  // POST test-repository/tests {spaceKey, summary, folderPath, testType, status, description, steps}
  if (sub === 'tests' && method === 'POST') {
    const body: any = await req.json().catch(() => ({}));
    const spaceId = await resolveSpaceId(String(body.spaceKey || ''));
    if (!spaceId) return json({ error: 'Space not found' }, 404);
    const summary = String(body.summary || '').trim();
    if (!summary) return json({ error: 'Summary is required' }, 400);
    const folderPath = normalizePath(body.folderPath || '/');
    const testType = body.testType === 'Automated' ? 'Automated' : 'Manual';
    const status = String(body.status || 'To Do').trim() || 'To Do';
    const steps = Array.isArray(body.steps) ? body.steps : [];

    const id = rid();
    const row = await pool.query(
      `INSERT INTO test_cases (id, "spaceId", summary, description, "testType", status, "folderPath", steps, source, "authorId", "authorName")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'local',$9,$10) RETURNING *`,
      [id, spaceId, summary, body.description || null, testType, status, folderPath, JSON.stringify(steps), userId, `${currentUser?.firstName || ''} ${currentUser?.lastName || ''}`.trim() || null],
    );
    return json(row.rows[0], 201);
  }

  // GET/PATCH/DELETE test-repository/tests/:id
  const testById = sub.match(/^tests\/([^/]+)$/);
  if (testById) {
    const id = testById[1];
    if (method === 'GET') {
      const { rows } = await pool.query(`SELECT * FROM test_cases WHERE id = $1`, [id]);
      if (!rows.length) return json({ error: 'Test not found' }, 404);
      const { rows: attachments } = await pool.query(
        `SELECT id, "stepNumber", filename, url, "mimeType", size, "authorName", "createdAt" FROM test_case_attachments WHERE "testCaseId" = $1 ORDER BY "createdAt" ASC`,
        [id],
      );
      return json({ ...rows[0], attachments });
    }
    if (method === 'PATCH') {
      const body: any = await req.json().catch(() => ({}));
      const existing = (await pool.query(`SELECT * FROM test_cases WHERE id = $1`, [id])).rows[0];
      if (!existing) return json({ error: 'Test not found' }, 404);
      const next = {
        summary: body.summary !== undefined ? String(body.summary).trim() : existing.summary,
        description: body.description !== undefined ? body.description : existing.description,
        testType: body.testType === 'Automated' || body.testType === 'Manual' ? body.testType : existing.testType,
        status: body.status !== undefined ? String(body.status) : existing.status,
        folderPath: body.folderPath !== undefined ? normalizePath(body.folderPath) : existing.folderPath,
        steps: body.steps !== undefined ? JSON.stringify(body.steps) : JSON.stringify(existing.steps),
      };
      const row = await pool.query(
        `UPDATE test_cases SET summary=$2, description=$3, "testType"=$4, status=$5, "folderPath"=$6, steps=$7, "updatedAt"=NOW()
         WHERE id=$1 RETURNING *`,
        [id, next.summary, next.description, next.testType, next.status, next.folderPath, next.steps],
      );
      return json(row.rows[0]);
    }
    if (method === 'DELETE') {
      const result = await pool.query(`DELETE FROM test_cases WHERE id = $1`, [id]);
      if (!result.rowCount) return json({ error: 'Test not found' }, 404);
      return json({ ok: true });
    }
  }

  // POST test-repository/tests/:id/steps/:stepNumber/attachments -- any file
  // type, no restriction (image, PDF, Excel, etc.), same as ticket
  // attachments. The frontend's "Attach folder" picker just calls this once
  // per file it picked, same pattern issues/:key/attachments already uses.
  const stepAttach = sub.match(/^tests\/([^/]+)\/steps\/(\d+)\/attachments$/);
  if (stepAttach && method === 'POST') {
    const testCaseId = stepAttach[1];
    const stepNumber = parseInt(stepAttach[2], 10);
    const existing = (await pool.query(`SELECT id FROM test_cases WHERE id = $1`, [testCaseId])).rows[0];
    if (!existing) return json({ error: 'Test not found' }, 404);
    const formData = await req.formData().catch(() => null);
    const file = formData?.get('file') as File | null;
    if (!file) return json({ error: 'No file provided' }, 400);
    const { writeFile, mkdir } = await import('fs/promises');
    const { join, extname } = await import('path');
    const uploadDir = join(process.cwd(), 'public', 'uploads', 'test-repository');
    await mkdir(uploadDir, { recursive: true });
    const ext = extname(file.name) || '';
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    await writeFile(join(uploadDir, uniqueName), Buffer.from(await file.arrayBuffer()));
    const url = `/uploads/test-repository/${uniqueName}`;
    const attId = rid();
    const authorName = `${currentUser?.firstName || ''} ${currentUser?.lastName || ''}`.trim() || null;
    const row = await pool.query(
      `INSERT INTO test_case_attachments (id, "testCaseId", "stepNumber", filename, url, "mimeType", size, "authorName")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, "stepNumber", filename, url, "mimeType", size, "authorName", "createdAt"`,
      [attId, testCaseId, stepNumber, file.name, url, file.type || null, file.size || null, authorName],
    );
    return json(row.rows[0], 201);
  }

  // DELETE test-repository/attachments/:attachmentId
  const attachDel = sub.match(/^attachments\/([^/]+)$/);
  if (attachDel && method === 'DELETE') {
    const result = await pool.query(`DELETE FROM test_case_attachments WHERE id = $1`, [attachDel[1]]);
    if (!result.rowCount) return json({ error: 'Attachment not found' }, 404);
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}
