import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Ticket "Attachments" (POST /api/issues/:key/attachments in jira-pg-api.ts)
// writes files into <cwd>/public/uploads and stores their URL as plain
// "/uploads/<name>", relying on Next's built-in static handler for /public
// to serve them back. That handler is backed by a route manifest built at
// BUILD time -- any file written into public/uploads/ while the server is
// already running (i.e. every attachment ever uploaded in production,
// since the build happens once per deploy) has no entry in that manifest
// and 404s even though it's sitting right there on disk, which is exactly
// why opening an uploaded attachment showed a blocked/unsupported-content
// icon instead of the file. This route shadows that dead static path with
// a normal per-request disk read, the same fix already applied to the
// description/comment image-upload path's own /api/uploads/tmp/... URLs
// (see the "Serve previously uploaded files" handler in jira-pg-api.ts).
export async function GET(_req: NextRequest, { params }: { params: { path?: string[] } }) {
  try {
    const nodePath = await import('path');
    const { readFile, stat } = await import('fs/promises');
    const uploadsRoot = nodePath.join(process.cwd(), 'public', 'uploads');
    const safeSegments = (params.path ?? []).map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_'));
    const filePath = nodePath.resolve(uploadsRoot, ...safeSegments);
    if (!filePath.startsWith(uploadsRoot)) return new NextResponse(null, { status: 400 });
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) return new NextResponse(null, { status: 404 });
    const buf = await readFile(filePath);
    const ext = (safeSegments[safeSegments.length - 1]?.split('.').pop() || '').toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', zip: 'application/zip',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return new NextResponse(buf, {
      headers: {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new NextResponse(null, { status: 500 });
  }
}
