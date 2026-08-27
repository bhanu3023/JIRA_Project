import { create } from 'zustand';
import { User, Space, Issue, Sprint, Notification, DashboardData } from '@/types';
import { api } from '@/lib/api';

/** Bumped when login/register starts so a stale in-flight `loadUser` cannot clear the new session. */
let authEpoch = 0;

let loadSpacesInflight: Promise<void> | null = null;
let loadNotificationsInflight: Promise<void> | null = null;

// Queue results cache: key → {issues, total, page, ts}
const issuesCache = new Map<string, { issues: any[]; total: number; page: number; ts: number }>();
const CACHE_TTL = 30_000; // 30 seconds stale-while-revalidate

// Tracks which queue is currently active so background fetches don't overwrite the display
let activeQueueKey = '';

// Tracks which issue key is currently the one the detail page wants displayed —
// mirrors activeQueueKey's role above. loadIssue previously had no such guard:
// clicking from one ticket into another (e.g. a subtask link) fires a new
// loadIssue() call while a still-in-flight one for the PREVIOUS ticket can
// resolve afterward and silently overwrite currentIssue with the wrong
// ticket's data — the page then either shows the old ticket again or gets
// stuck if the two calls's resolve order flips loading state back and forth.
let activeIssueKey = '';

interface AppState {
  // Auth
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  initializing: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: any) => Promise<void>;
  logout: () => void;
  loadUser: () => Promise<void>;

  // Spaces
  spaces: Space[];
  currentSpace: Space | null;
  currentSpaceError: string | null;
  loadSpaces: () => Promise<void>;
  loadSpace: (key: string, force?: boolean) => Promise<void>;
  createSpace: (data: any) => Promise<void>;

  // Issues
  issues: Issue[];
  currentIssue: Issue | null;
  // Distinguishes "still fetching" (currentIssue null, no error) from "the
  // fetch actually failed" (currentIssue null, error set) -- the issue detail
  // page only ever checked "is currentIssue null" for its loading spinner, so
  // a genuine failure (broken response, timeout, network drop) looked exactly
  // like it was still loading forever, with no way to tell the user what
  // happened or offer a retry.
  currentIssueError: string | null;
  issueTotal: number;
  issuePage: number;
  loadIssues: (params?: Record<string, string>) => Promise<void>;
  prefetchIssues: (params?: Record<string, string>) => Promise<void>;
  clearIssuesCache: (params?: Record<string, string>) => void;
  // Bumped whenever an issue is created/mutated somewhere that doesn't know the
  // exact params of whatever list view is currently on screen (e.g. the global
  // header's Create button). List views depend on this in their fetch effect
  // and re-fetch with THEIR OWN correct params — far safer than a caller
  // guessing params and overwriting the display with a mismatched query.
  issuesVersion: number;
  bumpIssuesVersion: () => void;
  loadIssue: (key: string) => Promise<void>;
  createIssue: (data: any) => Promise<any>;
  updateIssue: (key: string, data: any) => Promise<void>;
  clearCurrentIssue: () => void;

  // Sprints
  sprints: Sprint[];
  loadSprints: (params?: Record<string, string>) => Promise<void>;
  createSprint: (data: any) => Promise<void>;

  // Notifications
  notifications: Notification[];
  unreadCount: number;
  loadNotifications: () => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;

  // Dashboard
  dashboard: DashboardData | null;
  loadDashboard: (spaceKey?: string) => Promise<void>;

  // UI
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  loading: boolean;
}

export const useStore = create<AppState>((set, get) => ({
  // Auth
  user: null,
  token: null,
  isAuthenticated: false,
  initializing: true,

  login: async (email, password) => {
    authEpoch++;
    const epoch = authEpoch;
    const { token, user } = await api.login(email, password);
    if (epoch !== authEpoch) return;
    localStorage.setItem('jira_token', token);
    set({ user, token, isAuthenticated: true, initializing: false });
  },

  register: async (data) => {
    authEpoch++;
    const epoch = authEpoch;
    const { token, user } = await api.register(data);
    if (epoch !== authEpoch) return;
    localStorage.setItem('jira_token', token);
    set({ user, token, isAuthenticated: true, initializing: false });
  },

  logout: () => {
    authEpoch++;
    localStorage.removeItem('jira_token');
    set({ user: null, token: null, isAuthenticated: false, spaces: [], issues: [], notifications: [] });
  },

  loadUser: async () => {
    const epochAtStart = authEpoch;
    try {
      const token = localStorage.getItem('jira_token');
      if (!token) {
        set({ user: null, token: null, isAuthenticated: false, initializing: false });
        return;
      }
      set({ token });
      const user = await api.getMe();
      if (epochAtStart !== authEpoch) return;
      set({ user, isAuthenticated: true, initializing: false });
    } catch (err: any) {
      if (epochAtStart !== authEpoch) return;
      // Only clear session on explicit auth failure — not on server/DB errors.
      // 401 is already handled in api.ts (redirects to login + removes token).
      const msg = err?.message || '';
      const isServerError = msg.includes('Database') || msg.includes('server error') || msg.includes('503') || msg.includes('500');
      if (isServerError) {
        // Keep token; mark as authenticated with a placeholder so the app loads
        set({ isAuthenticated: true, initializing: false });
      } else {
        set({ user: null, token: null, isAuthenticated: false, initializing: false });
        localStorage.removeItem('jira_token');
      }
    }
  },

  // Spaces
  spaces: [],
  currentSpace: null,
  currentSpaceError: null,
  loadSpaces: async () => {
    if (loadSpacesInflight) return loadSpacesInflight;
    loadSpacesInflight = (async () => {
      const spaces = await api.getSpaces();
      set({ spaces });
    })().finally(() => {
      loadSpacesInflight = null;
    });
    return loadSpacesInflight;
  },
  loadSpace: async (key, force = false) => {
    // Skip if already loaded for this key — avoids redundant network call on every
    // re-render. Callers that just mutated this exact space (added/removed a member,
    // changed a role, etc.) need `force` to actually refetch here, since the whole
    // point of calling this is to see that change reflected — without it this was a
    // silent no-op every time, because the space you just changed IS the one already
    // loaded, so the member (or role, or department) you just changed never showed
    // up until some unrelated navigation happened to trigger a real refetch.
    if (!force && get().currentSpace?.key?.toUpperCase() === key?.toUpperCase()) return;
    // Don't clear currentSpace before fetch — keep showing whatever was there so the
    // page never blocks on a spinner just because the user switched boards
    //
    // For a genuinely fresh page load (or the first visit to this space this
    // session), currentSpace starts out null with nothing to fall back on, so the
    // page still blocks on the full-page spinner until this fetch resolves. Seed
    // it from the last successful fetch for this exact space (sessionStorage) so
    // the page renders instantly instead — the fetch below still always runs and
    // overwrites it with fresh data a moment later, correcting anything stale
    // (membership changes, new statuses, etc.), so this is stale-while-revalidate,
    // not a substitute for the real fetch.
    const cacheKey = `space_v1:${key.toUpperCase()}`;
    if (!force) {
      try {
        const cached = typeof window !== 'undefined' ? sessionStorage.getItem(cacheKey) : null;
        if (cached) set({ currentSpace: JSON.parse(cached), currentSpaceError: null });
      } catch { /* corrupt/unavailable cache entry — fall through to the network fetch */ }
    }
    // The fetch itself had no error handling at all -- a 404 (space doesn't
    // exist / was deleted / a stale link) or any network failure just
    // rejected this promise, and every caller does loadSpace(key).catch(() =>
    // {}), silently swallowing it with no state change. With nothing cached
    // for this key, currentSpace stays null forever with no error set either,
    // so the page's own "!currentSpace && !loadError" branch has no way out
    // and spins indefinitely instead of ever showing a real error.
    try {
      const space = await api.getSpace(key);
      set({ currentSpace: space, currentSpaceError: null });
      try { if (typeof window !== 'undefined') sessionStorage.setItem(cacheKey, JSON.stringify(space)); } catch { /* storage full/unavailable — non-critical */ }
    } catch (err: any) {
      set({ currentSpaceError: err?.message || 'Failed to load this space.' });
    }
  },
  createSpace: async (data) => {
    await api.createSpace(data);
    await get().loadSpaces();
  },

  // Issues
  issues: [],
  currentIssue: null,
  currentIssueError: null,
  issueTotal: 0,
  issuePage: 1,
  issuesVersion: 0,
  bumpIssuesVersion: () => set(s => ({ issuesVersion: s.issuesVersion + 1 })),
  loadIssues: async (params = {}) => {
    const cacheKey = JSON.stringify(params);
    // Mark this as the active queue — any in-flight fetch for a different key must not overwrite display
    activeQueueKey = cacheKey;
    const cached = issuesCache.get(cacheKey);
    if (cached) {
      // Show cached data instantly
      set({ issues: cached.issues, issueTotal: cached.total, issuePage: cached.page, loading: false });
      // If fresh enough, skip the network fetch
      if (Date.now() - cached.ts < CACHE_TTL) return;
      // Stale: revalidate in background — don't clear display
    } else {
      // No cache — clear stale issues immediately so user sees spinner, not the previous queue's data
      set({ issues: [], issueTotal: 0, loading: true });
    }
    try {
      const data = await api.getIssues(params);
      issuesCache.set(cacheKey, { issues: data.issues, total: data.total, page: data.page, ts: Date.now() });
      // Only update display data if this queue is still the active one,
      // but ALWAYS clear loading so the spinner never gets stuck
      if (activeQueueKey === cacheKey) {
        set({ issues: data.issues, issueTotal: data.total, issuePage: data.page, loading: false });
      } else {
        set({ loading: false });
      }
    } catch (e) {
      set({ loading: false }); // always clear loading on error
      if (activeQueueKey === cacheKey) throw e;
    }
  },
  // Warm the cache without ever touching store.issues — safe to call in background
  prefetchIssues: async (params = {}) => {
    const cacheKey = JSON.stringify(params);
    const cached = issuesCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return; // already fresh
    try {
      const data = await api.getIssues(params);
      issuesCache.set(cacheKey, { issues: data.issues, total: data.total, page: data.page, ts: Date.now() });
      // deliberately NO set() — never overwrite display
    } catch { /* prefetch failures are silent */ }
  },
  clearIssuesCache: (params) => {
    if (params) {
      issuesCache.delete(JSON.stringify(params));
    } else {
      issuesCache.clear();
    }
  },
  loadIssue: async (key) => {
    activeIssueKey = key;
    // Seed from the last successful load of this exact ticket (sessionStorage)
    // before the fetch, same stale-while-revalidate fix already applied to
    // loadSpace -- without it, every single ticket open (even re-opening one
    // just viewed moments ago) blocked on the full "Loading issue..."
    // spinner, because the page's own cleanup effect wipes currentIssue to
    // null on every unmount/navigation with nothing to fall back to. The
    // fetch below still always runs and overwrites this with fresh data.
    const cacheKey = `issue_v1:${key.toUpperCase()}`;
    let seeded = false;
    try {
      const cached = typeof window !== 'undefined' ? sessionStorage.getItem(cacheKey) : null;
      if (cached) { set({ currentIssue: JSON.parse(cached), currentIssueError: null }); seeded = true; }
    } catch { /* corrupt/unavailable cache entry — fall through to the network fetch */ }
    // No cache for this specific ticket -- if whatever's currently in state
    // belongs to a DIFFERENT ticket (e.g. just navigated from one issue to
    // another with neither previously cached), clear it instead of leaving
    // the wrong ticket's content on screen while this one loads.
    if (!seeded && get().currentIssue?.key !== key) set({ currentIssue: null });
    if (activeIssueKey === key) set({ currentIssueError: null });
    try {
      const issue = await api.getIssue(key);
      // Only apply this response if no newer loadIssue() call has superseded
      // it in the meantime — otherwise a slow fetch for a ticket the user has
      // already navigated away from can win the race and overwrite the
      // ticket that's actually on screen now.
      if (activeIssueKey === key) set({ currentIssue: issue, currentIssueError: null });
      try { if (typeof window !== 'undefined') sessionStorage.setItem(cacheKey, JSON.stringify(issue)); } catch { /* storage full/unavailable — non-critical */ }
    } catch (err: any) {
      if (activeIssueKey === key) set({ currentIssue: null, currentIssueError: err?.message || 'Failed to load this ticket.' });
    }
  },
  createIssue: async (data) => {
    issuesCache.clear();
    const issue = await api.createIssue(data);
    return issue;
  },
  updateIssue: async (key, data) => {
    issuesCache.clear();
    await api.updateIssue(key, data);
  },
  clearCurrentIssue: () => set({ currentIssue: null, currentIssueError: null }),

  // Sprints
  sprints: [],
  loadSprints: async (params = {}) => {
    const sprints = await api.getSprints(params);
    set({ sprints });
  },
  createSprint: async (data) => {
    await api.createSprint(data);
  },

  // Notifications
  notifications: [],
  unreadCount: 0,
  loadNotifications: async () => {
    if (loadNotificationsInflight) return loadNotificationsInflight;
    loadNotificationsInflight = (async () => {
      const { notifications, unreadCount } = await api.getNotifications();
      set({ notifications, unreadCount });
    })().finally(() => {
      loadNotificationsInflight = null;
    });
    return loadNotificationsInflight;
  },
  markAllNotificationsRead: async () => {
    // Optimistically clear the badge immediately
    set(s => ({ unreadCount: 0, notifications: s.notifications.map((n: any) => ({ ...n, isRead: true })) }));
    try { await api.markAllRead(); } catch {}
    // Sync with server
    const { notifications, unreadCount } = await api.getNotifications();
    set({ notifications, unreadCount });
  },

  // Dashboard
  dashboard: null,
  loadDashboard: async (spaceKey) => {
    const dashboard = await api.getDashboard(spaceKey);
    set({ dashboard });
  },

  // UI
  sidebarOpen: true,
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),
  loading: false,
}));
