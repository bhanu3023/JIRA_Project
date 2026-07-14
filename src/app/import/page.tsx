'use client';

import { useState, useCallback } from 'react';
import {
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  ChevronRight,
  Download,
  Link2,
  RefreshCw,
  Check,
  X,
  Info,
} from 'lucide-react';
import { api } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
  issueCount?: number;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: any;
    status: { name: string };
    priority?: { name: string };
    issuetype: { name: string };
    assignee?: { displayName: string; emailAddress?: string };
    reporter?: { displayName: string; emailAddress?: string };
    created: string;
    updated: string;
    duedate?: string;
    labels?: string[];
    story_points?: number;
    customfield_10016?: number; // story points
    [key: string]: any; // allow dynamic custom fields
  };
}

interface JiraFieldDef {
  id: string;
  name: string;
  custom: boolean;
}

// Our local fields that can be mapped to Jira custom fields
const OUR_CUSTOM_FIELDS = [
  { key: 'customerName',   label: 'Customer Name'   },
  { key: 'clientName',     label: 'Client Name'     },
  { key: 'projectManager', label: 'Project Manager' },
  { key: 'productType',    label: 'Product Type'    },
  { key: 'combination',    label: 'Combination'     },
  { key: 'workType',       label: 'Work Type'       },
  { key: 'environment',    label: 'Environment'     },
  { key: 'rootCause',      label: 'Root Cause'      },
] as const;

interface ImportResult {
  projectKey: string;
  projectName: string;
  spaceKey: string;
  total: number;
  imported: number;
  skipped: number;
  errors: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapPriority(jiraPriority?: string): string {
  const p = (jiraPriority || '').toLowerCase();
  if (p.includes('highest') || p.includes('critical')) return 'Critical';
  if (p.includes('high')) return 'High';
  if (p.includes('low') || p.includes('lowest')) return 'Low';
  return 'Medium';
}

function mapStatus(jiraStatus: string): string {
  const s = jiraStatus.toLowerCase();
  if (s.includes('done') || s.includes('closed') || s.includes('resolved')) return 'Done';
  if (s.includes('progress') || s.includes('review') || s.includes('testing')) return 'In Progress';
  if (s.includes('open') || s.includes('todo') || s.includes('to do') || s.includes('backlog')) return 'To Do';
  return jiraStatus;
}

function extractText(adfOrText: any): string {
  if (!adfOrText) return '';
  if (typeof adfOrText === 'string') return adfOrText;
  // ADF (Atlassian Document Format)
  if (adfOrText.content) {
    return adfOrText.content
      .map((block: any) => {
        if (block.content) {
          return block.content.map((inline: any) => inline.text || '').join('');
        }
        return block.text || '';
      })
      .join('\n');
  }
  return '';
}

function slugify(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6) || 'IMPORT';
}

// ─── Step indicator ───────────────────────────────────────────────────────────

const steps = ['Connect', 'Select Projects', 'Import', 'Done'];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0">
      {steps.map((label, i) => (
        <div key={i} className="flex items-center">
          <div className="flex flex-col items-center">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-semibold transition-all
                ${i < current ? 'border-blue-600 bg-blue-600 text-white' : ''}
                ${i === current ? 'border-blue-600 bg-white text-blue-600' : ''}
                ${i > current ? 'border-gray-300 bg-white text-gray-400' : ''}
              `}
            >
              {i < current ? <Check size={14} /> : i + 1}
            </div>
            <span className={`mt-1 text-[10px] font-medium ${i === current ? 'text-blue-600' : 'text-gray-400'}`}>
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`mb-4 h-0.5 w-16 ${i < current ? 'bg-blue-600' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ImportPage() {
  const [step, setStep] = useState(0);

  // Credentials — persisted in localStorage so they survive page refresh
  const [jiraUrl, setJiraUrl] = useState(() => {
    try { return localStorage.getItem('jira_cred_url') || ''; } catch { return ''; }
  });
  const [email, setEmail] = useState(() => {
    try { return localStorage.getItem('jira_cred_email') || ''; } catch { return ''; }
  });
  const [apiToken, setApiToken] = useState(() => {
    try { return localStorage.getItem('jira_cred_token') || ''; } catch { return ''; }
  });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Projects
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [loadingCounts, setLoadingCounts] = useState(false);

  // Import progress
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ project: string; done: number; total: number } | null>(null);
  const [results, setResults] = useState<ImportResult[]>([]);

  // Re-sync reporter/assignee for existing issues
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number; updated: number } | null>(null);
  const [syncDone, setSyncDone] = useState(false);

  // Custom field mapping
  const [jiraFields, setJiraFields] = useState<JiraFieldDef[]>([]);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({}); // ourKey → jiraFieldId
  const [loadingFields, setLoadingFields] = useState(false);
  const [cfSyncing, setCfSyncing] = useState(false);
  const [cfProgress, setCfProgress] = useState<{ done: number; total: number; updated: number } | null>(null);
  const [cfDone, setCfDone] = useState(false);

  // Direct board sync (L1BOAR ↔ CFITS style)
  const [boardSyncJiraProject, setBoardSyncJiraProject] = useState('CFITS');
  const [boardSyncSpaceKey, setBoardSyncSpaceKey] = useState('L1BOAR');
  const [boardSyncing, setBoardSyncing] = useState(false);
  const [boardSyncResult, setBoardSyncResult] = useState<{ jiraTotal: number; localTotal: number; matched: number; updated: number; log: string[] } | null>(null);
  const [boardSyncError, setBoardSyncError] = useState('');

  // Link sync
  const [linkSyncing, setLinkSyncing] = useState(false);
  const [linkSyncResult, setLinkSyncResult] = useState<{ linked: number; skipped: number; log: string[] } | null>(null);
  const [linkSyncError, setLinkSyncError] = useState('');

  // Comment sync
  const [commentSyncing, setCommentSyncing] = useState(false);
  const [commentSyncResult, setCommentSyncResult] = useState<{ totalInserted: number; totalSkipped: number; boards: Record<string, { inserted: number; skipped: number; noMatch: number; error?: string }> } | null>(null);
  const [commentSyncError, setCommentSyncError] = useState('');
  const [commentSyncBoards, setCommentSyncBoards] = useState([
    { jiraProject: 'CFITS',  spaceKey: 'L1BOAR',    matchBy: 'title', enabled: true  },
    { jiraProject: 'L2B',    spaceKey: 'L2BOARD',   matchBy: 'key',   enabled: true  },
    { jiraProject: 'L3B',    spaceKey: 'L3BOARD',   matchBy: 'key',   enabled: true  },
    { jiraProject: 'QAB',    spaceKey: 'QABOAR',    matchBy: 'key',   enabled: true  },
    { jiraProject: 'PSM',    spaceKey: 'PSMBOARD',  matchBy: 'key',   enabled: true  },
    { jiraProject: 'CFM',    spaceKey: 'CFMBOARD',  matchBy: 'key',   enabled: true  },
    { jiraProject: 'IB',     spaceKey: 'INFRABOARD',matchBy: 'key',   enabled: true  },
    { jiraProject: 'TEST',   spaceKey: 'TESTBOARD', matchBy: 'key',   enabled: true  },
    { jiraProject: 'CB',     spaceKey: 'CBBOARD',   matchBy: 'key',   enabled: true  },
    { jiraProject: 'EB',     spaceKey: 'EBBOARD',   matchBy: 'key',   enabled: true  },
    { jiraProject: 'MB',     spaceKey: 'MBBOARD',   matchBy: 'key',   enabled: true  },
    { jiraProject: 'SOPS',   spaceKey: 'SOPSBOARD', matchBy: 'key',   enabled: true  },
  ]);

  // ── Jira proxy helper ──────────────────────────────────────────────────────
  const jiraFetch = useCallback(
    async (endpoint: string, method = 'GET', body?: any) => {
      const res = await fetch('/api/jira-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jiraUrl, email, apiToken, endpoint, method, body }),
      });
      return res.json();
    },
    [jiraUrl, email, apiToken]
  );

  // ── Step 0: Connect ────────────────────────────────────────────────────────
  const handleConnect = async () => {
    setConnecting(true);
    setConnectError('');
    try {
      const data = await jiraFetch('/myself');
      if (data.errorMessages || data.error || !data.accountId) {
        throw new Error(data.errorMessages?.[0] || data.error || 'Authentication failed');
      }
      // Load projects
      const projData = await jiraFetch('/project/search?maxResults=100');
      const projs: JiraProject[] = (projData.values || projData || []).map((p: any) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        projectTypeKey: p.projectTypeKey || 'software',
      }));
      setProjects(projs);
      // Save credentials so they auto-fill on next visit
      try {
        localStorage.setItem('jira_cred_url', jiraUrl);
        localStorage.setItem('jira_cred_email', email);
        localStorage.setItem('jira_cred_token', apiToken);
      } catch {}
      // Also persist to DB so server-side code can use them for auto-refresh
      try {
        await fetch('/api/app-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('jira_token') || ''}` },
          body: JSON.stringify({ jira_url: jiraUrl.replace(/\/$/, ''), jira_email: email, jira_token: apiToken }),
        });
      } catch {}
      setStep(1);
      // Load issue counts in background
      setLoadingCounts(true);
      const updated = await Promise.all(
        projs.map(async (p) => {
          try {
            const r = await jiraFetch(`/search?jql=project=${p.key}&maxResults=0`);
            return { ...p, issueCount: r.total ?? 0 };
          } catch {
            return p;
          }
        })
      );
      setProjects(updated);
      setLoadingCounts(false);
    } catch (err: any) {
      setConnectError(err.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  // ── Step 1: Select projects ────────────────────────────────────────────────
  const toggleProject = (key: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const selectAll = () => setSelectedProjects(new Set(projects.map((p) => p.key)));
  const clearAll = () => setSelectedProjects(new Set());

  // ── Step 2: Import ─────────────────────────────────────────────────────────
  const handleImport = async () => {
    setImporting(true);
    setStep(2);
    const importResults: ImportResult[] = [];

    for (const projectKey of Array.from(selectedProjects)) {
      const project = projects.find((p) => p.key === projectKey)!;
      const result: ImportResult = {
        projectKey,
        projectName: project.name,
        spaceKey: '',
        total: 0,
        imported: 0,
        skipped: 0,
        errors: [],
      };

      try {
        // 1. Create/find space
        const spaceKey = project.key.slice(0, 6).toUpperCase();
        result.spaceKey = spaceKey;

        try {
          await api.createSpace({
            name: project.name,
            key: spaceKey,
            description: `Imported from Jira project ${project.key}`,
            icon: '📦',
          });
        } catch {
          // Space may already exist — that's OK
        }

        // 2. Fetch all issues (paginated)
        let startAt = 0;
        const pageSize = 100;
        let allIssues: JiraIssue[] = [];

        while (true) {
          const mappedFieldIds = Object.values(fieldMapping).filter(Boolean).join(',');
          const extraFields = mappedFieldIds ? `,${mappedFieldIds}` : '';
          const data = await jiraFetch(
            `/search?jql=project=${projectKey} ORDER BY created ASC&startAt=${startAt}&maxResults=${pageSize}&fields=summary,description,status,priority,issuetype,assignee,reporter,created,updated,duedate,labels,customfield_10016${extraFields}`
          );
          const issues: JiraIssue[] = data.issues || [];
          allIssues = allIssues.concat(issues);
          if (allIssues.length >= data.total || issues.length === 0) break;
          startAt += pageSize;
        }

        result.total = allIssues.length;
        setProgress({ project: project.name, done: 0, total: allIssues.length });

        // 3. Create / update issues (upsert by jiraKey)
        for (let i = 0; i < allIssues.length; i++) {
          const ji = allIssues[i];
          setProgress({ project: project.name, done: i + 1, total: allIssues.length });
          try {
            // Extract mapped custom field values from this issue
            const customFieldPatch: Record<string, any> = {};
            for (const [ourKey, jiraFieldId] of Object.entries(fieldMapping)) {
              if (!jiraFieldId) continue;
              const raw = ji.fields[jiraFieldId];
              if (raw === undefined || raw === null) continue;
              let val: any = raw;
              if (typeof raw === 'object') {
                if (Array.isArray(raw)) {
                  val = raw.map((r: any) => (typeof r === 'object' ? (r.value || r.name || r.displayName || String(r)) : r));
                } else {
                  val = raw.value || raw.name || raw.displayName || raw.emailAddress || String(raw);
                }
              }
              if (val !== undefined && val !== null && val !== '') customFieldPatch[ourKey] = val;
            }

            await api.createIssue({
              title: ji.fields.summary,
              summary: ji.fields.summary,
              description: extractText(ji.fields.description),
              status: mapStatus(ji.fields.status.name),
              priority: mapPriority(ji.fields.priority?.name),
              type: ji.fields.issuetype?.name || 'Task',
              spaceKey,
              labels: ji.fields.labels || [],
              storyPoints: ji.fields.customfield_10016 || undefined,
              dueDate: ji.fields.duedate || undefined,
              // Pass reporter & assignee emails so the API can resolve them to user IDs
              assigneeEmail: ji.fields.assignee?.emailAddress || undefined,
              reporterEmail: ji.fields.reporter?.emailAddress || undefined,
              jiraKey: ji.key, // used for upsert — update if already exists
              ...customFieldPatch,
            });
            result.imported++;
          } catch (err: any) {
            result.skipped++;
            result.errors.push(`${ji.key}: ${err.message}`);
          }
        }
      } catch (err: any) {
        result.errors.push(`Failed: ${err.message}`);
      }

      importResults.push(result);
    }

    setResults(importResults);
    setProgress(null);
    setImporting(false);
    setStep(3);
  };

  // ── Re-sync reporter & assignee for already-imported issues ──────────────
  const handleResync = async () => {
    if (!jiraUrl || !email || !apiToken) return;
    setSyncing(true);
    setSyncDone(false);
    setSyncProgress({ done: 0, total: 0, updated: 0 });

    try {
      // 1. Fetch all issues from our DB that still have no reporter or assignee
      const dbData = await api.getIssues({ limit: '5000' });
      const dbIssues: any[] = dbData.issues || [];
      const missing = dbIssues.filter((i: any) => !i.reporter || !i.assignee);
      setSyncProgress({ done: 0, total: missing.length, updated: 0 });

      let updated = 0;
      // 2. For each, re-fetch from Jira by key and patch
      for (let i = 0; i < missing.length; i++) {
        const issue = missing[i];
        try {
          const data = await jiraFetch(`/issue/${issue.key}?fields=assignee,reporter`);
          const assigneeEmail: string | undefined = data?.fields?.assignee?.emailAddress;
          const reporterEmail: string | undefined = data?.fields?.reporter?.emailAddress;
          if (assigneeEmail || reporterEmail) {
            await api.updateIssue(issue.key, {
              ...(assigneeEmail ? { assigneeEmail } : {}),
              ...(reporterEmail ? { reporterEmail } : {}),
            });
            updated++;
          }
        } catch {
          // skip individual failures
        }
        setSyncProgress({ done: i + 1, total: missing.length, updated });
      }
    } catch (err: any) {
      console.error('Sync failed', err);
    }
    setSyncing(false);
    setSyncDone(true);
  };

  // ── Load Jira custom fields ────────────────────────────────────────────────
  const handleLoadJiraFields = async () => {
    setLoadingFields(true);
    try {
      const data: JiraFieldDef[] = await jiraFetch('/field');
      // Show all fields (custom + system), sorted: custom first then by name
      const sorted = (data || []).sort((a, b) => {
        if (a.custom && !b.custom) return -1;
        if (!a.custom && b.custom) return 1;
        return a.name.localeCompare(b.name);
      });
      setJiraFields(sorted);
      // Auto-detect common mappings by name similarity
      const autoMap: Record<string, string> = {};
      for (const ourField of OUR_CUSTOM_FIELDS) {
        const match = sorted.find(jf =>
          jf.name.toLowerCase().replace(/[\s_-]/g, '') === ourField.label.toLowerCase().replace(/[\s_-]/g, '') ||
          jf.name.toLowerCase().includes(ourField.key.toLowerCase())
        );
        if (match) autoMap[ourField.key] = match.id;
      }
      setFieldMapping(prev => ({ ...autoMap, ...prev }));
    } catch (err) {
      console.error('Failed to load Jira fields', err);
    }
    setLoadingFields(false);
  };

  // ── Sync custom field values from Jira → our DB ───────────────────────────
  const handleSyncCustomFields = async () => {
    const activeMappings = Object.entries(fieldMapping).filter(([, v]) => v);
    if (activeMappings.length === 0) return;

    setCfSyncing(true);
    setCfDone(false);
    setCfProgress({ done: 0, total: 0, updated: 0 });

    try {
      // 1. Get all issues from our DB (with jira key)
      const dbData = await api.getIssues({ limit: '5000' });
      const dbIssues: any[] = (dbData.issues || []).filter((i: any) => i.key);
      setCfProgress({ done: 0, total: dbIssues.length, updated: 0 });

      // Build the fields param for Jira search
      const jiraFieldIds = activeMappings.map(([, v]) => v);
      const fieldsParam = jiraFieldIds.join(',');

      let updated = 0;
      for (let i = 0; i < dbIssues.length; i++) {
        const issue = dbIssues[i];
        try {
          const data = await jiraFetch(`/issue/${issue.key}?fields=${fieldsParam}`);
          if (data?.fields) {
            const patch: Record<string, any> = {};
            for (const [ourKey, jiraFieldId] of activeMappings) {
              const raw = data.fields[jiraFieldId];
              if (raw === undefined || raw === null) continue;
              // Handle different field value types
              let val: any = raw;
              if (typeof raw === 'object') {
                if (Array.isArray(raw)) {
                  val = raw.map((r: any) => (typeof r === 'object' ? (r.value || r.name || r.displayName || String(r)) : r));
                } else {
                  val = raw.value || raw.name || raw.displayName || raw.emailAddress || String(raw);
                }
              }
              if (val !== undefined && val !== null && val !== '') {
                patch[ourKey] = val;
              }
            }
            if (Object.keys(patch).length > 0) {
              await api.updateIssue(issue.key, patch);
              updated++;
            }
          }
        } catch {
          // skip individual failures
        }
        setCfProgress({ done: i + 1, total: dbIssues.length, updated });
      }
    } catch (err: any) {
      console.error('Custom field sync failed', err);
    }
    setCfSyncing(false);
    setCfDone(true);
  };

  // ── Direct board sync (matches by title: Jira project → our space) ────────
  const handleBoardSync = async () => {
    if (!jiraUrl || !email || !apiToken || !boardSyncJiraProject || !boardSyncSpaceKey) return;
    setBoardSyncing(true);
    setBoardSyncResult(null);
    setBoardSyncError('');
    try {
      const res = await fetch('/api/admin/jira-field-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: 'cf-admin-sync-2024',
          jiraUrl,
          email,
          apiToken,
          jiraProject: boardSyncJiraProject,
          spaceKey: boardSyncSpaceKey,
          onlyMissing: false,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setBoardSyncError(data.error || 'Sync failed');
      } else {
        setBoardSyncResult({ ...data, jiraTotal: data.jiraWithFields ?? 0, matched: data.updated });
      }
    } catch (err: any) {
      setBoardSyncError(err.message || 'Sync failed');
    }
    setBoardSyncing(false);
  };

  // ── Link sync (Jira linked issues → our issue links) ──────────────────────
  const handleLinkSync = async () => {
    if (!jiraUrl || !email || !apiToken || !boardSyncJiraProject || !boardSyncSpaceKey) return;
    setLinkSyncing(true);
    setLinkSyncResult(null);
    setLinkSyncError('');
    try {
      const res = await fetch('/api/admin/jira-link-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: 'cf-admin-sync-2024',
          jiraUrl,
          email,
          apiToken,
          jiraProject: boardSyncJiraProject,
          spaceKey: boardSyncSpaceKey,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setLinkSyncError(data.error || 'Sync failed');
      } else {
        setLinkSyncResult(data);
      }
    } catch (err: any) {
      setLinkSyncError(err.message || 'Sync failed');
    }
    setLinkSyncing(false);
  };

  // ── Comment sync ──────────────────────────────────────────────────────────
  const handleCommentSync = async () => {
    if (!jiraUrl || !email || !apiToken) return;
    setCommentSyncing(true);
    setCommentSyncResult(null);
    setCommentSyncError('');
    try {
      const enabledBoards = commentSyncBoards.filter(b => b.enabled).map(({ jiraProject, spaceKey, matchBy }) => ({ jiraProject, spaceKey, matchBy }));
      const res = await fetch('/api/admin/jira-comment-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'cf-admin-sync-2024', jiraUrl, email, apiToken, boards: enabledBoards }),
      });
      const data = await res.json();
      if (!data.ok) setCommentSyncError(data.error || 'Sync failed');
      else setCommentSyncResult(data);
    } catch (err: any) {
      setCommentSyncError(err.message || 'Sync failed');
    }
    setCommentSyncing(false);
  };

  // ── Renders ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="border-b bg-white px-8 py-4">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <span>Settings</span>
          <ChevronRight size={14} />
          <span className="font-medium text-gray-900">Import from Jira</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">Import from Jira</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Connect to your Jira instance and copy tickets into this application.
        </p>
      </div>

      <div className="mx-auto max-w-3xl px-8 py-8">
        {/* Step indicator */}
        <div className="mb-8 flex justify-center">
          <StepIndicator current={step} />
        </div>

        {/* ── Step 0: Connect ── */}
        {step === 0 && (
          <div className="rounded-xl border bg-white p-8 shadow-sm">
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100">
                <Link2 size={20} className="text-blue-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Connect to Jira</h2>
                <p className="text-sm text-gray-500">Enter your Jira credentials to get started</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Jira URL
                </label>
                <input
                  type="url"
                  placeholder="https://yourcompany.atlassian.net"
                  value={jiraUrl}
                  onChange={(e) => setJiraUrl(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Email Address
                </label>
                <input
                  type="email"
                  placeholder="you@yourcompany.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  API Token
                </label>
                <input
                  type="password"
                  placeholder="Your Jira API token"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="mt-1 text-xs text-gray-400">
                  Generate an API token from{' '}
                  <a
                    href="https://id.atlassian.com/manage-profile/security/api-tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:underline"
                  >
                    Atlassian Account Settings
                  </a>
                </p>
              </div>

              {connectError && (
                <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  {connectError}
                </div>
              )}

              <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-700">
                <div className="flex items-start gap-2">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Your credentials are used only to fetch data from Jira. They are not stored anywhere.
                  </span>
                </div>
              </div>

              <button
                onClick={handleConnect}
                disabled={connecting || !jiraUrl || !email || !apiToken}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {connecting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Connecting…
                  </>
                ) : (
                  <>
                    <Link2 size={16} />
                    Connect to Jira
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 1: Select Projects ── */}
        {step === 1 && (
          <div className="rounded-xl border bg-white shadow-sm">
            <div className="border-b px-6 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Select Projects to Import</h2>
                  <p className="text-sm text-gray-500">
                    {projects.length} projects found · {selectedProjects.size} selected
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={selectAll}
                    className="rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Select All
                  </button>
                  <button
                    onClick={clearAll}
                    className="rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>

            <div className="divide-y max-h-[480px] overflow-y-auto">
              {projects.map((p) => (
                <label
                  key={p.key}
                  className="flex cursor-pointer items-center gap-4 px-6 py-3.5 hover:bg-gray-50"
                >
                  <div
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors
                      ${selectedProjects.has(p.key) ? 'border-blue-600 bg-blue-600' : 'border-gray-300'}`}
                    onClick={() => toggleProject(p.key)}
                  >
                    {selectedProjects.has(p.key) && <Check size={12} className="text-white" />}
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-blue-600 text-xs font-bold text-white">
                      {p.key.slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-gray-900">{p.name}</div>
                      <div className="text-xs text-gray-400">{p.key} · {p.projectTypeKey}</div>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    {loadingCounts ? (
                      <Loader2 size={12} className="animate-spin text-gray-400" />
                    ) : (
                      <span className="text-xs font-medium text-gray-500">
                        {p.issueCount !== undefined ? `${p.issueCount} issues` : ''}
                      </span>
                    )}
                  </div>
                </label>
              ))}
            </div>

            <div className="border-t px-6 py-4">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setStep(0)}
                  className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  Back
                </button>
                <button
                  onClick={handleImport}
                  disabled={selectedProjects.size === 0}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Download size={15} />
                  Import {selectedProjects.size} Project{selectedProjects.size !== 1 ? 's' : ''}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Importing ── */}
        {step === 2 && (
          <div className="rounded-xl border bg-white p-8 shadow-sm text-center">
            <div className="mb-4 flex justify-center">
              <Loader2 size={48} className="animate-spin text-blue-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900">Importing tickets…</h2>
            {progress && (
              <div className="mt-4">
                <p className="text-sm text-gray-600">
                  {progress.project}: {progress.done} / {progress.total} tickets
                </p>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-200">
                  <div
                    className="h-2 rounded-full bg-blue-600 transition-all"
                    style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )}
            <p className="mt-4 text-xs text-gray-400">Please wait, do not close this page</p>
          </div>
        )}

        {/* ── Step 3: Done ── */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-3">
                <CheckCircle2 size={28} className="text-green-500" />
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Import Complete!</h2>
                  <p className="text-sm text-gray-500">
                    {results.reduce((a, r) => a + r.imported, 0)} tickets imported across{' '}
                    {results.length} space{results.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              {/* Summary table */}
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Project
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Space Key
                      </th>
                      <th className="px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Total
                      </th>
                      <th className="px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Imported
                      </th>
                      <th className="px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Skipped
                      </th>
                      <th className="px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {results.map((r) => (
                      <tr key={r.projectKey} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{r.projectName}</div>
                          <div className="text-xs text-gray-400">{r.projectKey}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-mono font-medium text-gray-700">
                            {r.spaceKey}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center text-gray-600">{r.total}</td>
                        <td className="px-4 py-3 text-center font-medium text-green-600">{r.imported}</td>
                        <td className="px-4 py-3 text-center text-gray-400">{r.skipped}</td>
                        <td className="px-4 py-3 text-center">
                          {r.errors.length === 0 ? (
                            <span className="flex items-center justify-center gap-1 text-green-600">
                              <CheckCircle2 size={14} />
                              <span className="text-xs">Success</span>
                            </span>
                          ) : (
                            <span className="flex items-center justify-center gap-1 text-amber-600">
                              <AlertCircle size={14} />
                              <span className="text-xs">{r.errors.length} errors</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Errors */}
              {results.some((r) => r.errors.length > 0) && (
                <div className="mt-4 rounded-lg bg-amber-50 p-3">
                  <p className="mb-2 text-xs font-semibold text-amber-800">Errors (skipped tickets):</p>
                  {results.flatMap((r) => r.errors).map((e, i) => (
                    <p key={i} className="text-xs text-amber-700">• {e}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <a
                href="/dashboard"
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go to Dashboard
              </a>
              <button
                onClick={() => {
                  setStep(0);
                  setResults([]);
                  setSelectedProjects(new Set());
                  setProjects([]);
                  setJiraUrl('');
                  setEmail('');
                  setApiToken('');
                }}
                className="flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                <RefreshCw size={14} />
                Import More
              </button>
            </div>
          </div>
        )}
        {/* ── Custom Field Mapping & Sync card ── */}
        {(step >= 1 || jiraUrl) && (
          <div className="mt-6 rounded-xl border border-purple-100 bg-purple-50 p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-purple-600">
                <RefreshCw size={18} className="text-white" />
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-gray-900">Sync Custom Fields from Jira</h2>
                <p className="mt-0.5 text-sm text-gray-600">
                  Map Jira custom fields (Customer Name, Client Name, Project Manager, etc.) to our fields,
                  then sync values into all existing tickets.
                </p>

                {/* Load fields button */}
                {jiraFields.length === 0 ? (
                  <button
                    onClick={handleLoadJiraFields}
                    disabled={loadingFields || !jiraUrl || !email || !apiToken}
                    className="mt-3 flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {loadingFields ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {loadingFields ? 'Loading Jira Fields…' : 'Load Jira Fields'}
                  </button>
                ) : (
                  <>
                    {/* Mapping grid */}
                    <div className="mt-3 rounded-lg border border-purple-200 bg-white divide-y divide-gray-100">
                      {OUR_CUSTOM_FIELDS.map(({ key, label }) => (
                        <div key={key} className="flex items-center gap-3 px-3 py-2">
                          <span className="w-36 text-[12.5px] font-medium text-gray-700 flex-shrink-0">{label}</span>
                          <select
                            value={fieldMapping[key] || ''}
                            onChange={e => setFieldMapping(prev => ({ ...prev, [key]: e.target.value }))}
                            className="flex-1 text-[12px] border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white"
                          >
                            <option value="">— not mapped —</option>
                            {jiraFields.map(f => (
                              <option key={f.id} value={f.id}>{f.name} ({f.id})</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>

                    {/* Progress */}
                    {cfSyncing && cfProgress && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                          <span>Syncing tickets… {cfProgress.done}/{cfProgress.total}</span>
                          <span className="font-semibold text-purple-600">{cfProgress.updated} updated</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-purple-100">
                          <div className="h-2 rounded-full bg-purple-600 transition-all"
                            style={{ width: `${cfProgress.total > 0 ? (cfProgress.done / cfProgress.total) * 100 : 0}%` }} />
                        </div>
                      </div>
                    )}

                    {cfDone && cfProgress && (
                      <div className="mt-3 flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2">
                        <CheckCircle2 size={15} className="text-green-600 flex-shrink-0" />
                        <span className="text-sm text-green-800 font-medium">
                          Done! Updated {cfProgress.updated} of {cfProgress.total} tickets with custom field data.
                        </span>
                      </div>
                    )}

                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={handleSyncCustomFields}
                        disabled={cfSyncing || Object.values(fieldMapping).every(v => !v)}
                        className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {cfSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        {cfSyncing ? 'Syncing…' : 'Sync Custom Fields'}
                      </button>
                      <button
                        onClick={() => setJiraFields([])}
                        className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg hover:bg-purple-100 transition-colors"
                      >
                        Reset
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Board ↔ Jira Direct Sync card ── */}
        {(step >= 1 || jiraUrl) && (
          <div className="mt-6 rounded-xl border border-green-100 bg-green-50 p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-green-600">
                <RefreshCw size={18} className="text-white" />
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-gray-900">Sync Board Fields from Jira Project</h2>
                <p className="mt-0.5 text-sm text-gray-600">
                  Match tickets by title between a Jira project and our board, then fill in
                  <strong> Customer Name, Client Name, Project Manager, Product Type, Combination</strong> automatically.
                </p>

                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Jira Project Key</label>
                    <input value={boardSyncJiraProject} onChange={e => setBoardSyncJiraProject(e.target.value.toUpperCase())}
                      placeholder="CFITS"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-green-400 bg-white" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Our Board Space Key</label>
                    <input value={boardSyncSpaceKey} onChange={e => setBoardSyncSpaceKey(e.target.value.toUpperCase())}
                      placeholder="L1BOAR"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-green-400 bg-white" />
                  </div>
                </div>

                {boardSyncError && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                    <AlertCircle size={14} className="text-red-600 flex-shrink-0" />
                    <span className="text-sm text-red-700">{boardSyncError}</span>
                  </div>
                )}

                {boardSyncing && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
                    <Loader2 size={14} className="animate-spin text-green-600" />
                    Fetching Jira issues and matching with local tickets…
                  </div>
                )}

                {boardSyncResult && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2">
                      <CheckCircle2 size={15} className="text-green-600 flex-shrink-0" />
                      <span className="text-sm text-green-800 font-medium">
                        Done! Fetched {boardSyncResult.jiraTotal} Jira issues, matched {boardSyncResult.matched}, updated <strong>{boardSyncResult.updated}</strong> local tickets.
                      </span>
                    </div>
                    {boardSyncResult.log.length > 0 && (
                      <div className="max-h-40 overflow-y-auto rounded border border-gray-200 bg-white p-2 text-[11px] font-mono text-gray-600 space-y-0.5">
                        {boardSyncResult.log.map((l, i) => <div key={i}>{l}</div>)}
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={handleBoardSync}
                    disabled={boardSyncing || !jiraUrl || !email || !apiToken || !boardSyncJiraProject || !boardSyncSpaceKey}
                    className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {boardSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {boardSyncing ? 'Syncing Fields…' : 'Sync Fields'}
                  </button>
                  <button
                    onClick={handleLinkSync}
                    disabled={linkSyncing || !jiraUrl || !email || !apiToken || !boardSyncJiraProject || !boardSyncSpaceKey}
                    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {linkSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {linkSyncing ? 'Syncing Links…' : 'Sync Linked Issues'}
                  </button>
                </div>

                {linkSyncError && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                    <span className="text-sm text-red-700">{linkSyncError}</span>
                  </div>
                )}
                {linkSyncing && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
                    <Loader2 size={14} className="animate-spin text-indigo-600" />
                    Fetching linked issues from Jira and creating links…
                  </div>
                )}
                {linkSyncResult && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2 rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-2">
                      <span className="text-sm text-indigo-800 font-medium">
                        Links synced! Created <strong>{linkSyncResult.linked}</strong> links ({linkSyncResult.skipped} skipped — target not in local DB).
                      </span>
                    </div>
                    {linkSyncResult.log.length > 0 && (
                      <div className="max-h-40 overflow-y-auto rounded border border-gray-200 bg-white p-2 text-[11px] font-mono text-gray-600 space-y-0.5">
                        {linkSyncResult.log.map((l, i) => <div key={i}>{l}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Comment Sync card ── */}
        {(step >= 1 || jiraUrl) && (
          <div className="mt-6 rounded-xl border border-purple-100 bg-purple-50 p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-purple-600">
                <RefreshCw size={18} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-purple-900">Sync Comments from Jira</h3>
                <p className="mt-1 text-sm text-purple-700">Pulls all Jira comments into your local tickets. Uses the credentials entered above.</p>

                {/* Board toggles */}
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {commentSyncBoards.map((b, idx) => (
                    <label key={b.spaceKey} className="flex items-center gap-2 text-xs text-purple-800 cursor-pointer select-none">
                      <input type="checkbox" checked={b.enabled}
                        onChange={e => setCommentSyncBoards(prev => prev.map((x, i) => i === idx ? { ...x, enabled: e.target.checked } : x))}
                        className="rounded border-purple-300 text-purple-600 focus:ring-purple-400" />
                      <span className="font-medium">{b.spaceKey}</span>
                      <span className="text-purple-400">({b.jiraProject})</span>
                    </label>
                  ))}
                </div>

                {commentSyncError && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                    <AlertCircle size={14} className="text-red-600 flex-shrink-0" />
                    <span className="text-sm text-red-700">{commentSyncError}</span>
                  </div>
                )}
                {commentSyncing && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-purple-700">
                    <Loader2 size={14} className="animate-spin text-purple-600" />
                    Syncing comments from Jira — this may take a few minutes…
                  </div>
                )}
                {commentSyncResult && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2 rounded-lg bg-purple-100 border border-purple-200 px-3 py-2">
                      <CheckCircle2 size={15} className="text-purple-700 flex-shrink-0" />
                      <span className="text-sm text-purple-900 font-medium">
                        Done! Inserted <strong>{commentSyncResult.totalInserted}</strong> comments ({commentSyncResult.totalSkipped} already existed).
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                      {Object.entries(commentSyncResult.boards).map(([space, r]) => (
                        <div key={space} className={`rounded-lg border px-2.5 py-1.5 text-xs ${r.error ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white border-gray-200 text-gray-700'}`}>
                          <span className="font-bold">{space}</span>
                          {r.error ? <span className="ml-1 text-red-600">Error</span> : (
                            <span className="ml-1">+{r.inserted} ({r.skipped} skip, {r.noMatch} no match)</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={handleCommentSync}
                  disabled={commentSyncing || !jiraUrl || !email || !apiToken || commentSyncBoards.every(b => !b.enabled)}
                  className="mt-3 flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {commentSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {commentSyncing ? 'Syncing Comments…' : 'Sync Comments from Jira'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Re-sync Reporter & Assignee card — shown once credentials exist ── */}
        {(step >= 1 || jiraUrl) && (
          <div className="mt-6 rounded-xl border border-blue-100 bg-blue-50 p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-blue-600">
                <RefreshCw size={18} className="text-white" />
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-gray-900">Re-sync Reporter &amp; Assignee</h2>
                <p className="mt-0.5 text-sm text-gray-600">
                  Already imported tickets that are missing reporter or assignee? Click below to fetch that data
                  from Jira and update all existing tickets automatically.
                </p>

                {syncing && syncProgress && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                      <span>Updating tickets… {syncProgress.done}/{syncProgress.total}</span>
                      <span className="font-semibold text-blue-600">{syncProgress.updated} updated</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-blue-100">
                      <div className="h-2 rounded-full bg-blue-600 transition-all"
                        style={{ width: `${syncProgress.total > 0 ? (syncProgress.done / syncProgress.total) * 100 : 0}%` }} />
                    </div>
                  </div>
                )}

                {syncDone && syncProgress && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2">
                    <CheckCircle2 size={15} className="text-green-600 flex-shrink-0" />
                    <span className="text-sm text-green-800 font-medium">
                      Done! Updated {syncProgress.updated} of {syncProgress.total} tickets with reporter &amp; assignee data.
                    </span>
                  </div>
                )}

                <button
                  onClick={handleResync}
                  disabled={syncing || !jiraUrl || !email || !apiToken}
                  className="mt-3 flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {syncing ? 'Syncing…' : 'Start Re-sync'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
