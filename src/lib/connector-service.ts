/**
 * Connector Service
 * Fires outgoing events to configured connectors (Webhooks, Slack, Teams, etc.)
 * when issue events happen in the ticketing system.
 */

import crypto from 'crypto';
import { pgPool as pool } from '@/lib/pg-pool';

// Create table on startup
pool.query(`
  CREATE TABLE IF NOT EXISTS connector_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    events TEXT[] NOT NULL DEFAULT '{}',
    space_ids TEXT[] NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});

pool.query(`
  CREATE TABLE IF NOT EXISTS connector_logs (
    id SERIAL PRIMARY KEY,
    connector_id TEXT NOT NULL,
    event TEXT NOT NULL,
    issue_key TEXT,
    status TEXT NOT NULL,
    response_code INT,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});

export type ConnectorType = 'webhook' | 'slack' | 'teams';

export type ConnectorEvent =
  | 'issue.created'
  | 'issue.updated'
  | 'issue.deleted'
  | 'issue.status_changed'
  | 'issue.assigned'
  | 'issue.commented'
  | 'issue.department_changed';

export interface ConnectorConfig {
  id: string;
  name: string;
  type: ConnectorType;
  config: Record<string, any>;
  events: ConnectorEvent[];
  space_ids: string[];  // empty = all spaces
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface IssueEventPayload {
  event: ConnectorEvent;
  timestamp: string;
  issue: {
    key: string;
    cf_key?: string;
    summary: string;
    type: string;
    priority: string;
    status?: string;
    assignee?: string;
    reporter?: string;
    department?: string;
    spaceKey: string;
    spaceName?: string;
    url: string;
  };
  change?: {
    field: string;
    from?: string;
    to?: string;
  };
  actor?: string;
}

// ── Fire event to all matching connectors ────────────────────────────────────

export async function fireConnectorEvent(payload: IssueEventPayload): Promise<void> {
  try {
    const rows = await pool.query<ConnectorConfig>(
      `SELECT * FROM connector_configs WHERE enabled = true AND $1 = ANY(events)`,
      [payload.event]
    );
    if (!rows.rows.length) return;

    // Get space id for this issue's space
    const spaceRow = await pool.query(
      `SELECT id FROM spaces WHERE key = $1`,
      [payload.issue.spaceKey.toUpperCase()]
    ).catch(() => ({ rows: [] as any[] }));
    const spaceId = spaceRow.rows[0]?.id;

    for (const connector of rows.rows) {
      // Filter by space if configured
      if (connector.space_ids?.length && spaceId && !connector.space_ids.includes(spaceId)) continue;

      fire(connector, payload).catch(() => {});
    }
  } catch { /* non-critical */ }
}

async function fire(connector: ConnectorConfig, payload: IssueEventPayload): Promise<void> {
  let status = 'success';
  let responseCode: number | null = null;
  let error: string | null = null;

  try {
    if (connector.type === 'webhook') {
      await fireWebhook(connector, payload);
    } else if (connector.type === 'slack') {
      await fireSlack(connector, payload);
    } else if (connector.type === 'teams') {
      await fireTeams(connector, payload);
    }
  } catch (e: any) {
    status = 'error';
    error = e?.message || String(e);
    responseCode = e?.status || null;
  }

  // Log the result (fire-and-forget)
  pool.query(
    `INSERT INTO connector_logs (connector_id, event, issue_key, status, response_code, error) VALUES ($1,$2,$3,$4,$5,$6)`,
    [connector.id, payload.event, payload.issue.key, status, responseCode, error]
  ).catch(() => {});
}

// ── Webhook ──────────────────────────────────────────────────────────────────

async function fireWebhook(connector: ConnectorConfig, payload: IssueEventPayload): Promise<void> {
  const { url, secret, headers: extraHeaders = {} } = connector.config;
  if (!url) return;

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Neutara-Ticketing/1.0',
    ...extraHeaders,
  };

  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Neutara-Signature'] = `sha256=${sig}`;
  }

  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) {
    const err = new Error(`Webhook returned ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function fireSlack(connector: ConnectorConfig, payload: IssueEventPayload): Promise<void> {
  const { webhookUrl } = connector.config;
  if (!webhookUrl) return;

  const eventLabels: Record<ConnectorEvent, string> = {
    'issue.created': '🆕 New ticket',
    'issue.updated': '✏️ Ticket updated',
    'issue.deleted': '🗑️ Ticket deleted',
    'issue.status_changed': '🔄 Status changed',
    'issue.assigned': '👤 Ticket assigned',
    'issue.commented': '💬 New comment',
    'issue.department_changed': '📤 Department changed',
  };

  const color = payload.event === 'issue.created' ? '#22c55e'
    : payload.event === 'issue.deleted' ? '#ef4444'
    : payload.event === 'issue.status_changed' ? '#3b82f6'
    : '#f59e0b';

  const fields: any[] = [];
  if (payload.issue.assignee) fields.push({ title: 'Assignee', value: payload.issue.assignee, short: true });
  if (payload.issue.status)   fields.push({ title: 'Status',   value: payload.issue.status,   short: true });
  if (payload.issue.priority) fields.push({ title: 'Priority', value: payload.issue.priority, short: true });
  if (payload.issue.department) fields.push({ title: 'Department', value: payload.issue.department, short: true });
  if (payload.change) fields.push({ title: payload.change.field, value: `${payload.change.from || '—'} → ${payload.change.to || '—'}`, short: false });

  const slackBody = {
    attachments: [{
      color,
      fallback: `${eventLabels[payload.event]}: ${payload.issue.key} — ${payload.issue.summary}`,
      title: `${eventLabels[payload.event]}: ${payload.issue.key}`,
      title_link: payload.issue.url,
      text: payload.issue.summary,
      fields,
      footer: `Neutara · ${payload.issue.spaceName || payload.issue.spaceKey}`,
      ts: Math.floor(new Date(payload.timestamp).getTime() / 1000),
    }],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slackBody),
  });
  if (!res.ok) {
    const err = new Error(`Slack returned ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }
}

// ── Microsoft Teams ───────────────────────────────────────────────────────────

async function fireTeams(connector: ConnectorConfig, payload: IssueEventPayload): Promise<void> {
  const { webhookUrl } = connector.config;
  if (!webhookUrl) return;

  const eventEmoji: Record<ConnectorEvent, string> = {
    'issue.created': '🆕',
    'issue.updated': '✏️',
    'issue.deleted': '🗑️',
    'issue.status_changed': '🔄',
    'issue.assigned': '👤',
    'issue.commented': '💬',
    'issue.department_changed': '📤',
  };

  const facts: any[] = [];
  if (payload.issue.assignee)  facts.push({ name: 'Assignee', value: payload.issue.assignee });
  if (payload.issue.status)    facts.push({ name: 'Status', value: payload.issue.status });
  if (payload.issue.priority)  facts.push({ name: 'Priority', value: payload.issue.priority });
  if (payload.issue.department) facts.push({ name: 'Department', value: payload.issue.department });
  if (payload.change) facts.push({ name: payload.change.field, value: `${payload.change.from || '—'} → ${payload.change.to || '—'}` });

  const teamsBody = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: `${eventEmoji[payload.event]} ${payload.issue.key}: ${payload.issue.summary}`,
            weight: 'bolder',
            size: 'medium',
            wrap: true,
          },
          ...(facts.length ? [{
            type: 'FactSet',
            facts,
          }] : []),
        ],
        actions: [{
          type: 'Action.OpenUrl',
          title: 'View Ticket',
          url: payload.issue.url,
        }],
      },
    }],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(teamsBody),
  });
  if (!res.ok && res.status !== 200) {
    const err = new Error(`Teams returned ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }
}

// ── CRUD helpers ─────────────────────────────────────────────────────────────

export async function listConnectors(): Promise<ConnectorConfig[]> {
  const rows = await pool.query(`SELECT * FROM connector_configs ORDER BY created_at DESC`);
  return rows.rows;
}

export async function getConnector(id: string): Promise<ConnectorConfig | null> {
  const rows = await pool.query(`SELECT * FROM connector_configs WHERE id = $1`, [id]);
  return rows.rows[0] || null;
}

export async function createConnector(data: Omit<ConnectorConfig, 'id' | 'created_at' | 'updated_at'>): Promise<ConnectorConfig> {
  const id = crypto.randomUUID();
  const rows = await pool.query(
    `INSERT INTO connector_configs (id, name, type, config, events, space_ids, enabled)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
    [id, data.name, data.type, JSON.stringify(data.config), data.events, data.space_ids, data.enabled ?? true]
  );
  return rows.rows[0];
}

export async function updateConnector(id: string, data: Partial<ConnectorConfig>): Promise<ConnectorConfig | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (data.name !== undefined)      { fields.push(`name=$${idx++}`);       values.push(data.name); }
  if (data.config !== undefined)    { fields.push(`config=$${idx++}::jsonb`); values.push(JSON.stringify(data.config)); }
  if (data.events !== undefined)    { fields.push(`events=$${idx++}`);     values.push(data.events); }
  if (data.space_ids !== undefined) { fields.push(`space_ids=$${idx++}`);  values.push(data.space_ids); }
  if (data.enabled !== undefined)   { fields.push(`enabled=$${idx++}`);    values.push(data.enabled); }
  if (!fields.length) return getConnector(id);
  fields.push(`updated_at=NOW()`);
  values.push(id);
  const rows = await pool.query(
    `UPDATE connector_configs SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`,
    values
  );
  return rows.rows[0] || null;
}

export async function deleteConnector(id: string): Promise<void> {
  await pool.query(`DELETE FROM connector_configs WHERE id=$1`, [id]);
}

export async function getConnectorLogs(connectorId: string, limit = 20): Promise<any[]> {
  const rows = await pool.query(
    `SELECT * FROM connector_logs WHERE connector_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [connectorId, limit]
  );
  return rows.rows;
}

export { pool as connectorPool };
