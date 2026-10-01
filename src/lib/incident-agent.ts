// AI DevOps Incident Agent -- receives a fired Prometheus/Alertmanager alert,
// asks Claude to analyze it, and emails admins a structured incident report.
// Deliberately does NOT create a ticket (explicit decision) and never
// executes any command or touches infrastructure -- it only ever calls
// sendNotification with a plain HTML email it built itself.
import { pgPool } from './pg-pool';
import { sendNotification } from './notification-service';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-sonnet-5';

export type AlertmanagerAlert = {
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  fingerprint: string;
};

type IncidentAnalysis = {
  summary: string;
  severity: 'critical' | 'warning' | 'info';
  priority: string;
  possibleRootCause: string;
  impact: string;
  recommendedResolution: string;
};

async function getAdminEmails(): Promise<string[]> {
  const { rows } = await pgPool.query(
    `SELECT email FROM users WHERE role = 'admin' AND "isActive" = true`
  );
  return rows.map((r: any) => r.email).filter(Boolean);
}

// Asks Claude for a structured incident analysis. Tool calling / forced JSON
// output, per the spec -- the model can only ever return this exact shape,
// never free-form text or a request to run something.
async function analyzeAlert(alert: AlertmanagerAlert): Promise<IncidentAnalysis> {
  if (!ANTHROPIC_API_KEY) {
    // No key configured -- fail safe with a clearly-labeled fallback rather
    // than silently skipping the email or throwing and losing the alert.
    return {
      summary: `${alert.labels.alertname} fired on ${alert.labels.instance || 'unknown host'} (AI analysis unavailable: ANTHROPIC_API_KEY not configured)`,
      severity: (alert.labels.severity as any) || 'warning',
      priority: 'Needs triage',
      possibleRootCause: 'Not analyzed -- AI key missing.',
      impact: 'Unknown -- AI key missing.',
      recommendedResolution: 'Configure ANTHROPIC_API_KEY, then investigate this alert manually.',
    };
  }

  const alertContext = {
    alertname: alert.labels.alertname,
    instance: alert.labels.instance,
    severity: alert.labels.severity,
    summary: alert.annotations.summary,
    description: alert.annotations.description,
    startsAt: alert.startsAt,
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      tools: [{
        name: 'report_incident_analysis',
        description: 'Report the structured analysis of a server monitoring alert.',
        input_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'One or two sentence incident summary for a DevOps admin.' },
            severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
            priority: { type: 'string', description: 'e.g. "P1 - Urgent", "P2 - High", "P3 - Normal".' },
            possibleRootCause: { type: 'string', description: 'Best-guess root cause based only on the alert data given -- say so plainly if genuinely uncertain.' },
            impact: { type: 'string', description: 'Likely effect on users/services.' },
            recommendedResolution: { type: 'string', description: 'Concrete troubleshooting steps a human should take. Never suggest running a command automatically -- this is guidance for a human, not an instruction to execute anything.' },
          },
          required: ['summary', 'severity', 'priority', 'possibleRootCause', 'impact', 'recommendedResolution'],
        },
      }],
      tool_choice: { type: 'tool', name: 'report_incident_analysis' },
      messages: [{
        role: 'user',
        content: `Analyze this server monitoring alert and report a structured incident analysis:\n\n${JSON.stringify(alertContext, null, 2)}`,
      }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('[IncidentAgent] Claude API call failed:', res.status, errText.slice(0, 300));
    return {
      summary: `${alert.labels.alertname} fired on ${alert.labels.instance || 'unknown host'} (AI analysis failed -- see server logs)`,
      severity: (alert.labels.severity as any) || 'warning',
      priority: 'Needs triage',
      possibleRootCause: 'AI analysis call failed.',
      impact: 'Unknown -- AI analysis call failed.',
      recommendedResolution: 'Investigate this alert manually; check [IncidentAgent] logs for the AI call failure reason.',
    };
  }

  const data = await res.json();
  const toolUse = (data.content || []).find((c: any) => c.type === 'tool_use');
  return toolUse?.input as IncidentAnalysis;
}

function buildIncidentEmailHtml(alert: AlertmanagerAlert, analysis: IncidentAnalysis): string {
  const severityColor = analysis.severity === 'critical' ? '#DE350B' : analysis.severity === 'warning' ? '#FF991F' : '#0052CC';
  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:6px 12px;color:#666;font-size:13px;width:150px;vertical-align:top;white-space:nowrap">${label}</td>
      <td style="padding:6px 12px;font-size:13px;color:#333">${value || '—'}</td>
    </tr>`;
  const block = (label: string, body: string) => `
    <div style="margin:14px 24px;padding:12px 16px;background:#f0f4ff;border-left:3px solid #0052CC;border-radius:0 4px 4px 0">
      <p style="margin:0 0 4px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px">${label}</p>
      <p style="margin:0;font-size:13.5px;color:#333;white-space:pre-wrap">${body}</p>
    </div>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
    <div style="background:#0052CC;padding:16px 24px">
      <span style="color:white;font-size:18px;font-weight:bold">AI DevOps Incident Agent</span>
    </div>
    <div style="background:${severityColor};padding:10px 24px">
      <span style="color:white;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${analysis.severity} · ${alert.status}</span>
    </div>
    <div style="padding:20px 24px 8px">
      <h2 style="margin:0;font-size:18px;color:#172B4D;line-height:1.3">${alert.labels.alertname}</h2>
      <p style="margin:4px 0 0;font-size:12px;color:#888">${alert.labels.instance || 'unknown host'}</p>
    </div>
    <div style="padding:8px 24px">
      <table style="width:100%;border-collapse:collapse">
        ${row('Server', alert.labels.instance)}
        ${row('Severity', analysis.severity)}
        ${row('Priority', analysis.priority)}
        ${row('Started', alert.startsAt)}
      </table>
    </div>
    ${block('AI incident summary', analysis.summary)}
    ${block('Possible root cause', analysis.possibleRootCause)}
    ${block('Impact', analysis.impact)}
    ${block('Recommended resolution', analysis.recommendedResolution)}
    <div style="padding:12px 24px;background:#f4f5f7;border-top:1px solid #e8e8e8">
      <p style="margin:0;font-size:11px;color:#888">
        Source: AI DevOps Incident Agent -- automated analysis, no action taken automatically. Investigate and resolve manually.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// In-memory de-dup for the MVP: don't re-email for the same still-firing
// alert every time Alertmanager re-sends it (group_interval/repeat_interval
// in alertmanager.yml already reduce this, but a process restart or a
// shorter repeat_interval later shouldn't spam admins). Resets on deploy --
// acceptable for now; Phase 9 upgrades this to a real DB table so it
// survives restarts and works across multiple app instances.
const recentlyNotified = new Map<string, number>();
const RENOTIFY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h, matches alertmanager.yml's repeat_interval

export async function processAlertmanagerWebhook(payload: { alerts?: AlertmanagerAlert[] }): Promise<{ processed: number; skipped: number }> {
  let processed = 0, skipped = 0;
  for (const alert of payload.alerts || []) {
    if (alert.status !== 'firing') { skipped++; continue; }

    const lastSent = recentlyNotified.get(alert.fingerprint);
    if (lastSent && Date.now() - lastSent < RENOTIFY_COOLDOWN_MS) {
      console.log(`[IncidentAgent] Skipping duplicate alert ${alert.labels.alertname}/${alert.fingerprint} -- already notified within cooldown`);
      skipped++;
      continue;
    }

    try {
      const analysis = await analyzeAlert(alert);
      const adminEmails = await getAdminEmails();
      if (!adminEmails.length) {
        console.warn('[IncidentAgent] No admin emails found -- skipping notification');
        continue;
      }
      const html = buildIncidentEmailHtml(alert, analysis);
      const text = `${alert.labels.alertname} on ${alert.labels.instance}\n\n${analysis.summary}\n\nRoot cause: ${analysis.possibleRootCause}\nImpact: ${analysis.impact}\nRecommended resolution: ${analysis.recommendedResolution}`;
      await sendNotification(adminEmails, `[Incident] ${analysis.severity.toUpperCase()}: ${alert.labels.alertname} on ${alert.labels.instance}`, html, text);
      recentlyNotified.set(alert.fingerprint, Date.now());
      console.log(`[IncidentAgent] Sent incident email for ${alert.labels.alertname}/${alert.labels.instance} to ${adminEmails.length} admin(s)`);
      processed++;
    } catch (err: any) {
      console.error('[IncidentAgent] Failed to process alert:', alert.labels?.alertname, err?.message);
    }
  }
  return { processed, skipped };
}
