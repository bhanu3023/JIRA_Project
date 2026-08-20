/**
 * Sync descriptions for ALL boards from Jira â†’ local PostgreSQL
 * Matches by summary (title) since key numbers differ across boards
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const DATABASE_URL = 'postgresql://postgres:neutara123@localhost:5432/neutara_db';
const { Pool } = require('./node_modules/pg/lib/index.js');
const { PrismaPg } = require('./node_modules/@prisma/adapter-pg/dist/index.js');
const { PrismaClient } = require('./node_modules/@prisma/client/index.js');
const pool = new Pool({ connectionString: DATABASE_URL });
const adapter = new PrismaPg(pool);
const db = new PrismaClient({ adapter });

const EMAIL     = 'sujana.manapuram@cloudfuze.com';
const API_TOKEN = 'REDACTED_API_TOKEN';
const AUTH      = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64');
const JIRA_URL  = 'https://cf2020.atlassian.net';

// Map: local issue key prefix â†’ Jira project key(s) to search
// Multiple Jira projects may feed the same local board
const BOARD_MAP = [
  { prefix: 'TEST',   jiraProjects: ['TEST','QPTT','QTTSS'] },
  { prefix: 'L2B',    jiraProjects: ['L2B'] },
  { prefix: 'L1BOAR', jiraProjects: ['CFITS'] },
  { prefix: 'IB',     jiraProjects: ['IN','SYS'] },
  { prefix: 'PSM',    jiraProjects: ['PSM','PSR'] },
  { prefix: 'QAB',    jiraProjects: ['QA'] },
  { prefix: 'CFM',    jiraProjects: ['CFM','CF','CFC','CLOUDFUZE'] },
  { prefix: 'L3B',    jiraProjects: ['L3B','L3'] },
  { prefix: 'MB',     jiraProjects: ['MB','CST','STT','MSTT','STMTS'] },
  { prefix: 'EB',     jiraProjects: ['EB','EM','OMM','OGM','GM','GD'] },
  { prefix: 'CB',     jiraProjects: ['CB','CM','CMQ2'] },
  { prefix: 'SOPS',   jiraProjects: ['SOPS','SO','SAL','SR'] },
];

/** ADF â†’ plain text */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'paragraph') return (node.content||[]).map(adfToText).join('') + '\n';
  if (node.type === 'heading') return '\n' + (node.content||[]).map(adfToText).join('') + '\n';
  if (node.type === 'bulletList') return (node.content||[]).map(li => 'â€¢ ' + (li.content||[]).map(adfToText).join('').trim()).join('\n') + '\n';
  if (node.type === 'orderedList') return (node.content||[]).map((li,i) => `${i+1}. ` + (li.content||[]).map(adfToText).join('').trim()).join('\n') + '\n';
  if (node.type === 'codeBlock') return '```\n' + (node.content||[]).map(adfToText).join('') + '```\n';
  if (node.type === 'blockquote') return (node.content||[]).map(adfToText).join('');
  if (node.content) return node.content.map(adfToText).join('');
  return '';
}

function normalize(str) {
  return (str || '').toLowerCase().replace(/\s+/g,' ').trim();
}

async function fetchJiraIssues(jiraProjects) {
  const all = [];
  const jql = `project in (${jiraProjects.join(',')}) ORDER BY created DESC`;
  let nextPageToken = null;
  do {
    const params = new URLSearchParams({ jql, maxResults: '100', fields: 'summary,description' });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    const res = await fetch(`${JIRA_URL}/rest/api/3/search/jql?${params}`, {
      headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`    âš  Jira error ${res.status} for ${jiraProjects.join(',')}`);
      return all;
    }
    const data = await res.json();
    if (data.errorMessages?.length) {
      console.warn(`    âš  Jira: ${data.errorMessages.join(', ')}`);
      return all;
    }
    all.push(...(data.issues || []));
    nextPageToken = data.isLast ? null : data.nextPageToken;
    if (nextPageToken) await new Promise(r => setTimeout(r, 100));
  } while (nextPageToken);
  return all;
}

async function syncBoard({ prefix, jiraProjects }) {
  console.log(`\nâ”€â”€ ${prefix} (Jira: ${jiraProjects.join(', ')}) â”€â”€`);

  // Load local issues for this prefix into summary map
  const localIssues = await db.issue.findMany({
    where: { key: { startsWith: `${prefix}-` } },
    select: { id: true, key: true, summary: true, updatedAt: true },
  });
  if (!localIssues.length) { console.log(`  No local issues found, skipping`); return { updated: 0 }; }

  const summaryMap = new Map();
  for (const issue of localIssues) {
    const norm = normalize(issue.summary);
    if (!summaryMap.has(norm)) summaryMap.set(norm, issue);
  }
  console.log(`  Local issues: ${localIssues.length} | Unique summaries: ${summaryMap.size}`);

  // Fetch from Jira
  process.stdout.write(`  Fetching from Jira...`);
  const jiraIssues = await fetchJiraIssues(jiraProjects);
  console.log(` got ${jiraIssues.length} issues`);

  // Match and update in batches
  let updated = 0, noDesc = 0, noMatch = 0;
  const updateBatch = [];

  for (const ji of jiraIssues) {
    const descRaw = ji.fields?.description;
    if (!descRaw) { noDesc++; continue; }
    const descText = adfToText(descRaw).trim();
    if (!descText) { noDesc++; continue; }

    const norm = normalize(ji.fields?.summary || '');
    const local = summaryMap.get(norm);
    if (!local) { noMatch++; continue; }

    updateBatch.push({ id: local.id, description: descText, updatedAt: local.updatedAt });
    updated++;
  }

  // Execute updates in parallel batches of 50
  const BATCH = 50;
  for (let i = 0; i < updateBatch.length; i += BATCH) {
    const chunk = updateBatch.slice(i, i + BATCH);
    // updatedAt is @updatedAt in the schema, so Prisma silently resets it to
    // "now" on any update that doesn't pass it explicitly -- this is a
    // data-correction sync, not real ticket activity, so preserve the real
    // (Jira-sourced) updatedAt instead of stomping it.
    await Promise.all(chunk.map(u => db.issue.update({ where: { id: u.id }, data: { description: u.description, updatedAt: u.updatedAt } })));
    process.stdout.write(`\r  Updated ${Math.min(i + BATCH, updateBatch.length)}/${updateBatch.length}...`);
  }

  console.log(`\r  âœ… Updated: ${updated} | No desc: ${noDesc} | No match: ${noMatch}       `);
  return { updated };
}

async function main() {
  console.log('â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
  console.log('â•‘  Syncing ALL board descriptions from Jira   â•‘');
  console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');

  let totalUpdated = 0;
  for (const board of BOARD_MAP) {
    try {
      const { updated } = await syncBoard(board);
      totalUpdated += updated;
    } catch (e) {
      console.error(`  âŒ Error for ${board.prefix}:`, e.message);
    }
  }

  console.log(`\n${'â•'.repeat(50)}`);
  console.log(`ðŸŽ‰ ALL DONE! Total descriptions synced: ${totalUpdated}`);
  console.log(`${'â•'.repeat(50)}`);

  await db.$disconnect();
  await pool.end();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

