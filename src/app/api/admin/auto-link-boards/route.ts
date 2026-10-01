/**
 * POST /api/admin/auto-link-boards
 *
 * Automatically links L1BOAR tickets to matching L2BOARD / L3BOARD tickets
 * by normalised title — entirely from local DB, no Jira credentials needed.
 *
 * Body: { secret, sourceSpace, targetSpaces, linkType, dryRun }
 * Defaults: sourceSpace=L1BOAR, targetSpaces=[L2BOARD,L3BOARD], linkType=relates
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function rid() {
  return `lnk_${Math.random().toString(36).slice(2, 12)}`;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => ({}));

    const sourceSpaceKey: string = String(body.sourceSpace || 'L1BOAR').toUpperCase();
    const targetSpaceKeys: string[] = body.targetSpaces
      ? (body.targetSpaces as string[]).map((s: string) => s.toUpperCase())
      : ['L2BOARD', 'L3BOARD'];
    const linkType: string = String(body.linkType || 'relates');
    const dryRun: boolean = body.dryRun === true;

    // ── Load source issues ─────────────────────────────────────────────────────
    const sourceSpace = await db.space.findFirst({ where: { key: sourceSpaceKey } });
    if (!sourceSpace) {
      return NextResponse.json({ ok: false, error: `Space ${sourceSpaceKey} not found` }, { status: 404 });
    }

    const sourceIssues = await db.issue.findMany({
      where: { spaceId: sourceSpace.id },
      select: { id: true, key: true, summary: true },
    });

    // ── Load target issues from all target spaces ──────────────────────────────
    const targetSpaces = await db.space.findMany({
      where: { key: { in: targetSpaceKeys } },
    });
    const targetSpaceIds = targetSpaces.map((s: any) => s.id);

    const targetIssues = await db.issue.findMany({
      where: { spaceId: { in: targetSpaceIds } },
      select: { id: true, key: true, summary: true },
    });

    // ── Build normalized title index for target issues ─────────────────────────
    // Map: normalizedTitle → target issue key
    const targetByNorm = new Map<string, string>();
    for (const ti of targetIssues) {
      if (!ti.summary) continue;
      const norm = normalize(ti.summary);
      targetByNorm.set(norm, ti.key);
      // Also index first 60 chars for partial match
      if (norm.length > 20) targetByNorm.set(norm.slice(0, 60), ti.key);
    }

    const targetEntries = Array.from(targetByNorm.entries());

    // ── Load existing links to avoid duplicates ────────────────────────────────
    const existingLinks = await db.issueLink.findMany({
      where: { sourceKey: { in: sourceIssues.map(i => i.key) } },
      select: { sourceKey: true, targetKey: true, linkType: true },
    });
    const existingSet = new Set(
      existingLinks.map(l => `${l.sourceKey}|${l.targetKey}|${l.linkType}`)
    );

    // ── Match and link ─────────────────────────────────────────────────────────
    let linked = 0;
    let alreadyLinked = 0;
    let noMatch = 0;
    const log: string[] = [];

    for (const src of sourceIssues) {
      if (!src.summary) { noMatch++; continue; }
      const srcNorm = normalize(src.summary);

      // Exact match
      let targetKey = targetByNorm.get(srcNorm);

      // Prefix match (first 60 chars)
      if (!targetKey && srcNorm.length > 20) {
        targetKey = targetByNorm.get(srcNorm.slice(0, 60));
      }

      // Substring match — one contains the other (min 15 chars overlap)
      if (!targetKey) {
        for (let i = 0; i < targetEntries.length; i++) {
          const [tNorm, tKey] = targetEntries[i];
          if (tNorm.length < 10) continue;
          const shorter = tNorm.length < srcNorm.length ? tNorm : srcNorm;
          const longer  = tNorm.length >= srcNorm.length ? tNorm : srcNorm;
          if (shorter.length >= 15 && longer.includes(shorter)) {
            targetKey = tKey;
            break;
          }
        }
      }

      if (!targetKey) { noMatch++; continue; }

      const dedupKey = `${src.key}|${targetKey}|${linkType}`;
      if (existingSet.has(dedupKey)) { alreadyLinked++; continue; }

      if (!dryRun) {
        try {
          await db.issueLink.upsert({
            where: { sourceKey_targetKey_linkType: { sourceKey: src.key, targetKey, linkType } },
            create: { id: rid(), sourceKey: src.key, targetKey, linkType },
            update: {},
          });
          existingSet.add(dedupKey); // prevent reverse duplicate
        } catch {
          continue;
        }
      }

      linked++;
      if (log.length < 200) log.push(`${src.key} → ${targetKey}`);
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      sourceTotal: sourceIssues.length,
      targetTotal: targetIssues.length,
      linked,
      alreadyLinked,
      noMatch,
      log,
    });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
