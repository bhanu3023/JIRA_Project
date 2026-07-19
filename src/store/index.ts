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
  loadSpaces: () => Promise<void>;
  loadSpace: (key: string) => Promise<void>;
  createSpace: (data: any) => Promise<void>;

  // Issues
  issues: Issue[];
  currentIssue: Issue | null;
  issueTotal: number;
  issuePage: number;
  loadIssues: (params?: Record<string, string>) => Promise<void>;
  clearIssuesCache: (params?: Record<string, string>) => void;
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
  loadSpace: async (key) => {
    // Skip if already loaded for this key — avoids redundant network call on every re-render
    if (get().currentSpace?.key?.toUpperCase() === key?.toUpperCase()) return;
    // Clear stale space so the page shows a loader instead of wrong space data
    set({ currentSpace: null });
    const space = await api.getSpace(key);
    set({ currentSpace: space });
  },
  createSpace: async (data) => {
    await api.createSpace(data);
    await get().loadSpaces();
  },

  // Issues
  issues: [],
  currentIssue: null,
  issueTotal: 0,
  issuePage: 1,
  loadIssues: async (params = {}) => {
    const cacheKey = JSON.stringify(params);
    const cached = issuesCache.get(cacheKey);
    if (cached) {
      // Show cached data instantly
      set({ issues: cached.issues, issueTotal: cached.total, issuePage: cached.page, loading: false });
      // If fresh enough, skip the network fetch
      if (Date.now() - cached.ts < CACHE_TTL) return;
      // Stale: refresh in background without showing spinner
    } else {
      // Don't clear current issues or show a spinner — keep showing whatever is on screen
      // while the new queue loads. The swap happens silently when data arrives.
      // Only show spinner if there are truly no issues at all (very first load).
      if (get().issues.length === 0) set({ loading: true });
    }
    try {
      const data = await api.getIssues(params);
      issuesCache.set(cacheKey, { issues: data.issues, total: data.total, page: data.page, ts: Date.now() });
      set({ issues: data.issues, issueTotal: data.total, issuePage: data.page, loading: false });
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },
  clearIssuesCache: (params) => {
    if (params) {
      issuesCache.delete(JSON.stringify(params));
    } else {
      issuesCache.clear();
    }
  },
  loadIssue: async (key) => {
    try {
      const issue = await api.getIssue(key);
      set({ currentIssue: issue });
    } catch {
      set({ currentIssue: null });
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
  clearCurrentIssue: () => set({ currentIssue: null }),

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
