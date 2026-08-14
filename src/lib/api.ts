/** Same-origin `/api` uses the embedded dev mock unless you point at a real server (e.g. NEXT_PUBLIC_API_URL=http://localhost:4000/api). */
const API_URL = (process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/$/, '');

class ApiClient {
  private getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('jira_token');
  }

  // Coalesce identical concurrent GET requests into one network call. The sidebar
  // and the page it's rendered alongside each independently fetch the same
  // custom-queues/rr-config data for the same space on every load — this cuts
  // that duplication (and any other accidental double-fetch) without needing to
  // restructure which component owns the data.
  private inFlightGets = new Map<string, Promise<any>>();

  // The in-flight map above only catches callers that overlap WHILE the first
  // request is still pending. Every actual duplicate-fetch bug found in this
  // app (sidebar + page each independently fetching custom-fields, custom-
  // queues/:key, rr-config, or the plain spaces list on the same page load)
  // was two callers just far enough apart in time to miss that window — not
  // simultaneous, just both firing on mount a few effects apart. Rather than
  // hunting down and merging each new instance of that pattern as it's found,
  // keep the resolved value around briefly for exactly this class of endpoint:
  // static/config data that doesn't need to reflect a mutation a moment ago.
  // Deliberately NOT applied to issues/notifications/anything else that does.
  private static STATIC_GET_PATTERNS = [/^custom-fields$/, /^custom-queues\//, /\/rr-config$/, /^spaces$/];
  private static STATIC_CACHE_MS = 5000;

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    if (method === 'GET') {
      // Normalize so callers using "spaces/x" vs "/spaces/x" still coalesce —
      // they resolve to the same URL below but would otherwise miss each other.
      const dedupKey = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
      const existing = this.inFlightGets.get(dedupKey);
      if (existing) return existing as Promise<T>;
      const isStatic = ApiClient.STATIC_GET_PATTERNS.some((re) => re.test(dedupKey));
      const promise = this.requestUncoalesced<T>(endpoint, options);
      promise.then(
        () => {
          if (isStatic) setTimeout(() => this.inFlightGets.delete(dedupKey), ApiClient.STATIC_CACHE_MS);
          else this.inFlightGets.delete(dedupKey);
        },
        () => { this.inFlightGets.delete(dedupKey); }, // always drop on failure so a retry can go straight to the network
      );
      this.inFlightGets.set(dedupKey, promise);
      return promise;
    }
    return this.requestUncoalesced<T>(endpoint, options);
  }

  private async requestUncoalesced<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    const skipAuthHeader =
      method === 'POST' && (endpoint === '/auth/login' || endpoint === '/auth/register');
    const tokenUsed = skipAuthHeader ? null : this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };
    if (tokenUsed) headers['Authorization'] = `Bearer ${tokenUsed}`;

    // Remove content-type for FormData
    if (options.body instanceof FormData) {
      delete headers['Content-Type'];
    }

    let res: Response;
    try {
      const url = endpoint.startsWith('/') ? `${API_URL}${endpoint}` : `${API_URL}/${endpoint}`;
      res = await fetch(url, {
        ...options,
        headers,
      });
    } catch {
      const target = endpoint.startsWith('/') ? `${API_URL}${endpoint}` : `${API_URL}/${endpoint}`;
      const hint =
        API_URL.includes('localhost:4000') || API_URL.includes('127.0.0.1:4000')
          ? ' Start the Jira API on port 4000, or unset NEXT_PUBLIC_API_URL to use the embedded /api mock from this Next app.'
          : '';
      throw new Error(`Cannot reach API (${target}).${hint}`);
    }

    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }

    if (res.status === 401) {
      const isLoginOrRegister =
        method === 'POST' && (endpoint === '/auth/login' || endpoint === '/auth/register');
      const errMsg = typeof data.error === 'string' ? data.error : 'Unauthorized';
      if (!isLoginOrRegister && typeof window !== 'undefined') {
        const current = this.getToken();
        if (current === null || current === tokenUsed) {
          localStorage.removeItem('jira_token');
          window.location.href = '/auth/login';
        }
      }
      throw new Error(errMsg);
    }

    if (res.status === 413) {
      throw new Error('That request is too large — the description or an attached image/file is too big. Try a smaller image or remove an attachment and try again.');
    }

    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Request failed');
    return data as T;
  }

  // Auth
  login(email: string, password: string) {
    return this.request<{ token: string; user: any }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
  }

  register(data: { email: string; password: string; firstName: string; lastName: string; organizationName: string }) {
    return this.request<{ token: string; user: any }>('/auth/register', {
      method: 'POST', body: JSON.stringify(data),
    });
  }

  getMe() {
    return this.request<any>('/auth/me');
  }

  getMyDashboard(params?: { from?: string; to?: string; userId?: string }) {
    const qs = params ? new URLSearchParams(params as Record<string, string>).toString() : '';
    return this.request<any>(`/my-dashboard${qs ? `?${qs}` : ''}`);
  }

  // Users
  getUsers() { return this.request<any[]>('/users'); }
  createUser(data: any) { return this.request<any>('/users', { method: 'POST', body: JSON.stringify(data) }); }
  updateUser(id: string, data: any) { return this.request<any>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteUser(id: string) { return this.request<any>(`/users/${id}`, { method: 'DELETE' }); }

  // Spaces
  getSpaces() { return this.request<any[]>('/spaces'); }
  getSpace(key: string) { return this.request<any>(`/spaces/${key}`); }
  createSpace(data: any) { return this.request<any>('/spaces', { method: 'POST', body: JSON.stringify(data) }); }
  updateSpace(key: string, data: any) { return this.request<any>(`/spaces/${key}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteSpace(key: string) { return this.request<any>(`/spaces/${key}`, { method: 'DELETE' }); }
  addSpaceMember(key: string, data: any) { return this.request<any>(`/spaces/${key}/members`, { method: 'POST', body: JSON.stringify(data) }); }

  // Issues
  getIssues(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request<{ issues: any[]; total: number; page: number; totalPages: number }>(`/issues?${qs}`);
  }
  getIssue(key: string) { return this.request<any>(`/issues/${key}`); }
  createIssue(data: any) { return this.request<any>('/issues', { method: 'POST', body: JSON.stringify(data) }); }
  updateIssue(key: string, data: any) { return this.request<any>(`/issues/${key}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteIssue(key: string) { return this.request<any>(`/issues/${key}`, { method: 'DELETE' }); }
  addComment(key: string, data: any) { return this.request<any>(`/issues/${key}/comments`, { method: 'POST', body: JSON.stringify(data) }); }
  updateComment(commentId: string, data: { body: string }) { return this.request<any>(`/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteComment(commentId: string) { return this.request<any>(`/comments/${commentId}`, { method: 'DELETE' }); }
  addLink(key: string, data: any) { return this.request<any>(`/issues/${key}/links`, { method: 'POST', body: JSON.stringify(data) }); }
  addIssueLink(key: string, data: { targetKey: string; linkType: string }) { return this.addLink(key, data); }
  deleteIssueLink(linkId: string) { return this.request<any>(`/issues/links/${linkId}`, { method: 'DELETE' }); }

  uploadAttachment(key: string, file: File, displayName?: string) {
    const formData = new FormData();
    formData.append('file', file, displayName || file.name);
    return this.request<any>(`/issues/${key}/attachments`, { method: 'POST', body: formData });
  }

  // Sprints
  getSprints(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request<any[]>(`/sprints?${qs}`);
  }
  createSprint(data: any) { return this.request<any>('/sprints', { method: 'POST', body: JSON.stringify(data) }); }
  updateSprint(id: string, data: any) { return this.request<any>(`/sprints/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  completeSprint(id: string, data: any) { return this.request<any>(`/sprints/${id}/complete`, { method: 'POST', body: JSON.stringify(data) }); }

  // Workflows
  getWorkflows(spaceKey: string) { return this.request<any[]>(`/workflows?spaceKey=${spaceKey}`); }
  getWorkflowStatuses(workflowId: string) { return this.request<any>(`/workflows/${workflowId}/statuses`); }
  addWorkflowStatus(workflowId: string, data: any) { return this.request<any>(`/workflows/${workflowId}/statuses`, { method: 'POST', body: JSON.stringify(data) }); }
  reorderStatuses(workflowId: string, statusIds: string[]) { return this.request<any>(`/workflows/${workflowId}/statuses/reorder`, { method: 'PUT', body: JSON.stringify({ statusIds }) }); }
  updateWorkflowStatus(workflowId: string, statusId: string, data: any) { return this.request<any>(`/workflows/${workflowId}/statuses/${statusId}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteWorkflowStatus(workflowId: string, statusId: string) { return this.request<any>(`/workflows/${workflowId}/statuses/${statusId}`, { method: 'DELETE' }); }
  deleteTransition(workflowId: string, transitionId: string) { return this.request<any>(`/workflows/${workflowId}/transitions/${transitionId}`, { method: 'DELETE' }); }
  createDefaultTransitions(workflowId: string) { return this.request<any>(`/workflows/${workflowId}/transitions/defaults`, { method: 'POST' }); }
  addTransition(workflowId: string, data: any) { return this.request<any>(`/workflows/${workflowId}/transitions`, { method: 'POST', body: JSON.stringify(data) }); }

  // Automation
  getAutomationRules(spaceKey: string) { return this.request<any[]>(`/automation?spaceKey=${spaceKey}`); }
  createAutomationRule(data: any) { return this.request<any>('/automation', { method: 'POST', body: JSON.stringify(data) }); }
  updateAutomationRule(id: string, data: any) { return this.request<any>(`/automation/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteAutomationRule(id: string) { return this.request<any>(`/automation/${id}`, { method: 'DELETE' }); }
  saveFlowRule(spaceKey: string, rule: any) { return this.request<any>(`/automation/flow/${spaceKey}`, { method: 'PUT', body: JSON.stringify(rule) }); }
  getFlowRules(spaceKey: string) { return this.request<any[]>(`/automation?spaceKey=${spaceKey}`); }

  // Labels
  getLabels(spaceKey: string) { return this.request<any[]>(`/labels?spaceKey=${spaceKey}`); }
  createLabel(data: any) { return this.request<any>('/labels', { method: 'POST', body: JSON.stringify(data) }); }

  // Notifications
  getNotifications(unreadOnly = false) {
    return this.request<{ notifications: any[]; unreadCount: number }>(`/notifications?unreadOnly=${unreadOnly}`);
  }
  markRead(id: string) { return this.request<any>(`/notifications/${id}/read`, { method: 'PATCH' }); }
  markAllRead() { return this.request<any>('/notifications/read-all', { method: 'POST' }); }

  // Watch
  getWatch(issueKey: string) { return this.request<{ watching: boolean; count: number }>(`/issues/${issueKey}/watch`); }
  watchIssue(issueKey: string) { return this.request<any>(`/issues/${issueKey}/watch`, { method: 'POST' }); }
  unwatchIssue(issueKey: string) { return this.request<any>(`/issues/${issueKey}/watch`, { method: 'DELETE' }); }

  // Notification preferences
  getNotifPrefs() { return this.request<any>('/notification-preferences'); }
  updateNotifPrefs(data: any) { return this.request<any>('/notification-preferences', { method: 'PATCH', body: JSON.stringify(data) }); }

  // Due date check
  triggerDueDateCheck() { return this.request<any>('/due-date-check', { method: 'POST' }); }
  triggerSlaBreachCheck() { return this.request<any>('/sla-breach-check', { method: 'POST' }); }
  triggerMonitorAgent() { return this.request<any>('/monitor-agent', { method: 'POST' }); }

  // Reports
  getDashboard(spaceKey?: string) {
    const qs = spaceKey ? `?spaceKey=${spaceKey}` : '';
    return this.request<any>(`/reports/dashboard${qs}`);
  }
  getBurndown(spaceKey: string, dateFrom?: string, dateTo?: string) {
    const p = new URLSearchParams({ spaceKey });
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo)   p.set('dateTo',   dateTo);
    return this.request<any>(`/reports/burndown?${p}`);
  }
  getVelocity(spaceKey: string, dateFrom?: string, dateTo?: string) {
    const p = new URLSearchParams({ spaceKey });
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo)   p.set('dateTo',   dateTo);
    return this.request<any[]>(`/reports/velocity?${p}`);
  }
  getUserPerformance(spaceKey?: string, dateFrom?: string, dateTo?: string) {
    const params = new URLSearchParams();
    if (spaceKey)  params.set('spaceKey',  spaceKey);
    if (dateFrom)  params.set('dateFrom',  dateFrom);
    if (dateTo)    params.set('dateTo',    dateTo);
    const qs = params.toString();
    return this.request<any[]>(`/reports/user-performance${qs ? `?${qs}` : ''}`);
  }
  getResolutionSla(params?: { dept?: string; productType?: string; dateFrom?: string; dateTo?: string }) {
    const p = new URLSearchParams();
    if (params?.dept)        p.set('dept',        params.dept);
    if (params?.productType) p.set('productType', params.productType);
    if (params?.dateFrom)    p.set('dateFrom',     params.dateFrom);
    if (params?.dateTo)      p.set('dateTo',       params.dateTo);
    const qs = p.toString();
    return this.request<any>(`/reports/resolution-sla${qs ? `?${qs}` : ''}`);
  }
  getTeamAnalytics(sub: 'overview' | 'aging', params?: { dept?: string; dateType?: string; dateFrom?: string; dateTo?: string; productType?: string }) {
    const p = new URLSearchParams();
    if (params?.dept)        p.set('dept',        params.dept);
    if (params?.dateType)    p.set('dateType',    params.dateType);
    if (params?.dateFrom)    p.set('dateFrom',     params.dateFrom);
    if (params?.dateTo)      p.set('dateTo',       params.dateTo);
    if (params?.productType) p.set('productType', params.productType);
    const qs = p.toString();
    return this.request<any>(`/reports/team-analytics/${sub}${qs ? `?${qs}` : ''}`);
  }

  // Custom Fields
  getCustomFields() { return this.request<any[]>('/custom-fields'); }
  createCustomField(data: any) { return this.request<any>('/custom-fields', { method: 'POST', body: JSON.stringify(data) }); }
  updateCustomField(id: string, data: any) { return this.request<any>(`/custom-fields/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteCustomField(id: string) { return this.request<any>(`/custom-fields/${id}`, { method: 'DELETE' }); }
  updateCustomFieldSpaces(id: string, spaceIds: string[], createIssueSpaceIds?: string[]) {
    return this.request<any>(`/custom-fields/${id}/spaces`, { method: 'PUT', body: JSON.stringify({ spaceIds, createIssueSpaceIds }) });
  }
  getCustomFieldValues(issueId: string) { return this.request<any[]>(`/custom-fields/issue/${issueId}/values`); }
  setCustomFieldValue(issueId: string, fieldId: string, value: string) {
    return this.request<any>(`/custom-fields/issue/${issueId}/values/${fieldId}`, { method: 'PUT', body: JSON.stringify({ value }) });
  }

  // SLA Definitions
  getSLAs(spaceKey: string, dept?: string) {
    const qs = dept ? `?dept=${encodeURIComponent(dept)}` : '';
    return this.request<any[]>(`/sla/${spaceKey}${qs}`);
  }
  createSLA(spaceKey: string, data: any) { return this.request<any>(`/sla/${spaceKey}`, { method: 'POST', body: JSON.stringify(data) }); }
  updateSLA(spaceKey: string, id: string, data: any) { return this.request<any>(`/sla/${spaceKey}/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteSLA(spaceKey: string, id: string) { return this.request<any>(`/sla/${spaceKey}/${id}`, { method: 'DELETE' }); }

  getRrConfig(spaceKey: string) { return this.request<any>(`/spaces/${spaceKey}/rr-config`); }
  saveRrConfig(spaceKey: string, departments: any[]) { return this.request<any>(`/spaces/${spaceKey}/rr-config`, { method: 'POST', body: JSON.stringify({ departments }) }); }

  // ── Email system ─────────────────────────────────────────────────
  // Registered email addresses for a space
  getEmailAddresses(spaceKey: string) { return this.request<any[]>(`/email-addresses/${spaceKey}`); }
  addEmailAddress(spaceKey: string, data: { address: string; requestType?: string; isReplyTo?: boolean; autoReply?: boolean; autoReplyText?: string }) {
    return this.request<any>(`/email-addresses/${spaceKey}`, { method: 'POST', body: JSON.stringify(data) });
  }
  removeEmailAddress(spaceKey: string, id: string) { return this.request<any>(`/email-addresses/${spaceKey}/${id}`, { method: 'DELETE' }); }
  updateEmailAddress(spaceKey: string, id: string, data: any) { return this.request<any>(`/email-addresses/${spaceKey}/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }

  // Email logs
  getEmailLogs(spaceKey: string) { return this.request<any[]>(`/email-logs/${spaceKey}`); }

  // THE main webhook — this is what mail services (SendGrid/Mailgun/SES) call
  // In production: configure your mail service to POST to https://yourapp.com/api/email/receive
  receiveEmail(data: { from: string; to: string; subject: string; body?: string; attachments?: any[] }) {
    return this.request<any>('/email/receive', { method: 'POST', body: JSON.stringify(data) });
  }

  // Legacy ingest (used by "Send test email" button)
  ingestEmail(spaceKey: string, data: { from: string; subject: string; body?: string }) {
    return this.request<any>(`/email-ingest/${spaceKey}`, { method: 'POST', body: JSON.stringify(data) });
  }

  // Persist seed (saves all in-memory data to disk so it survives restarts)
  persistSeed() { return this.request<any>('/admin/persist-seed', { method: 'POST' }); }

  // Search
  search(jql: string, page = 1) {
    return this.request<{ issues: any[]; total: number; page: number; totalPages: number }>('/search', {
      method: 'POST', body: JSON.stringify({ jql, page }),
    });
  }

  // Filters
  getFilters() { return this.request<any[]>('/filters'); }
  createFilter(data: { name: string; description?: string; jql?: string; criteria?: Record<string, any> }) {
    return this.request<any>('/filters', { method: 'POST', body: JSON.stringify(data) });
  }
  updateFilter(id: string, data: any) { return this.request<any>(`/filters/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteFilter(id: string) { return this.request<any>(`/filters/${id}`, { method: 'DELETE' }); }
  starFilter(id: string) { return this.request<any>(`/filters/${id}/star`, { method: 'POST' }); }
  unstarFilter(id: string) { return this.request<any>(`/filters/${id}/star`, { method: 'DELETE' }); }
}

export const api = new ApiClient();
