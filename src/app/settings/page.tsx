'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { getInitials } from '@/lib/utils';
import { ROLE_LABELS as ALL_ROLE_LABELS, ROLE_COLORS as ALL_ROLE_COLORS, SELECTABLE_ROLES, can, type Permissions } from '@/lib/permissions';
import {
  User, Bell, Monitor, Grid3X3, Rocket, Box, Globe, Users,
  CreditCard, ExternalLink, Search, ChevronRight, Shield,
  Settings, Zap, Layers, LayoutList, ArrowLeft, Check, X, Plus, Trash2,
  ChevronDown, MoreHorizontal, RefreshCw, UserPlus, UserCheck, UserX, Filter,
  ImageDown, AlertCircle, Link2, Webhook, Slack, Activity, ToggleLeft, ToggleRight,
  Copy, FlaskConical,
} from 'lucide-react';

// ── Sync MS Photos button ─────────────────────────────────────────────────────
function SyncMsPhotosButton({ onDone }: { onDone: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{ synced: number; total: number; results?: {email:string;status:string}[] } | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);

  async function handleSync(forceAll = false) {
    setShowDropdown(false);
    setSyncing(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/sync-ms-photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceAll }),
      });
      const data = await res.json();
      setResult({ synced: data.synced ?? 0, total: data.total ?? 0, results: data.results });
      onDone();
    } catch {
      setResult({ synced: 0, total: 0 });
    } finally {
      setSyncing(false);
      setTimeout(() => setResult(null), 6000);
    }
  }

  return (
    <div className="flex items-center gap-2 relative">
      <div className="relative">
        <div className="flex items-center border border-blue-200 rounded-md overflow-hidden">
          <button
            onClick={() => handleSync(false)}
            disabled={syncing}
            title="Sync Microsoft profile photos (users without photo)"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-50"
          >
            {syncing
              ? <><div className="w-3 h-3 border-2 border-blue-400 border-t-blue-700 rounded-full animate-spin" /> Syncing…</>
              : <><ImageDown size={13} /> Sync Microsoft Photos</>
            }
          </button>
          <button
            onClick={() => setShowDropdown(p => !p)}
            disabled={syncing}
            className="px-1.5 py-1.5 bg-blue-50 text-blue-500 hover:bg-blue-100 border-l border-blue-200 transition-colors disabled:opacity-50"
          >
            <ChevronDown size={12} />
          </button>
        </div>
        {showDropdown && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
            <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50 w-52">
              <button onClick={() => handleSync(false)} className="w-full text-left px-3 py-2 text-[12.5px] text-gray-700 hover:bg-gray-50">
                Sync missing photos only
              </button>
              <button onClick={() => handleSync(true)} className="w-full text-left px-3 py-2 text-[12.5px] text-gray-700 hover:bg-gray-50">
                Force re-sync all users
              </button>
            </div>
          </>
        )}
      </div>
      {result && (
        <span className={`text-[11.5px] font-medium ${result.synced > 0 ? 'text-green-600' : 'text-gray-500'}`}>
          {result.synced > 0 ? `✓ ${result.synced} of ${result.total} photos synced` : result.total === 0 ? 'All photos up to date' : `No photos found (${result.total} checked)`}
        </span>
      )}
    </div>
  );
}

type SettingsView = 'main' | 'general' | 'notifications' | 'system' | 'apps' | 'spaces' | 'work-items' | 'marketplace' | 'operations' | 'users' | 'billing' | 'permissions' | 'sites' | 'api' | 'connectors';

interface Site {
  id: string;
  name: string;
  domain: string;
  supportEmail: string;
  isDefault?: boolean;
}

const PRIVILEGED_ROLES = ['admin'];

function SettingsContent() {
  const user = useStore((s) => s.user);
  const searchParams = useSearchParams();
  const router = useRouter();
  const sectionParam = searchParams.get('section') as SettingsView | null;
  const [view, setView] = useState<SettingsView>(sectionParam || 'main');
  const isPrivileged = PRIVILEGED_ROLES.includes(user?.role || '');
  const userPerms = can.bind(null, user?.role);

  // Redirect non-admins away from the settings page
  useEffect(() => {
    if (user && !isPrivileged) {
      router.replace('/dashboard');
    }
  }, [user, isPrivileged, router]);

  if (!user || !isPrivileged) return null;

  const navigate = useCallback((v: SettingsView) => {
    setView(v);
    if (v === 'main') {
      router.replace('/settings');
    } else {
      router.replace(`/settings?section=${v}`);
    }
  }, [router]);
  const [users, setUsers] = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [spaces, setSpaces] = useState<any[]>([]);
  const [newUser, setNewUser] = useState({ email: '', firstName: '', lastName: '', role: 'developer', password: 'changeme123' });
  const [profileForm, setProfileForm] = useState({ firstName: '', lastName: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // User management state
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('');
  const [userStatusFilter, setUserStatusFilter] = useState('');
  const [activeUserTab, setActiveUserTab] = useState<'users' | 'groups' | 'access'>('users');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', firstName: '', lastName: '', role: 'developer', password: 'changeme123' });
  const [inviting, setInviting] = useState(false);
  const [openUserMenu, setOpenUserMenu] = useState<string | null>(null);
  const [roleMenuPos, setRoleMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [selectedUser, setSelectedUser] = useState<any | null>(null);
  const [resendingUserId, setResendingUserId] = useState<string | null>(null);
  const [resendToast, setResendToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<any | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);
  // Work items state
  const [workTab, setWorkTab] = useState<'fields' | 'field-config' | 'screens' | 'workflows'>('fields');
  const [fieldTab, setFieldTab] = useState<'active' | 'deleted'>('active');
  const [fieldSearch, setFieldSearch] = useState('');
  const [fieldBoardFilter, setFieldBoardFilter] = useState('');
  const [fieldTypeFilter, setFieldTypeFilter] = useState('');
  const [fieldOpenMenu, setFieldOpenMenu] = useState<string | null>(null);
  const [fieldMenuPos, setFieldMenuPos] = useState<{ top: number } | null>(null);
  const [fieldBoardModal, setFieldBoardModal] = useState<string | null>(null);
  const [fieldDetailName, setFieldDetailName] = useState<string | null>(null);
  // Edit options modal
  const [editOptionsField, setEditOptionsField] = useState<{ id: string; name: string; type: string; options: string[] } | null>(null);
  const [editOptionsItems, setEditOptionsItems] = useState<string[]>([]);
  const [editOptionsInput, setEditOptionsInput] = useState('');
  const [editOptionsDeptMap, setEditOptionsDeptMap] = useState<Record<string, string[]>>({}); // for dept-routing: name→boardKeys[]
  const [editOptionsDeptDropOpen, setEditOptionsDeptDropOpen] = useState<string | null>(null); // which dept board-picker is open
  const [savingOptions, setSavingOptions] = useState(false);
  const [showCreateField, setShowCreateField] = useState(false);
  const [isCreatingField, setIsCreatingField] = useState(false);
  const [createFieldType, setCreateFieldType] = useState('');
  const [createFieldName, setCreateFieldName] = useState('');
  const [createFieldDesc, setCreateFieldDesc] = useState('');
  const [createFieldError, setCreateFieldError] = useState('');
  const [createFieldOptions, setCreateFieldOptions] = useState<string[]>([]);
  const [createFieldOptionInput, setCreateFieldOptionInput] = useState('');
  // Department Routing field builder
  type DeptRoutingItem = { name: string; boardKey: string; employees: string[] };
  const [deptRoutingItems, setDeptRoutingItems] = useState<DeptRoutingItem[]>([]);
  const [deptRoutingInput, setDeptRoutingInput] = useState('');
  const [deptRoutingEmpInput, setDeptRoutingEmpInput] = useState<Record<number, string>>({});
  const [expandedDept, setExpandedDept] = useState<number | null>(null);
  const [customFields, setCustomFields] = useState<Array<{ id: string; name: string; type: string; required: boolean; custom: boolean; options?: string[]; spaceIds: string[]; createIssueSpaceIds: string[]; isDeleted?: boolean }>>([]);
  // Local state for migrated field board/create-issue assignments (persisted in localStorage)
  const [migratedFieldConfig, setMigratedFieldConfig] = useState<Record<string, { spaceIds: string[]; createIssueSpaceIds: string[] }>>(() => {
    try { return JSON.parse(localStorage.getItem('migrated_field_config') || '{}'); } catch { return {}; }
  });
  const saveMigratedFieldConfig = (cfg: Record<string, { spaceIds: string[]; createIssueSpaceIds: string[] }>) => {
    setMigratedFieldConfig(cfg);
    localStorage.setItem('migrated_field_config', JSON.stringify(cfg));
  };
  // Sites state
  const [sites, setSites] = useState<Site[]>([
    { id: 'site_cloudfuze', name: 'cloudfuze', domain: 'cloudfuze.com', supportEmail: 'support@cloudfuze.com', isDefault: true },
  ]);
  const [showAddSite, setShowAddSite] = useState(false);
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteDomain, setNewSiteDomain] = useState('');
  const [siteDeleteConfirm, setSiteDeleteConfirm] = useState<string | null>(null);
  // App URL (Sign-in URL) config
  const [appUrl, setAppUrl] = useState('');
  const [appUrlEditing, setAppUrlEditing] = useState(false);
  const [appUrlDraft, setAppUrlDraft] = useState('');
  const [appUrlSaving, setAppUrlSaving] = useState(false);

  useEffect(() => {
    if (sectionParam && sectionParam !== view) setView(sectionParam);
  }, [sectionParam]);

  const loadUsers = () => {
    setUsersLoading(true);
    api.getUsers().then(data => { setUsers(data); setUsersLoading(false); }).catch(() => setUsersLoading(false));
  };

  useEffect(() => {
    // Load app settings (app_url etc.)
    fetch('/api/app-settings').then(r => r.ok ? r.json() : {}).then((s: any) => {
      if (s?.app_url) setAppUrl(s.app_url);
      else setAppUrl(window.location.origin);
    }).catch(() => setAppUrl(window.location.origin));
  }, []);

  useEffect(() => {
    loadUsers();
    api.getSpaces().then(setSpaces).catch(() => {});
    api.getCustomFields().then(fields => {
      setCustomFields(fields.map((f: any) => ({
        id: f.id, name: f.name, type: f.fieldType,
        required: f.required, custom: true,
        options: f.options || [], spaceIds: f.spaceIds || [],
        createIssueSpaceIds: f.createIssueSpaceIds || [],
        isDeleted: f.isDeleted,
      })));
    }).catch(() => {});
  }, []);

  // Reload users every time the users view becomes active
  useEffect(() => {
    if (view === 'users') loadUsers();
  }, [view]);

  useEffect(() => {
    if (user) setProfileForm({ firstName: user.firstName, lastName: user.lastName });
  }, [user]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createUser(newUser);
      setNewUser({ email: '', firstName: '', lastName: '', role: 'developer', password: 'changeme123' });
      loadUsers();
      setMessage('User created successfully');
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) { setMessage(err.message); }
  };

  const handleToggleActive = async (userId: string, isActive: boolean) => {
    await api.updateUser(userId, { isActive: !isActive });
    loadUsers();
  };

  const handleRoleChange = async (userId: string, role: string) => {
    await api.updateUser(userId, { role });
    loadUsers();
  };

  const handleProfileSave = async () => {
    setSaving(true);
    try {
      if (user) await api.updateUser(user.id, profileForm);
      setMessage('Profile updated');
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) { setMessage(err.message); }
    setSaving(false);
  };

  // Main settings menu
  if (view === 'main') {
    return (
      <div className="max-w-[680px] mx-auto px-6 py-6">
        {/* Back button */}
        <button onClick={() => window.history.back()}
          className="flex items-center gap-1.5 text-sm text-violet-600 hover:text-violet-800 mb-5 transition-colors font-medium">
          <ArrowLeft size={15} /> Back
        </button>
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Settings</h1>
            <p className="text-sm text-gray-400 mt-0.5">Manage your account and workspace preferences</p>
          </div>
        </div>

        {/* Personal settings — visible to all */}
        <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 px-1">Personal</p>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100 mb-6">
          <SettingsMenuItem icon={<User size={18} />} iconBg="bg-violet-100 text-violet-600" title="General settings" desc="Manage language, time zone, and other personal preferences" onClick={() => navigate('general')} />
          <SettingsMenuItem icon={<Bell size={18} />} iconBg="bg-blue-100 text-blue-600" title="Notification Settings" desc="Manage email and in-app Notification options" onClick={() => navigate('notifications')} />
          <SettingsMenuItem icon={<Zap size={18} />} iconBg="bg-amber-100 text-amber-600" title="API tokens" desc="Create and manage personal API tokens to access the application" onClick={() => navigate('api')} />
        </div>

        {/* Workspace — visible to all */}
        <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 px-1">Workspace</p>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100 mb-6">
          <SettingsMenuItem icon={<Rocket size={18} />} iconBg="bg-orange-100 text-orange-600" title="Spaces" desc="Manage space settings, categories, and more" onClick={() => navigate('spaces')} />
          <SettingsMenuItem icon={<Layers size={18} />} iconBg="bg-emerald-100 text-emerald-600" title="Work items" desc="Configure work types, Workflows, screens, fields, and more" onClick={() => navigate('work-items')} />
          <SettingsMenuItem icon={<Link2 size={18} />} iconBg="bg-cyan-100 text-cyan-600" title="Connectors" desc="Connect to Slack, Microsoft Teams, webhooks, and more" onClick={() => navigate('connectors')} />
        </div>

        {/* Administration — admin only */}
        {isPrivileged && (
          <>
            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 px-1">Administration</p>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100">
              <SettingsMenuItem icon={<Users size={18} />} iconBg="bg-indigo-100 text-indigo-600" title="User Management" desc="Manage users, Groups and access request" onClick={() => navigate('users')} external />
              <SettingsMenuItem icon={<Globe size={18} />} iconBg="bg-teal-100 text-teal-600" title="Sites" desc="Manage sites, domains and support email addresses" onClick={() => navigate('sites')} />
              <SettingsMenuItem icon={<Shield size={18} />} iconBg="bg-rose-100 text-rose-600" title="Permissions" desc="View and manage role-based access permissions" onClick={() => navigate('permissions')} />
            </div>
          </>
        )}
      </div>
    );
  }

  // Subpage wrapper
  const SubPage = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="max-w-[900px] mx-auto px-6 py-6">
      <button onClick={() => navigate('main')} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mb-5">
        <ArrowLeft size={14} /> Back to settings
      </button>
      <h1 className="text-xl font-semibold text-gray-900 mb-6">{title}</h1>
      {message && (
        <div className="mb-4 px-4 py-2.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
          <Check size={14} /> {message}
        </div>
      )}
      {children}
    </div>
  );

  // General Settings
  if (view === 'general') {
    return (
      <SubPage title="General settings">
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="p-6 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">Profile</h3>
            <div className="flex items-start gap-5">
              <div className="w-16 h-16 rounded-full bg-blue-600 flex items-center justify-center text-white text-xl font-bold flex-shrink-0">
                {getInitials(user?.firstName, user?.lastName)}
              </div>
              <div className="flex-1 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">First Name</label>
                    <input type="text" value={profileForm.firstName} onChange={e => setProfileForm(f => ({ ...f, firstName: e.target.value }))} className="input-field" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Last Name</label>
                    <input type="text" value={profileForm.lastName} onChange={e => setProfileForm(f => ({ ...f, lastName: e.target.value }))} className="input-field" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                  <input type="email" value={user?.email || ''} disabled className="input-field bg-gray-50 text-gray-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
                  <div className="text-sm text-gray-700 capitalize bg-gray-50 border border-gray-200 rounded-md px-3 py-2">{user?.role}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="p-6 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Preferences</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-700">Language</p>
                  <p className="text-xs text-gray-400">Display language for the interface</p>
                </div>
                <select className="input-field w-44 text-sm">
                  <option>English (US)</option>
                  <option>English (UK)</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-700">Time zone</p>
                  <p className="text-xs text-gray-400">Used for dates and times</p>
                </div>
                <select className="input-field w-44 text-sm">
                  <option>UTC</option>
                  <option>America/New_York</option>
                  <option>America/Chicago</option>
                  <option>America/Los_Angeles</option>
                  <option>Asia/Kolkata</option>
                  <option>Europe/London</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-700">Theme</p>
                  <p className="text-xs text-gray-400">Choose light or dark appearance</p>
                </div>
                <select className="input-field w-44 text-sm">
                  <option>Light</option>
                  <option>Dark</option>
                  <option>System</option>
                </select>
              </div>
            </div>
          </div>

          <div className="p-6 flex justify-end">
            <button onClick={handleProfileSave} disabled={saving} className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </div>
      </SubPage>
    );
  }

  // Notification Settings
  // ── API Tokens ────────────────────────────────────────────────────────────────
  if (view === 'api') {
    return <ApiTokensView navigate={navigate} user={user} />;
  }

  if (view === 'notifications') {
    return <NotificationPrefsView navigate={navigate} />;
  }

  // System Settings
  if (view === 'system') {
    return (
      <SubPage title="System">
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">General Configuration</h3>
            </div>
            {[
              { label: 'Application Title', value: 'CloudFuze' },
              { label: 'Base URL', value: 'http://localhost:3000' },
              { label: 'Mode', value: 'Development' },
              { label: 'Server Port (API)', value: '4000' },
              { label: 'Database', value: 'PostgreSQL 17' },
            ].map((item, idx) => (
              <div key={idx} className={`flex items-center justify-between px-6 py-3.5 ${idx > 0 ? 'border-t border-gray-50' : ''}`}>
                <span className="text-sm text-gray-600">{item.label}</span>
                <span className="text-sm text-gray-900 font-medium">{item.value}</span>
              </div>
            ))}
          </div>

          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Security</h3>
            </div>
            {[
              { label: 'Authentication', value: 'JWT Token' },
              { label: 'Token Expiry', value: '7 days' },
              { label: 'Password Hashing', value: 'bcrypt (10 rounds)' },
              { label: 'CORS', value: 'Enabled (all origins)' },
            ].map((item, idx) => (
              <div key={idx} className={`flex items-center justify-between px-6 py-3.5 ${idx > 0 ? 'border-t border-gray-50' : ''}`}>
                <span className="text-sm text-gray-600">{item.label}</span>
                <span className="text-sm text-gray-900 font-medium">{item.value}</span>
              </div>
            ))}
          </div>

          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Automation</h3>
            </div>
            <div className="px-6 py-3.5 flex items-center justify-between">
              <span className="text-sm text-gray-600">Automation Engine</span>
              <span className="text-xs font-medium text-green-700 bg-green-50 px-2.5 py-1 rounded-full">Active</span>
            </div>
            <div className="px-6 py-3.5 border-t border-gray-50 flex items-center justify-between">
              <span className="text-sm text-gray-600">WebSocket Real-time Updates</span>
              <span className="text-xs font-medium text-green-700 bg-green-50 px-2.5 py-1 rounded-full">Active</span>
            </div>
          </div>
        </div>
      </SubPage>
    );
  }

  // Apps
  if (view === 'apps') {
    return (
      <SubPage title="CloudFuze apps">
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {[
            { name: 'Automation Engine', desc: 'Automate workflows with triggers, conditions, and actions', status: 'active' },
            { name: 'SLA Management', desc: 'Track and enforce service level agreements', status: 'active' },
            { name: 'JQL Search', desc: 'Advanced search with Jira Query Language', status: 'active' },
            { name: 'Sprint Board', desc: 'Agile scrum board with drag-and-drop', status: 'active' },
            { name: 'Kanban Board', desc: 'Visual kanban workflow management', status: 'active' },
            { name: 'Reports & Analytics', desc: 'Burndown, velocity, and performance reports', status: 'active' },
            { name: 'Calendar & Timeline', desc: 'Visual timeline and calendar views', status: 'active' },
            { name: 'File Attachments', desc: 'Upload and manage file attachments', status: 'active' },
          ].map((app, idx) => (
            <div key={idx} className="flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600"><Zap size={18} /></div>
                <div>
                  <p className="text-sm font-medium text-gray-900">{app.name}</p>
                  <p className="text-xs text-gray-500">{app.desc}</p>
                </div>
              </div>
              <span className="text-xs font-medium text-green-700 bg-green-50 px-2.5 py-1 rounded-full capitalize">{app.status}</span>
            </div>
          ))}
        </div>
      </SubPage>
    );
  }

  // ── Connectors ──────────────────────────────────────────────────────────────
  if (view === 'connectors') {
    return <ConnectorsView navigate={navigate} />;
  }

  // Spaces Management
  if (view === 'spaces') {
    return (
      <SubPage title="Spaces">
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center">
            <span className="text-xs font-medium text-gray-500 uppercase w-12">Icon</span>
            <span className="text-xs font-medium text-gray-500 uppercase w-32">Key</span>
            <span className="text-xs font-medium text-gray-500 uppercase flex-1">Name</span>
            <span className="text-xs font-medium text-gray-500 uppercase w-32">Type</span>
            <span className="text-xs font-medium text-gray-500 uppercase w-20 text-center">Issues</span>
            <span className="text-xs font-medium text-gray-500 uppercase w-20 text-center">Members</span>
          </div>
          {spaces.map(space => (
            <div key={space.id} className="flex items-center px-6 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors">
              <div className="w-12 flex-shrink-0">
                <div className={`w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold text-white ${
                  space.type === 'scrum' ? 'bg-blue-500' : space.type === 'kanban' ? 'bg-purple-500' : 'bg-green-500'
                }`}>{space.key.slice(0, 2)}</div>
              </div>
              <span className="text-sm font-mono text-gray-600 w-32 flex-shrink-0">{space.key}</span>
              <span className="text-sm font-medium text-gray-900 flex-1 truncate pr-4">{space.name}</span>
              <span className="text-xs capitalize text-gray-500 w-32 flex-shrink-0">{space.type === 'service_desk' ? 'Service Desk' : space.type}</span>
              <span className="text-sm text-gray-600 w-20 text-center flex-shrink-0">{space.issueCount || 0}</span>
              <span className="text-sm text-gray-600 w-20 text-center flex-shrink-0">{space.memberCount || 0}</span>
            </div>
          ))}
        </div>
      </SubPage>
    );
  }

  // Work Items
  if (view === 'work-items') {
    const FIELD_TYPES_LIST = [
      { id: 'checkboxes',         label: 'Checkboxes' },
      { id: 'date',               label: 'Date Picker' },
      { id: 'datetime',           label: 'Date Time Picker' },
      { id: 'department-routing', label: 'Department Routing' },
      { id: 'labels',             label: 'Labels' },
      { id: 'number',             label: 'Number Field' },
      { id: 'paragraph',          label: 'Paragraph (supports rich text)' },
      { id: 'radio',              label: 'Radio Buttons' },
      { id: 'select-cascade',     label: 'Select List (cascading)' },
      { id: 'select-multi',       label: 'Select List (multiple choices)' },
      { id: 'select-single',      label: 'Select List (single choice)' },
      { id: 'short-text',         label: 'Short text (plain text only)' },
      { id: 'url',                label: 'URL Field' },
      { id: 'user-picker',        label: 'User Picker (multiple users)' },
      { id: 'user-single',        label: 'User Picker (single user)' },
    ];
    const LIST_FIELD_TYPES = ['checkboxes','radio','select-single','select-multi','select-cascade'];
    const isDeptRouting = createFieldType === 'department-routing';
    const selectedFieldType = FIELD_TYPES_LIST.find(t => t.id === createFieldType);
    const needsOptions = LIST_FIELD_TYPES.includes(createFieldType);
    const validOptions = createFieldOptions.filter(o => o.trim());
    const FIELD_TYPE_DESCS: Record<string, string> = {
      checkboxes: 'Allow users to select multiple values from a list of checkboxes.',
      date: 'Allow users to enter a date using a date picker.',
      datetime: 'Allow users to enter a date and time using a date-time picker.',
      labels: 'Allow users to add labels to issues.',
      number: 'Allow users to enter a numeric value.',
      paragraph: 'Allow users to enter multi-line text with rich formatting.',
      radio: 'Allow users to select a single value from a list of radio buttons.',
      'select-cascade': 'Allow users to select values from a cascading list.',
      'select-multi': 'Allow users to select multiple values from a list.',
      'select-single': 'Allow users to select a single value from a list.',
      'short-text': 'Allow users to enter a single line of plain text.',
      url: 'Allow users to enter a URL.',
      'user-picker': 'Allow users to pick one or more users from a user picker.',
      'user-single': 'Allow users to pick a single user from a user picker.',
      'department-routing': 'Route tickets to departments with board mapping & Round Robin assignment.',
    };

    const SYSTEM_FIELDS = [
      { name: 'Summary',          type: 'Text',          required: true,  custom: false },
      { name: 'Description',      type: 'Rich text',     required: false, custom: false },
      { name: 'Type',             type: 'Issue type',    required: true,  custom: false },
      { name: 'Priority',         type: 'Priority',      required: false, custom: false },
      { name: 'Status',           type: 'Status',        required: true,  custom: false },
      { name: 'Assignee',         type: 'User',          required: false, custom: false },
      { name: 'Reporter',         type: 'User',          required: true,  custom: false },
      { name: 'Labels',           type: 'Labels',        required: false, custom: false },
      { name: 'Sprint',           type: 'Sprint',        required: false, custom: false },
      { name: 'Story Points',     type: 'Number',        required: false, custom: true  },
      { name: 'Due Date',         type: 'Date',          required: false, custom: false },
      { name: 'Parent',           type: 'Issue link',    required: false, custom: false },
      { name: 'Attachments',      type: 'Attachment',    required: false, custom: false },
      // Jira-migrated fields stored as native columns on Issue model
      { name: 'Work Type',              type: 'Select List (single choice)',      required: false, custom: true },
      { name: 'Product Type',           type: 'Select List (single choice)',      required: false, custom: true },
      { name: 'Combination',            type: 'Select List (multiple choices)',   required: false, custom: true },
      { name: 'Customer Name',          type: 'Text',                             required: false, custom: true },
      { name: 'Client Name',            type: 'Text',                             required: false, custom: true },
      { name: 'Project Manager',        type: 'User',                             required: false, custom: true },
      { name: 'Root Cause',             type: 'Text',                             required: false, custom: true },
      { name: 'Fix Description',        type: 'Text',                             required: false, custom: true },
      { name: 'Time to Resolution',     type: 'SLA',     required: false, custom: true },
      { name: 'Time to First Response', type: 'SLA',     required: false, custom: true },
    ];
    const systemFieldNames = new Set(SYSTEM_FIELDS.map(f => f.name.toLowerCase()));
    type FieldEntry = { id: string; name: string; type: string; required: boolean; custom: boolean; options?: string[]; spaceIds: string[]; createIssueSpaceIds: string[]; isDeleted?: boolean };
    const FIELDS: FieldEntry[] = [
      // For system fields: use the DB version if it exists (has real id + createIssueSpaceIds)
      ...(SYSTEM_FIELDS.map(f => {
        const anyDbVersion = customFields.find(cf => cf.name.toLowerCase() === f.name.toLowerCase());
        if (anyDbVersion?.isDeleted) return null; // explicitly deleted — hide from active list
        return anyDbVersion ?? { ...f, id: '', spaceIds: [] as string[], createIssueSpaceIds: [] as string[] };
      }).filter((x): x is FieldEntry => x !== null)),
      // Only add DB custom fields that aren't already represented by SYSTEM_FIELDS
      ...customFields.filter(f => !f.isDeleted && !systemFieldNames.has(f.name.toLowerCase())),
    ];

    const SCREENS = [
      { name: 'Default Screen',       usage: 'Create, Edit, View',   fields: 13 },
      { name: 'Workflow Screen',       usage: 'Transition',           fields: 5  },
      { name: 'Bug Report Screen',     usage: 'Create',               fields: 8  },
      { name: 'Service Desk Screen',   usage: 'Create, Edit',         fields: 10 },
    ];

    const WORKFLOW_TYPES: Record<string, { color: string; label: string }> = {
      scrum:        { color: 'bg-blue-100 text-blue-700',   label: 'Scrum' },
      kanban:       { color: 'bg-purple-100 text-purple-700', label: 'Kanban' },
      service_desk: { color: 'bg-green-100 text-green-700', label: 'Service Desk' },
    };

    const WORKFLOW_STATUSES: Record<string, string[]> = {
      scrum:        ['To Do', 'In Progress', 'In Review', 'Done'],
      kanban:       ['Backlog', 'Selected for Development', 'In Progress', 'Done'],
      service_desk: ['Open', 'In Progress', 'Waiting for Customer', 'Resolved', 'Closed'],
    };

    return (
      <div className="flex h-full">
        {/* Left sidebar */}
        <div className="w-56 bg-white border-r border-gray-200 flex-shrink-0 py-4">
          <div className="px-4 mb-3">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Work items</p>
          </div>
          {[
            { id: 'fields',       label: 'Fields',               icon: <LayoutList size={15} /> },
            { id: 'field-config', label: 'Field configurations',  icon: <Settings size={15} /> },
            { id: 'screens',      label: 'Screens',               icon: <Monitor size={15} /> },
            { id: 'workflows',    label: 'Workflows',             icon: <Zap size={15} /> },
          ].map(tab => (
            <button key={tab.id} onClick={() => setWorkTab(tab.id as any)}
              className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors text-left
                ${workTab === tab.id ? 'bg-blue-50 text-blue-700 font-medium border-l-2 border-blue-600' : 'text-gray-700 hover:bg-gray-50'}`}>
              {tab.icon} {tab.label}
            </button>
          ))}
          <div className="border-t border-gray-100 my-3" />
          <button onClick={() => navigate('main')}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 transition-colors">
            <ArrowLeft size={14} /> Back to settings
          </button>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-auto bg-gray-50 p-6">

          {/* ── Fields ── */}
          {workTab === 'fields' && (() => {
            const allSpaceKeys = spaces.map(s => s.key);
            const ROOT_CAUSE_FIX_DEFAULTS = ['L2BOARD', 'L3BOARD'];
            const getBoardsForField = (name: string) => {
              const cf = customFields.find(f => f.name === name);
              if (cf) return spaces.filter(s => cf.spaceIds.includes(s.id)).map(s => s.key);
              // Root Cause & Fix Description: use saved config or default to L2BOARD+L3BOARD
              if (name === 'Root Cause' || name === 'Fix Description') {
                const cfg = migratedFieldConfig[name];
                if (cfg) return spaces.filter(s => cfg.spaceIds.includes(s.id)).map(s => s.key);
                return spaces.filter(s => ROOT_CAUSE_FIX_DEFAULTS.includes(s.key)).map(s => s.key);
              }
              // Other migrated fields: use saved config or default to all boards
              if (MIGRATED_FIELD_NAMES.has(name)) {
                const cfg = migratedFieldConfig[name];
                if (cfg) return spaces.filter(s => cfg.spaceIds.includes(s.id)).map(s => s.key);
              }
              return allSpaceKeys;
            };
            const MIGRATED_FIELD_NAMES = new Set(['Work Type','Product Type','Combination','Customer Name','Client Name','Project Manager','Root Cause','Fix Description','Time to Resolution','Time to First Response']);

            const toggleBoardForField = (fieldName: string, spaceKey: string) => {
              const sp = spaces.find(s => s.key === spaceKey);
              if (!sp) return;
              if (MIGRATED_FIELD_NAMES.has(fieldName)) {
                const cur = migratedFieldConfig[fieldName] || { spaceIds: spaces.map(s => s.id), createIssueSpaceIds: [] };
                const newSpaceIds = cur.spaceIds.includes(sp.id) ? cur.spaceIds.filter(id => id !== sp.id) : [...cur.spaceIds, sp.id];
                // Auto-enable Create Issue when board is added; remove both when board is removed
                const newCreateIds = newSpaceIds.includes(sp.id)
                  ? (cur.createIssueSpaceIds.includes(sp.id) ? cur.createIssueSpaceIds : [...cur.createIssueSpaceIds, sp.id])
                  : cur.createIssueSpaceIds.filter(id => id !== sp.id);
                saveMigratedFieldConfig({ ...migratedFieldConfig, [fieldName]: { spaceIds: newSpaceIds, createIssueSpaceIds: newCreateIds } });
                // Also persist to DB: find existing CF by name or create it
                (async () => {
                  try {
                    let cf = customFields.find(f => f.name === fieldName);
                    if (!cf) {
                      // Determine field type
                      const fieldTypeMap: Record<string, string> = {
                        'Product Type': 'Select List (single choice)',
                        'Combination': 'Select List (multiple choices)',
                        'Work Type': 'Select List (single choice)',
                        'Customer Name': 'Text', 'Client Name': 'Text',
                        'Project Manager': 'User', 'Root Cause': 'Text',
                        'Fix Description': 'Text',
                      };
                      cf = await api.createCustomField({ name: fieldName, fieldType: fieldTypeMap[fieldName] || 'Text', spaceIds: newSpaceIds, createIssueSpaceIds: newCreateIds });
                      setCustomFields(prev => [...prev, cf]);
                    } else {
                      await api.updateCustomFieldSpaces(cf.id, newSpaceIds, newCreateIds);
                      setCustomFields(prev => prev.map(f => f.id === cf.id ? { ...f, spaceIds: newSpaceIds, createIssueSpaceIds: newCreateIds } : f));
                    }
                  } catch { /* non-critical */ }
                })();
                return;
              }
              const cf = customFields.find(f => f.name === fieldName);
              if (!cf) return;
              const newSpaceIds = cf.spaceIds.includes(sp.id) ? cf.spaceIds.filter(id => id !== sp.id) : [...cf.spaceIds, sp.id];
              // Auto-enable Create Issue when board is added; remove both when board is removed
              const newCreateIds = newSpaceIds.includes(sp.id)
                ? (cf.createIssueSpaceIds.includes(sp.id) ? cf.createIssueSpaceIds : [...cf.createIssueSpaceIds, sp.id])
                : cf.createIssueSpaceIds.filter(id => id !== sp.id);
              setCustomFields(prev => prev.map(f => f.id === cf.id ? { ...f, spaceIds: newSpaceIds, createIssueSpaceIds: newCreateIds } : f));
              api.updateCustomFieldSpaces(cf.id, newSpaceIds, newCreateIds).catch(() => {});
            };

            const toggleCreateIssueForField = (fieldName: string, spaceKey: string) => {
              const sp = spaces.find(s => s.key === spaceKey);
              if (!sp) return;
              if (MIGRATED_FIELD_NAMES.has(fieldName)) {
                const allSpaceIds = spaces.map(s => s.id);
                const cur = migratedFieldConfig[fieldName] || { spaceIds: allSpaceIds, createIssueSpaceIds: [] };
                const newCreateIds = cur.createIssueSpaceIds.includes(sp.id) ? cur.createIssueSpaceIds.filter(id => id !== sp.id) : [...cur.createIssueSpaceIds, sp.id];
                saveMigratedFieldConfig({ ...migratedFieldConfig, [fieldName]: { ...cur, createIssueSpaceIds: newCreateIds } });
                // Persist to API (create field if it doesn't exist yet)
                const fieldTypeMap: Record<string, string> = {
                  'Product Type': 'select', 'Combination': 'select-multi',
                  'Work Type': 'select', 'Customer Name': 'text', 'Client Name': 'text',
                  'Project Manager': 'user', 'Root Cause': 'text', 'Fix Description': 'text',
                  'Time to Resolution': 'text', 'Time to First Response': 'text',
                };
                (async () => {
                  try {
                    let cf = customFields.find(f => f.name === fieldName);
                    if (!cf) {
                      cf = await api.createCustomField({ name: fieldName, fieldType: fieldTypeMap[fieldName] || 'text', spaceIds: cur.spaceIds, createIssueSpaceIds: newCreateIds });
                      setCustomFields(prev => [...prev, cf]);
                    } else {
                      await api.updateCustomFieldSpaces(cf.id, cf.spaceIds, newCreateIds);
                      setCustomFields(prev => prev.map(f => f.id === cf.id ? { ...f, createIssueSpaceIds: newCreateIds } : f));
                    }
                  } catch { /* non-critical */ }
                })();
                return;
              }
              const cf = customFields.find(f => f.name === fieldName);
              if (!cf) return;
              const newCreateIds = cf.createIssueSpaceIds.includes(sp.id) ? cf.createIssueSpaceIds.filter(id => id !== sp.id) : [...cf.createIssueSpaceIds, sp.id];
              setCustomFields(prev => prev.map(f => f.id === cf.id ? { ...f, createIssueSpaceIds: newCreateIds } : f));
              api.updateCustomFieldSpaces(cf.id, cf.spaceIds, newCreateIds).catch(() => {});
            };

            const filteredFields = FIELDS.filter(f => {
              const matchSearch = !fieldSearch || f.name.toLowerCase().includes(fieldSearch.toLowerCase()) || f.type.toLowerCase().includes(fieldSearch.toLowerCase());
              const matchBoard = !fieldBoardFilter || getBoardsForField(f.name).includes(fieldBoardFilter);
              const matchType = !fieldTypeFilter || (fieldTypeFilter === 'custom' ? f.custom : !f.custom);
              return matchSearch && matchBoard && matchType;
            });

            // ── Field detail view ──
            if (fieldDetailName) {
              const detailField = FIELDS.find(f => f.name === fieldDetailName);
              const assignedKeys = getBoardsForField(fieldDetailName);
              const assignedSpaces = spaces.filter(s => assignedKeys.includes(s.key));
              const unassignedSpaces = spaces.filter(s => !assignedKeys.includes(s.key));
              const BOARD_TYPE_COLOR: Record<string, string> = {
                scrum: 'bg-blue-100 text-blue-700',
                kanban: 'bg-purple-100 text-purple-700',
                service_desk: 'bg-green-100 text-green-700',
              };
              return (
                <div>
                  {/* Breadcrumb */}
                  <div className="flex items-center gap-2 mb-5">
                    <button onClick={() => setFieldDetailName(null)}
                      className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium">
                      <ArrowLeft size={14} /> Fields
                    </button>
                    <span className="text-gray-400">/</span>
                    <span className="text-sm text-gray-600 font-medium">{fieldDetailName}</span>
                  </div>

                  {/* Title row */}
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h1 className="text-xl font-bold text-gray-900">{fieldDetailName}</h1>
                      <p className="text-sm text-gray-500 mt-0.5">
                        {detailField?.type} &nbsp;·&nbsp;
                        <span className={`font-medium ${detailField?.custom ? 'text-purple-600' : 'text-gray-500'}`}>
                          {detailField?.custom ? 'Custom field' : 'System field'}
                        </span>
                        {detailField?.required && <span className="ml-2 text-[11px] font-bold bg-orange-50 text-orange-500 px-1.5 py-0.5 rounded">Required</span>}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-5">
                    {/* Boards this field is ON */}
                    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                        <div>
                          <h2 className="text-sm font-bold text-gray-900">Active boards</h2>
                          <p className="text-xs text-gray-400 mt-0.5">This field is visible on these boards</p>
                        </div>
                        <span className="text-xs font-bold bg-green-50 text-green-700 px-2.5 py-1 rounded-full">{assignedSpaces.length} boards</span>
                      </div>
                      {assignedSpaces.length === 0 ? (
                        <div className="px-5 py-8 text-center text-gray-400 text-sm">Not added to any board yet</div>
                      ) : (
                        <div className="divide-y divide-gray-50">
                          {assignedSpaces.map(sp => (
                            <div key={sp.key} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors group">
                              <div className={`w-8 h-8 rounded-md bg-gradient-to-br flex items-center justify-center text-white text-xs font-bold flex-shrink-0
                                ${sp.type === 'scrum' ? 'from-blue-500 to-indigo-600' : sp.type === 'kanban' ? 'from-purple-500 to-violet-600' : 'from-green-500 to-emerald-600'}`}>
                                {sp.key.slice(0, 2)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-gray-900 truncate">{sp.name}</p>
                                <p className="text-xs text-gray-400">{sp.key}</p>
                              </div>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${BOARD_TYPE_COLOR[sp.type] || 'bg-gray-100 text-gray-500'}`}>
                                {sp.type === 'service_desk' ? 'Service Desk' : sp.type}
                              </span>
                              <button onClick={() => toggleBoardForField(fieldDetailName, sp.key)}
                                className="text-xs text-red-500 hover:text-red-700 font-medium opacity-0 group-hover:opacity-100 transition-opacity ml-2 border border-red-200 hover:bg-red-50 px-2 py-0.5 rounded">
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Boards this field is NOT on */}
                    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                        <div>
                          <h2 className="text-sm font-bold text-gray-900">Available boards</h2>
                          <p className="text-xs text-gray-400 mt-0.5">Add this field to these boards</p>
                        </div>
                        <span className="text-xs font-bold bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full">{unassignedSpaces.length} boards</span>
                      </div>
                      {unassignedSpaces.length === 0 ? (
                        <div className="px-5 py-8 text-center text-gray-400 text-sm">Field is active on all boards</div>
                      ) : (
                        <div className="divide-y divide-gray-50">
                          {unassignedSpaces.map(sp => (
                            <div key={sp.key} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors group opacity-60 hover:opacity-100">
                              <div className={`w-8 h-8 rounded-md bg-gradient-to-br flex items-center justify-center text-white text-xs font-bold flex-shrink-0
                                ${sp.type === 'scrum' ? 'from-blue-500 to-indigo-600' : sp.type === 'kanban' ? 'from-purple-500 to-violet-600' : 'from-green-500 to-emerald-600'}`}>
                                {sp.key.slice(0, 2)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-gray-900 truncate">{sp.name}</p>
                                <p className="text-xs text-gray-400">{sp.key}</p>
                              </div>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${BOARD_TYPE_COLOR[sp.type] || 'bg-gray-100 text-gray-500'}`}>
                                {sp.type === 'service_desk' ? 'Service Desk' : sp.type}
                              </span>
                              <button onClick={() => toggleBoardForField(fieldDetailName, sp.key)}
                                className="text-xs text-blue-600 hover:text-blue-800 font-medium opacity-0 group-hover:opacity-100 transition-opacity ml-2 border border-blue-200 hover:bg-blue-50 px-2 py-0.5 rounded">
                                + Add
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Summary bar */}
                  <div className="mt-4 bg-blue-50 border border-blue-100 rounded-lg px-5 py-3 flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                    <p className="text-sm text-blue-700">
                      <span className="font-semibold">{fieldDetailName}</span> is active on{' '}
                      <span className="font-bold">{assignedSpaces.length}</span> of{' '}
                      <span className="font-bold">{spaces.length}</span> boards.
                      {assignedSpaces.length === spaces.length && ' This field is available on all boards.'}
                    </p>
                  </div>
                </div>
              );
            }

            return (
              <div>
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                  <h1 className="text-xl font-bold text-gray-900">Fields</h1>
                  <button onClick={() => { setShowCreateField(true); setCreateFieldType(''); setCreateFieldName(''); setCreateFieldDesc(''); setCreateFieldOptions(['']); setCreateFieldOptionInput(''); setCreateFieldError(''); }}
                    className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors">
                    <Plus size={14} /> Create new field
                  </button>
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-0 mb-4 border-b border-gray-200">
                  {(['active', 'deleted'] as const).map(t => (
                    <button key={t} onClick={() => setFieldTab(t)}
                      className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px
                        ${fieldTab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                      {t === 'active' ? 'Active fields' : 'Deleted fields'}
                    </button>
                  ))}
                </div>

                {fieldTab === 'deleted' ? (
                  (() => {
                    const deletedFields = customFields.filter(f => f.isDeleted);
                    return deletedFields.length === 0 ? (
                      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400">
                        <Trash2 size={32} className="mx-auto mb-2 text-gray-300" />
                        <p className="text-sm">No deleted fields.</p>
                      </div>
                    ) : (
                      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead><tr className="border-b border-gray-100 bg-gray-50">
                            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">NAME</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">FIELD TYPE</th>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">ACTIONS</th>
                          </tr></thead>
                          <tbody className="divide-y divide-gray-50">
                            {deletedFields.map(f => (
                              <tr key={f.id} className="hover:bg-gray-50">
                                <td className="px-4 py-3 text-gray-500 line-through">{f.name}</td>
                                <td className="px-4 py-3 text-gray-400">{f.type === 'department-routing' ? 'Department Routing' : f.type}</td>
                                <td className="px-4 py-3">
                                  <button onClick={() => {
                                    api.updateCustomField(f.id, { isDeleted: false }).then(() => {
                                      setCustomFields(prev => prev.map(cf => cf.id === f.id ? {...cf, isDeleted: false} : cf));
                                    }).catch(() => {});
                                  }} className="text-xs text-blue-600 hover:underline">Restore</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()
                ) : (
                  <>
                    {/* Filters */}
                    <div className="flex items-center gap-2 mb-3">
                      <div className="relative">
                        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                        <input type="text" value={fieldSearch} onChange={e => setFieldSearch(e.target.value)}
                          placeholder="Search fields"
                          className="pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-52" />
                      </div>
                      <select value={fieldBoardFilter} onChange={e => setFieldBoardFilter(e.target.value)}
                        className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-700">
                        <option value="">Can be used in (all boards)</option>
                        {spaces.map(sp => <option key={sp.key} value={sp.key}>{sp.name} ({sp.key})</option>)}
                      </select>
                      <select value={fieldTypeFilter} onChange={e => setFieldTypeFilter(e.target.value)}
                        className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-700">
                        <option value="">Field type category</option>
                        <option value="system">System fields</option>
                        <option value="custom">Custom fields</option>
                      </select>
                    </div>

                    <p className="text-sm text-gray-500 mb-3">{filteredFields.length} fields</p>

                    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full">
                        <thead className="border-b border-gray-200 bg-gray-50">
                          <tr>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Field type</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Boards used in</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Source</th>
                            <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {filteredFields.map((f, i) => {
                            const boards = getBoardsForField(f.name);
                            const usedSpaces = spaces.filter(s => boards.includes(s.key));
                            return (
                              <tr key={i} className="hover:bg-gray-50 transition-colors group">
                                <td className="px-5 py-3">
                                  <div className="flex items-center gap-2">
                                    <button onClick={() => setFieldDetailName(f.name)}
                                      className="text-sm font-semibold text-blue-600 hover:text-blue-800 hover:underline text-left">
                                      {f.name}
                                    </button>
                                    {f.required && <span className="text-[10px] font-bold bg-orange-50 text-orange-500 px-1.5 py-0.5 rounded">Required</span>}
                                  </div>
                                </td>
                                <td className="px-5 py-3 text-sm text-gray-600">{f.type === 'department-routing' ? 'Department Routing' : f.type}</td>
                                <td className="px-5 py-3">
                                  <div className="flex flex-wrap gap-1">
                                    {!f.custom
                                      ? <span className="text-xs text-gray-500">All boards</span>
                                      : usedSpaces.length === 0
                                        ? <span className="text-xs text-red-400">No boards</span>
                                        : usedSpaces.map(sp => (
                                            <span key={sp.key} className="text-[11px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-medium">{sp.key}</span>
                                          ))
                                    }
                                  </div>
                                </td>
                                <td className="px-5 py-3">
                                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${f.custom ? 'bg-purple-50 text-purple-600' : 'bg-gray-100 text-gray-500'}`}>
                                    {f.custom ? 'Custom' : 'System'}
                                  </span>
                                </td>
                                <td className="px-5 py-3 text-right">
                                  <div className="relative inline-block">
                                    <button
                                      onClick={(e) => {
                                        if (fieldOpenMenu === f.name) { setFieldOpenMenu(null); return; }
                                        // Check if near bottom — flip menu upward
                                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                        const spaceBelow = window.innerHeight - rect.bottom;
                                        setFieldMenuPos({ top: spaceBelow < 120 ? -1 : 1 });
                                        setFieldOpenMenu(f.name);
                                      }}
                                      className="w-7 h-7 rounded-md hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <MoreHorizontal size={15} />
                                    </button>
                                    {fieldOpenMenu === f.name && (
                                      <>
                                        <div className="fixed inset-0 z-40" onClick={() => setFieldOpenMenu(null)} />
                                        <div className={`absolute right-0 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 ${fieldMenuPos?.top === -1 ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                                          <button onClick={() => { setFieldBoardModal(f.name); setFieldOpenMenu(null); }}
                                            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                                            <Settings size={13} className="text-gray-400" /> Manage boards
                                          </button>
                                          {/* Edit options — for any field that has options */}
                                          {f.custom && f.id && (f.options?.length || f.type === 'department-routing' || f.type === 'Department Routing' || ['Select List (single choice)','Select List (multiple choices)','Radio Buttons','Checkboxes'].includes(f.type)) && (
                                            <button onClick={() => {
                                              const isDR = f.type === 'department-routing' || f.type === 'Department Routing';
                                              const rawOpts = f.options || [];
                                              if (isDR) {
                                                // Parse "name|board1,board2|..." format
                                                const items = rawOpts.map((o: string) => o.split('|')[0]);
                                                const map: Record<string, string[]> = {};
                                                rawOpts.forEach((o: string) => {
                                                  const p = o.split('|');
                                                  if (p[0]) map[p[0]] = p[1] ? p[1].split(',').filter(Boolean) : [];
                                                });
                                                setEditOptionsItems(items);
                                                setEditOptionsDeptMap(map);
                                              } else {
                                                setEditOptionsItems([...rawOpts]);
                                                setEditOptionsDeptMap({});
                                              }
                                              setEditOptionsField({ id: f.id, name: f.name, type: f.type, options: rawOpts });
                                              setEditOptionsInput('');
                                              setFieldOpenMenu(null);
                                            }} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                                              <Layers size={13} className="text-gray-400" /> Edit options
                                            </button>
                                          )}
                                          {f.id && (
                                            <button onClick={() => {
                                              api.deleteCustomField(f.id).then(() => {
                                                setCustomFields(prev => prev.map(cf => cf.id === f.id ? {...cf, isDeleted: true} : cf));
                                              }).catch(() => {});
                                              setFieldOpenMenu(null);
                                            }} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                                              <Trash2 size={13} /> Delete field
                                            </button>
                                          )}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {/* ── Edit Options Modal ── */}
                {editOptionsField && (
                  <>
                    <div className="fixed inset-0 bg-black/40 z-50" onClick={() => { setEditOptionsField(null); setEditOptionsDeptDropOpen(null); }} />
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
                          <div>
                            <h2 className="text-sm font-bold text-gray-900">Edit options</h2>
                            <p className="text-xs text-gray-500 mt-0.5">Field: <span className="font-semibold text-gray-700">{editOptionsField.name}</span></p>
                          </div>
                          <button onClick={() => setEditOptionsField(null)} className="w-7 h-7 rounded-md hover:bg-gray-100 flex items-center justify-center text-gray-400"><X size={15} /></button>
                        </div>

                        {/* Body */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
                          {(() => {
                            const isDR = editOptionsField.type === 'department-routing' || editOptionsField.type === 'Department Routing';
                            return (
                              <>
                                {editOptionsItems.map((opt, idx) => (
                                  <div key={idx} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 group">
                                    <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                                    <span className="flex-1 text-sm text-gray-800 font-medium">{opt}</span>
                                    {isDR && (
                                      <>
                                        <span className="text-[11px] text-gray-400 flex-shrink-0">→ Boards:</span>
                                        {/* Multi-board picker */}
                                        <div className="relative flex-1 min-w-0">
                                          <button
                                            type="button"
                                            onClick={() => setEditOptionsDeptDropOpen(editOptionsDeptDropOpen === opt ? null : opt)}
                                            className="w-full flex items-center justify-between border border-gray-300 rounded px-2 py-1 text-xs bg-white hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                          >
                                            <span className="truncate">
                                              {(editOptionsDeptMap[opt] || []).length === 0
                                                ? <span className="text-gray-400">Select boards</span>
                                                : (editOptionsDeptMap[opt] || []).join(', ')}
                                            </span>
                                            <ChevronDown size={10} className="text-gray-400 flex-shrink-0 ml-1" />
                                          </button>
                                          {editOptionsDeptDropOpen === opt && (
                                            <>
                                              <div className="fixed inset-0 z-[60]" onClick={() => setEditOptionsDeptDropOpen(null)} />
                                              <div className="absolute left-0 top-full mt-1 z-[70] bg-white border border-gray-200 rounded-lg shadow-xl w-64 max-h-52 overflow-y-auto py-1">
                                                {spaces.map(s => {
                                                  const selected = (editOptionsDeptMap[opt] || []).includes(s.key);
                                                  return (
                                                    <label key={s.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                                                      <div
                                                        className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${selected ? 'bg-blue-600 border-blue-600' : 'border-gray-300 bg-white'}`}
                                                        onClick={() => {
                                                          const cur = editOptionsDeptMap[opt] || [];
                                                          const updated = selected ? cur.filter(k => k !== s.key) : [...cur, s.key];
                                                          setEditOptionsDeptMap(prev => ({ ...prev, [opt]: updated }));
                                                        }}
                                                      >
                                                        {selected && <Check size={10} className="text-white" />}
                                                      </div>
                                                      <span className="text-xs text-gray-700 flex-1">{s.name}</span>
                                                      <span className="text-[10px] text-gray-400 font-mono">{s.key}</span>
                                                    </label>
                                                  );
                                                })}
                                              </div>
                                            </>
                                          )}
                                        </div>
                                      </>
                                    )}
                                    <button type="button"
                                      onClick={() => {
                                        setEditOptionsItems(prev => prev.filter((_, i) => i !== idx));
                                        if (isDR) setEditOptionsDeptMap(prev => { const n = { ...prev }; delete n[opt]; return n; });
                                      }}
                                      className="w-6 h-6 rounded hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-400 transition-all opacity-0 group-hover:opacity-100 flex-shrink-0">
                                      <X size={12} />
                                    </button>
                                  </div>
                                ))}

                                {/* Add new option */}
                                <div className="flex items-center gap-2 pt-1">
                                  <input
                                    type="text"
                                    value={editOptionsInput}
                                    onChange={e => setEditOptionsInput(e.target.value)}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        const val = editOptionsInput.trim();
                                        if (val && !editOptionsItems.find(o => o.toLowerCase() === val.toLowerCase())) {
                                          setEditOptionsItems(prev => [...prev, val]);
                                          setEditOptionsInput('');
                                        }
                                      }
                                    }}
                                    placeholder={isDR ? 'Add department name' : 'Add option'}
                                    className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  />
                                  <button type="button"
                                    onClick={() => {
                                      const val = editOptionsInput.trim();
                                      if (val && !editOptionsItems.find(o => o.toLowerCase() === val.toLowerCase())) {
                                        setEditOptionsItems(prev => [...prev, val]);
                                        setEditOptionsInput('');
                                      }
                                    }}
                                    className="flex items-center gap-1 px-3 py-2 text-sm font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md border border-blue-200 transition-colors">
                                    <Plus size={13} /> Add
                                  </button>
                                </div>
                              </>
                            );
                          })()}
                        </div>

                        {/* Footer */}
                        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100 flex-shrink-0">
                          <button onClick={() => setEditOptionsField(null)}
                            className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                            Cancel
                          </button>
                          <button
                            disabled={savingOptions || editOptionsItems.length === 0}
                            onClick={async () => {
                              setSavingOptions(true);
                              const isDR = editOptionsField.type === 'department-routing' || editOptionsField.type === 'Department Routing';
                              const finalOpts = isDR
                                ? editOptionsItems.map(n => `${n}|${(editOptionsDeptMap[n] || []).join(',')}|`)
                                : editOptionsItems;
                              try {
                                await api.updateCustomField(editOptionsField.id, { options: finalOpts });
                                setCustomFields(prev => prev.map(cf =>
                                  cf.id === editOptionsField.id ? { ...cf, options: finalOpts } : cf
                                ));
                                setEditOptionsField(null);
                              } catch {}
                              setSavingOptions(false);
                            }}
                            className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                            {savingOptions ? 'Saving…' : 'Save changes'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* Board picker modal */}
                {fieldBoardModal && (
                  <>
                    <div className="fixed inset-0 bg-black/40 z-50" onClick={() => setFieldBoardModal(null)} />
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                          <div>
                            <h2 className="text-sm font-bold text-gray-900">Manage boards</h2>
                            <p className="text-xs text-gray-500 mt-0.5">Field: <span className="font-semibold text-gray-700">{fieldBoardModal}</span></p>
                          </div>
                          <button onClick={() => setFieldBoardModal(null)} className="w-7 h-7 rounded-md hover:bg-gray-100 flex items-center justify-center text-gray-400">
                            <X size={15} />
                          </button>
                        </div>
                        {/* Column headers */}
                        <div className="grid items-center px-4 py-2 border-b border-gray-100 bg-gray-50" style={{ gridTemplateColumns: '1fr 80px 100px' }}>
                          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Space</span>
                          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide text-center">Board</span>
                          <span className="text-[10px] font-semibold text-blue-600 uppercase tracking-wide text-center">Create Issue</span>
                        </div>
                        <div className="px-2 py-1 space-y-0.5 max-h-72 overflow-y-auto">
                          {spaces.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No boards found</p>}
                          {spaces.map(sp => {
                            const isMigrated = ['Work Type','Product Type','Combination','Customer Name','Client Name','Project Manager','Time to Resolution','Time to First Response'].includes(fieldBoardModal);
                            const cf = customFields.find(f => f.name === fieldBoardModal);
                            const mCfg = migratedFieldConfig[fieldBoardModal];
                            const boardEnabled = isMigrated
                              ? (mCfg ? mCfg.spaceIds.includes(sp.id) : true) // default all on for migrated
                              : cf ? cf.spaceIds.includes(sp.id) : getBoardsForField(fieldBoardModal).includes(sp.key);
                            const createEnabled = isMigrated
                              ? (mCfg ? mCfg.createIssueSpaceIds.includes(sp.id) : false)
                              : cf ? cf.createIssueSpaceIds.includes(sp.id) : false;
                            return (
                              <div key={sp.key} className="grid items-center px-2 py-2.5 rounded-lg hover:bg-gray-50" style={{ gridTemplateColumns: '1fr 80px 100px' }}>
                                {/* Space info */}
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                                    {sp.key.slice(0, 2)}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="text-[13px] font-medium text-gray-900 truncate">{sp.name}</p>
                                    <p className="text-[11px] text-gray-400 capitalize">{sp.type?.replace('_', ' ')}</p>
                                  </div>
                                </div>
                                {/* Board checkbox */}
                                <div className="flex items-center justify-center">
                                  <input type="checkbox" checked={boardEnabled}
                                    onChange={() => toggleBoardForField(fieldBoardModal, sp.key)}
                                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer accent-blue-600" />
                                </div>
                                {/* Create Issue toggle */}
                                <div className="flex items-center justify-center">
                                  <label className={`relative inline-flex items-center ${boardEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}>
                                    <input type="checkbox" checked={createEnabled} disabled={!boardEnabled}
                                      onChange={() => toggleCreateIssueForField(fieldBoardModal, sp.key)}
                                      className="sr-only peer" />
                                    <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:bg-blue-600 peer-focus:ring-2 peer-focus:ring-blue-300 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4 relative"></div>
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
                          <button onClick={() => setFieldBoardModal(null)}
                            className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">
                            Done
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {/* ── Create Field Modal ── */}
          {showCreateField && (
            <>
              <div className="fixed inset-0 bg-black/40 z-50" onClick={() => setShowCreateField(false)} />
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-y-auto max-h-[90vh]" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                    <h2 className="text-lg font-bold text-gray-900">Create field</h2>
                    <button onClick={() => setShowCreateField(false)} className="w-7 h-7 rounded-md hover:bg-gray-100 flex items-center justify-center text-gray-400">
                      <X size={16} />
                    </button>
                  </div>
                  <form onSubmit={async e => {
                    e.preventDefault();
                    if (!createFieldType || !createFieldName) return;
                    if (needsOptions && validOptions.length === 0) return;
                    if (isDeptRouting && deptRoutingItems.length === 0) return;
                    if (isCreatingField) return;
                    setIsCreatingField(true);
                    const typeLabel = FIELD_TYPES_LIST.find(t => t.id === createFieldType)?.label ?? createFieldType;
                    // For dept routing, encode as JSON string per option: "DeptName|boardKey|emp1,emp2,emp3"
                    const finalOptions = isDeptRouting
                      ? deptRoutingItems.map(d => `${d.name}|${d.boardKey}|${d.employees.join(',')}`)
                      : (needsOptions ? validOptions : []);
                    setCreateFieldError('');
                    try {
                      const created = await api.createCustomField({
                        name: createFieldName,
                        fieldType: createFieldType,
                        description: createFieldDesc,
                        options: finalOptions,
                        spaceIds: [],
                      });
                      if (!created?.id) throw new Error('Server returned invalid response');
                      setCustomFields(prev => [...prev, {
                        id: created.id,
                        name: created.name,
                        type: typeLabel,
                        required: false,
                        custom: true,
                        options: created.options || [],
                        spaceIds: created.spaceIds || [],
                        createIssueSpaceIds: created.createIssueSpaceIds || [],
                        isDeleted: false,
                      }]);
                      setShowCreateField(false);
                      setCreateFieldType(''); setCreateFieldName(''); setCreateFieldDesc(''); setCreateFieldOptions([]); setCreateFieldOptionInput('');
                      setDeptRoutingItems([]); setDeptRoutingInput(''); setDeptRoutingEmpInput({}); setExpandedDept(null);
                      setCreateFieldError('');
                      setMessage(`Custom field "${createFieldName}" created successfully`);
                      setTimeout(() => setMessage(''), 3000);
                    } catch (err: any) {
                      setCreateFieldError(err?.message || 'Failed to create field. Please try again.');
                    } finally {
                      setIsCreatingField(false);
                    }
                  }} className="p-6 space-y-5">
                    <p className="text-xs text-orange-600">Required fields are marked with an asterisk <span className="text-red-500 font-bold">*</span></p>

                    {createFieldError && (
                      <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-md text-sm">
                        <AlertCircle size={14} className="flex-shrink-0" /> {createFieldError}
                      </div>
                    )}

                    {/* Field type */}
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                        Field type <span className="text-red-500">*</span>
                      </label>
                      <div className="relative">
                        <select value={createFieldType}
                          onChange={e => { setCreateFieldType(e.target.value); setCreateFieldOptions([]); setCreateFieldOptionInput(''); setDeptRoutingItems([]); setDeptRoutingInput(''); setDeptRoutingEmpInput({}); setExpandedDept(null); }}
                          className="w-full border border-gray-300 rounded-md px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 appearance-none text-gray-700">
                          <option value="">Select a field type</option>
                          {FIELD_TYPES_LIST.map(t => (
                            <option key={t.id} value={t.id}>{t.label}</option>
                          ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      </div>
                      {selectedFieldType && FIELD_TYPE_DESCS[createFieldType] && (
                        <p className="text-xs text-gray-500 mt-1.5 pl-1">{FIELD_TYPE_DESCS[createFieldType]}</p>
                      )}
                    </div>

                    {/* Field name */}
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                        Name <span className="text-red-500">*</span>
                      </label>
                      <input type="text" value={createFieldName} onChange={e => setCreateFieldName(e.target.value)}
                        placeholder="e.g. Customer Priority"
                        className="w-full border border-gray-300 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400" />
                    </div>

                    {/* Description */}
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Description</label>
                      <textarea value={createFieldDesc} onChange={e => setCreateFieldDesc(e.target.value)} rows={2}
                        placeholder="Describe what this field is used for"
                        className="w-full border border-gray-300 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 resize-none" />
                    </div>

                    {/* Options — only for list/choice types */}
                    {needsOptions && (
                      <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                          Options <span className="text-red-500">*</span>
                        </label>
                        <p className="text-xs text-gray-500 mb-2">Add the choices users can select from.</p>
                        <div className="space-y-2 mb-3">
                          {validOptions.map((opt, idx) => (
                            <div key={idx} className="flex items-center gap-2 group">
                              <div className="flex items-center gap-2 flex-1 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                                {createFieldType === 'radio'
                                  ? <span className="w-3.5 h-3.5 rounded-full border-2 border-gray-400 flex-shrink-0" />
                                  : createFieldType === 'checkboxes'
                                    ? <span className="w-3.5 h-3.5 rounded border-2 border-gray-400 flex-shrink-0" />
                                    : <span className="text-xs text-gray-400 font-mono w-4">{idx + 1}.</span>
                                }
                                <span className="text-sm text-gray-800">{opt}</span>
                              </div>
                              <button type="button"
                                onClick={() => setCreateFieldOptions(prev => prev.filter((_, i) => i !== idx))}
                                className="w-6 h-6 rounded hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                                <X size={13} />
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <input type="text" value={createFieldOptionInput}
                            onChange={e => setCreateFieldOptionInput(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                const val = createFieldOptionInput.trim();
                                if (val) { setCreateFieldOptions(prev => [...prev, val]); setCreateFieldOptionInput(''); }
                              }
                            }}
                            placeholder="Type an option and press Enter"
                            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400"
                          />
                          <button type="button"
                            onClick={() => {
                              const val = createFieldOptionInput.trim();
                              if (val) { setCreateFieldOptions(prev => [...prev, val]); setCreateFieldOptionInput(''); }
                            }}
                            className="flex items-center gap-1 px-3 py-2 text-sm font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md border border-blue-200 transition-colors">
                            <Plus size={13} /> Add
                          </button>
                        </div>
                        {validOptions.length === 0 && (
                          <p className="text-xs text-red-400 mt-1.5">Add at least one option</p>
                        )}
                      </div>
                    )}

                    {/* Department Routing — just department names */}
                    {isDeptRouting && (
                      <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-1">
                          Department Options <span className="text-red-500">*</span>
                        </label>
                        <p className="text-xs text-gray-500 mb-3">
                          Add each department and select which board tickets should route to. Assign employees in <strong>Space Settings → Round Robin</strong>.
                        </p>

                        {/* Added departments list — each row has name + board selector */}
                        <div className="space-y-1.5 mb-3">
                          {deptRoutingItems.map((dept, idx) => (
                            <div key={idx} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                              <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                              <span className="text-sm text-gray-800 font-medium w-28 flex-shrink-0 truncate">{dept.name}</span>
                              <span className="text-[11px] text-gray-400 flex-shrink-0">→ Board:</span>
                              <select
                                value={dept.boardKey}
                                onChange={e => setDeptRoutingItems(prev => prev.map((d, i) => i === idx ? { ...d, boardKey: e.target.value } : d))}
                                className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                              >
                                <option value="">Select board</option>
                                {spaces.map(s => (
                                  <option key={s.id} value={s.key}>{s.name} ({s.key})</option>
                                ))}
                              </select>
                              <button type="button"
                                onClick={() => setDeptRoutingItems(prev => prev.filter((_, i) => i !== idx))}
                                className="w-6 h-6 rounded hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-400 transition-all flex-shrink-0">
                                <X size={13} />
                              </button>
                            </div>
                          ))}
                        </div>

                        {/* Add department input */}
                        <div className="flex items-center gap-2">
                          <input type="text" value={deptRoutingInput}
                            onChange={e => setDeptRoutingInput(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                const val = deptRoutingInput.trim();
                                if (val && !deptRoutingItems.find(d => d.name.toLowerCase() === val.toLowerCase())) {
                                  setDeptRoutingItems(prev => [...prev, { name: val, boardKey: '', employees: [] }]);
                                  setDeptRoutingInput('');
                                }
                              }
                            }}
                            placeholder="Department name (e.g. Migration Engineers, Dev, QA)"
                            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <button type="button"
                            onClick={() => {
                              const val = deptRoutingInput.trim();
                              if (val && !deptRoutingItems.find(d => d.name.toLowerCase() === val.toLowerCase())) {
                                setDeptRoutingItems(prev => [...prev, { name: val, boardKey: '', employees: [] }]);
                                setDeptRoutingInput('');
                              }
                            }}
                            className="flex items-center gap-1 px-3 py-2 text-sm font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md border border-blue-200 transition-colors">
                            <Plus size={13} /> Add
                          </button>
                        </div>
                        {deptRoutingItems.length === 0 && (
                          <p className="text-xs text-red-400 mt-1.5">Add at least one department</p>
                        )}
                      </div>
                    )}

                    <div className="flex justify-end gap-2 pt-1">
                      <button type="button" onClick={() => setShowCreateField(false)}
                        className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                        Cancel
                      </button>
                      <button type="submit"
                        disabled={isCreatingField || !createFieldType || !createFieldName || (needsOptions && validOptions.length === 0) || (isDeptRouting && deptRoutingItems.length === 0)}
                        className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5">
                        {isCreatingField && <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                        {isCreatingField ? 'Creating…' : 'Create'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </>
          )}

          {/* ── Field Configurations ── */}
          {workTab === 'field-config' && (
            <div>
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h1 className="text-xl font-bold text-gray-900">Field configurations</h1>
                  <p className="text-sm text-gray-500 mt-0.5">Define which fields appear on each issue type</p>
                </div>
                <button className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors">
                  <Plus size={14} /> Add configuration
                </button>
              </div>
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="border-b border-gray-200 bg-gray-50">
                    <tr>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Configuration name</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Issue types</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Fields</th>
                      <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {[
                      { name: 'Default Field Configuration', types: ['Epic', 'Story', 'Task', 'Bug', 'Sub-task'], fields: 13 },
                      { name: 'Service Desk Configuration',  types: ['Incident', 'Request'],                      fields: 10 },
                      { name: 'Bug Configuration',           types: ['Bug'],                                       fields: 8  },
                    ].map((cfg, i) => (
                      <tr key={i} className="hover:bg-gray-50 transition-colors">
                        <td className="px-5 py-3 text-sm font-medium text-blue-600 hover:underline cursor-pointer">{cfg.name}</td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {cfg.types.map(t => (
                              <span key={t} className="text-[11px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-medium">{t}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-600">{cfg.fields} fields</td>
                        <td className="px-5 py-3 text-right">
                          <button className="text-xs text-blue-600 hover:text-blue-700 font-medium hover:underline">Configure</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Screens ── */}
          {workTab === 'screens' && (
            <div>
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h1 className="text-xl font-bold text-gray-900">Screens</h1>
                  <p className="text-sm text-gray-500 mt-0.5">Screens define which fields appear when creating, editing, or transitioning issues</p>
                </div>
                <button className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors">
                  <Plus size={14} /> Add screen
                </button>
              </div>
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="border-b border-gray-200 bg-gray-50">
                    <tr>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Screen name</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Usage</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Fields</th>
                      <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {SCREENS.map((sc, i) => (
                      <tr key={i} className="hover:bg-gray-50 transition-colors">
                        <td className="px-5 py-3 text-sm font-medium text-blue-600 hover:underline cursor-pointer">{sc.name}</td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {sc.usage.split(', ').map(u => (
                              <span key={u} className="text-[11px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{u}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-600">{sc.fields} fields</td>
                        <td className="px-5 py-3 text-right">
                          <button className="text-xs text-blue-600 hover:text-blue-700 font-medium hover:underline">Edit</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Workflows ── */}
          {workTab === 'workflows' && (
            <div>
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h1 className="text-xl font-bold text-gray-900">Workflows</h1>
                  <p className="text-sm text-gray-500 mt-0.5">Workflows define the lifecycle of issues across your boards</p>
                </div>
              </div>
              <div className="space-y-4">
                {spaces.map((sp, i) => {
                  const wfType = sp.type as string;
                  const meta = WORKFLOW_TYPES[wfType] || { color: 'bg-gray-100 text-gray-500', label: wfType };
                  const statuses = WORKFLOW_STATUSES[wfType] || ['To Do', 'In Progress', 'Done'];
                  return (
                    <div key={sp.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                      {/* Header */}
                      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                            {sp.key?.slice(0, 2)}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{sp.name}</p>
                            <p className="text-xs text-gray-400">Board: <span className="font-medium text-gray-600">{sp.key}</span></p>
                          </div>
                        </div>
                        <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${meta.color}`}>{meta.label}</span>
                      </div>
                      {/* Workflow steps */}
                      <div className="px-5 py-4">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Workflow statuses</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {statuses.map((s, idx) => (
                            <div key={s} className="flex items-center gap-2">
                              <span className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${
                                idx === 0 ? 'bg-gray-50 text-gray-600 border-gray-200' :
                                idx === statuses.length - 1 ? 'bg-green-50 text-green-700 border-green-200' :
                                'bg-blue-50 text-blue-700 border-blue-200'
                              }`}>{s}</span>
                              {idx < statuses.length - 1 && (
                                <ChevronRight size={13} className="text-gray-300 flex-shrink-0" />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {spaces.length === 0 && (
                  <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400">
                    <Zap size={32} className="mx-auto mb-2 text-gray-300" />
                    <p className="text-sm">No spaces found. Create a space to see its workflow here.</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Marketplace
  if (view === 'marketplace') {
    return (
      <SubPage title="Marketplace apps">
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Box size={28} className="text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Marketplace coming soon</h3>
          <p className="text-sm text-gray-500 max-w-md mx-auto">Browse and install apps to extend CloudFuze functionality. Integrations with Slack, GitHub, Confluence, and more will be available here.</p>
        </div>
      </SubPage>
    );
  }

  // Operations
  if (view === 'operations') {
    return (
      <SubPage title="Operations">
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">SLA Policies</h3>
              <p className="text-xs text-gray-500 mt-0.5">Service level agreements for service desk spaces</p>
            </div>
            {['High Priority SLA - 4 hours', 'Medium Priority SLA - 8 hours', 'Low Priority SLA - 24 hours'].map((sla, idx) => (
              <div key={idx} className={`flex items-center justify-between px-6 py-3.5 ${idx > 0 ? 'border-t border-gray-50' : ''}`}>
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                  <span className="text-sm text-gray-900">{sla}</span>
                </div>
                <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Active</span>
              </div>
            ))}
          </div>

          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Incident Management</h3>
            </div>
            <div className="px-6 py-8 text-center text-sm text-gray-500">
              No active incidents. All systems operational.
            </div>
          </div>
        </div>
      </SubPage>
    );
  }

  // User Management — admin/owner only
  if (view === 'users') {
    if (!isPrivileged) return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-center">
        <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center"><Shield size={28} className="text-red-400" /></div>
        <h2 className="text-lg font-semibold text-gray-800">Access Restricted</h2>
        <p className="text-sm text-gray-500 max-w-xs">You don't have permission to manage users. Contact your admin.</p>
      </div>
    );
    const ROLE_LABELS = ALL_ROLE_LABELS;
    const ROLE_COLORS = ALL_ROLE_COLORS;
    const AVATAR_COLORS = ['bg-blue-500','bg-purple-500','bg-emerald-500','bg-orange-500','bg-pink-500','bg-indigo-500'];
    const avatarColor = (id: string) => AVATAR_COLORS[id.charCodeAt(0) % AVATAR_COLORS.length];

    const filteredUsers = users.filter(u => {
      const name = `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase();
      const matchSearch = !userSearch || name.includes(userSearch.toLowerCase());
      const matchRole = !userRoleFilter || u.role === userRoleFilter;
      const matchStatus = !userStatusFilter || (userStatusFilter === 'active' ? u.isActive !== false : u.isActive === false);
      return matchSearch && matchRole && matchStatus;
    });

    const handleInvite = async (e: React.FormEvent) => {
      e.preventDefault();
      setInviting(true);
      try {
        // Create user in DB
        await api.createUser(inviteForm);

        // Send invite email via Microsoft 365 SMTP
        try {
          const currentUser = useStore.getState().user;
          await fetch('/api/users/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email:      inviteForm.email,
              firstName:  inviteForm.firstName,
              lastName:   inviteForm.lastName,
              role:       inviteForm.role,
              invitedBy:  currentUser ? `${currentUser.firstName} ${currentUser.lastName}`.trim() : 'Admin',
            }),
          });
        } catch { /* email sending failure should not block user creation */ }

        setInviteForm({ email: '', firstName: '', lastName: '', role: 'developer', password: 'changeme123' });
        setShowInviteModal(false);
        loadUsers();
        setMessage('User invited successfully — invite email sent to ' + inviteForm.email);
        setTimeout(() => setMessage(''), 5000);
      } catch (err: any) { setMessage(err.message); }
      setInviting(false);
    };

    const activeCount = users.filter(u => u.isActive !== false).length;

    return (
      <div className="max-w-[900px] mx-auto px-6 py-6">
        {/* Page header */}
        <button onClick={() => navigate('main')} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mb-5">
          <ArrowLeft size={14} /> Back to settings
        </button>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">User Management</h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage users, groups and access requests</p>
          </div>
          <button onClick={() => setShowInviteModal(true)}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-md transition-colors">
            <UserPlus size={14} /> Invite user
          </button>
        </div>

        {/* Delete user confirm modal */}
        {deleteConfirmUser && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
            onClick={() => { if (!deletingUser) setDeleteConfirmUser(null); }}>
            <div className="w-[400px] rounded-xl bg-white shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200">
                <div className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                  <Trash2 size={16} className="text-red-600" />
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold text-gray-900">Delete user</h3>
                  <p className="text-[12px] text-gray-500">This action cannot be undone</p>
                </div>
              </div>
              <div className="px-5 py-4">
                <p className="text-[13px] text-gray-700">
                  Are you sure you want to permanently delete <span className="font-semibold">{deleteConfirmUser.firstName} {deleteConfirmUser.lastName}</span>?
                </p>
                <p className="text-[12px] text-gray-500 mt-1.5">
                  Email: <span className="font-medium">{deleteConfirmUser.email}</span>
                </p>
                <p className="text-[12px] text-red-500 mt-2">
                  This will remove the user from all boards and delete their account permanently.
                </p>
              </div>
              <div className="flex justify-end gap-3 px-5 py-3 bg-gray-50 border-t border-gray-100">
                <button onClick={() => setDeleteConfirmUser(null)} disabled={deletingUser}
                  className="rounded-md border border-gray-300 px-4 py-2 text-[12.5px] font-medium text-gray-700 hover:bg-white transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button
                  disabled={deletingUser}
                  onClick={async () => {
                    setDeletingUser(true);
                    try {
                      await api.deleteUser(deleteConfirmUser.id);
                      setUsers(prev => prev.filter((u: any) => u.id !== deleteConfirmUser.id));
                      setDeleteConfirmUser(null);
                    } catch (err: any) {
                      alert(err?.message || 'Failed to delete user');
                    } finally {
                      setDeletingUser(false);
                    }
                  }}
                  className="rounded-md bg-red-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-red-700 disabled:opacity-60 transition-colors flex items-center gap-2">
                  {deletingUser ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Trash2 size={13} />}
                  {deletingUser ? 'Deleting…' : 'Delete permanently'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Resend invite toast */}
        {resendToast && (
          <div className={`mb-4 px-4 py-2.5 rounded-lg border text-sm flex items-center gap-2 ${resendToast.ok ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {resendToast.ok ? <Check size={14} /> : <X size={14} />} {resendToast.msg}
          </div>
        )}

        {message && (
          <div className="mb-4 px-4 py-2.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
            <Check size={14} /> {message}
          </div>
        )}

        {/* Tabs */}
        <div className="border-b border-gray-200 mb-5">
          <div className="flex items-center gap-0">
            {[
              { id: 'users', label: 'Users' },
              { id: 'groups', label: 'Groups' },
              { id: 'access', label: 'Access requests' },
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveUserTab(tab.id as any)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeUserTab === tab.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {activeUserTab === 'users' && (
          <>
            {/* Filters */}
            <div className="flex items-center gap-2 mb-4">
              <div className="relative flex-1 max-w-xs">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input type="text" value={userSearch} onChange={e => setUserSearch(e.target.value)}
                  placeholder="Search by name or email"
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" />
              </div>
              {/* Role filter */}
              <div className="relative">
                <button onClick={() => setOpenUserMenu(openUserMenu === '__role__' ? null : '__role__')}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md bg-white transition-colors ${userRoleFilter ? 'border-blue-400 text-blue-700 bg-blue-50' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  <Filter size={13} className={userRoleFilter ? 'text-blue-500' : 'text-gray-400'} />
                  {userRoleFilter ? ROLE_LABELS[userRoleFilter] : 'Role'}
                  <ChevronDown size={13} className="text-gray-400" />
                </button>
                {openUserMenu === '__role__' && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpenUserMenu(null)} />
                    <div className="absolute left-0 top-full mt-1 w-40 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                      {[{ val: '', label: 'All roles' }, ...SELECTABLE_ROLES.map(val => ({ val, label: ROLE_LABELS[val] }))].map(item => (
                        <button key={item.val} onClick={() => { setUserRoleFilter(item.val); setOpenUserMenu(null); }}
                          className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${userRoleFilter === item.val ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                          {item.label}
                          {userRoleFilter === item.val && <Check size={13} className="text-blue-600" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* Status filter */}
              <div className="relative">
                <button onClick={() => setOpenUserMenu(openUserMenu === '__status__' ? null : '__status__')}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md bg-white transition-colors ${userStatusFilter ? 'border-blue-400 text-blue-700 bg-blue-50' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  <Filter size={13} className={userStatusFilter ? 'text-blue-500' : 'text-gray-400'} />
                  {userStatusFilter === 'active' ? 'Active' : userStatusFilter === 'inactive' ? 'Inactive' : 'Status'}
                  <ChevronDown size={13} className="text-gray-400" />
                </button>
                {openUserMenu === '__status__' && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpenUserMenu(null)} />
                    <div className="absolute left-0 top-full mt-1 w-36 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                      {[{ val: '', label: 'All status' }, { val: 'active', label: 'Active' }, { val: 'inactive', label: 'Inactive' }].map(item => (
                        <button key={item.val} onClick={() => { setUserStatusFilter(item.val); setOpenUserMenu(null); }}
                          className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${userStatusFilter === item.val ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                          {item.label}
                          {userStatusFilter === item.val && <Check size={13} className="text-blue-600" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button onClick={() => loadUsers()} disabled={usersLoading} className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50" title="Refresh">
                <RefreshCw size={13} className={usersLoading ? 'animate-spin' : ''} />
              </button>
              <SyncMsPhotosButton onDone={() => loadUsers()} />
            </div>

            <p className="text-xs text-gray-500 mb-3">
              {usersLoading ? 'Loading users…' : `Showing ${filteredUsers.length} of ${users.length} users`}
            </p>

            {/* Table */}
            <div className="bg-white border border-gray-200 rounded-lg overflow-visible">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider w-[220px]">Name</th>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Email</th>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider w-[160px]">Role</th>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider w-[100px]">Status</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-gray-400 uppercase tracking-wider w-[80px]">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredUsers.map(u => (
                    <tr key={u.id} className="hover:bg-gray-50 transition-colors group">
                      <td className="px-4 py-2.5 w-[220px]">
                        <button className="flex items-center gap-2.5 text-left w-full min-w-0" onClick={() => setSelectedUser(u)}>
                          <div className={`w-7 h-7 rounded-full flex-shrink-0 overflow-hidden ${(u as any).avatarUrl ? '' : `${avatarColor(u.id)} flex items-center justify-center`}`}>
                            {(u as any).avatarUrl
                              ? <img src={(u as any).avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                              : <span className="text-white text-[11px] font-semibold">{getInitials(u.firstName, u.lastName)}</span>
                            }
                          </div>
                          <span className="text-sm font-medium text-gray-900 hover:text-blue-600 transition-colors truncate">{u.firstName} {u.lastName}</span>
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-500 max-w-0"><span className="block truncate">{u.email}</span></td>
                      <td className="px-4 py-2.5 w-[160px]">
                        <div className="relative inline-block">
                          <button
                            onClick={(e) => {
                              if (openUserMenu === u.id) { setOpenUserMenu(null); setRoleMenuPos(null); return; }
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setRoleMenuPos({ top: rect.bottom + 4, left: rect.left });
                              setOpenUserMenu(u.id);
                            }}
                            className="flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900 group/role">
                            {ROLE_LABELS[u.role] || u.role}
                            <ChevronDown size={12} className="text-gray-400 group-hover/role:text-gray-600" />
                          </button>
                          {openUserMenu === u.id && roleMenuPos && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => { setOpenUserMenu(null); setRoleMenuPos(null); }} />
                              <div className="fixed w-52 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50"
                                style={{ top: roleMenuPos.top, left: roleMenuPos.left }}>
                                {SELECTABLE_ROLES.map((val) => (
                                  <button key={val} onClick={() => { handleRoleChange(u.id, val); setOpenUserMenu(null); setRoleMenuPos(null); }}
                                    className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${u.role === val ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                                    <span className="flex items-center gap-2">
                                      <span className={`inline-block w-2 h-2 rounded-full ${ROLE_COLORS[val]?.split(' ')[0] || 'bg-gray-300'}`} />
                                      {ROLE_LABELS[val]}
                                    </span>
                                    {u.role === val && <Check size={12} className="text-blue-600" />}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 w-[100px] whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${u.isActive !== false ? 'text-green-600' : 'text-gray-400'}`}>
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${u.isActive !== false ? 'bg-green-500' : 'bg-gray-400'}`} />
                          {u.isActive !== false ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 w-[80px] text-right whitespace-nowrap">
                        <div className="flex items-center justify-end">
                        <div className="relative inline-block">
                          <button
                            onClick={(e) => {
                              const key = `${u.id}_action`;
                              if (openUserMenu === key) { setOpenUserMenu(null); setRoleMenuPos(null); return; }
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setRoleMenuPos({ top: rect.bottom + 4, left: rect.right - 176 });
                              setOpenUserMenu(key);
                            }}
                            className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                            <MoreHorizontal size={15} />
                          </button>
                          {openUserMenu === `${u.id}_action` && roleMenuPos && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => { setOpenUserMenu(null); setRoleMenuPos(null); }} />
                              <div className="fixed w-48 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50"
                                style={{ top: roleMenuPos.top, left: roleMenuPos.left }}>
                                <button onClick={() => { setSelectedUser(u); setOpenUserMenu(null); setRoleMenuPos(null); }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                                  <User size={13} className="text-gray-400" /> View profile
                                </button>
                                <button
                                  disabled={resendingUserId === u.id}
                                  onClick={async () => {
                                    setOpenUserMenu(null); setRoleMenuPos(null);
                                    setResendingUserId(u.id);
                                    try {
                                      const appUrl = window.location.origin;
                                      const res = await fetch('/api/users/invite', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                          email: u.email,
                                          firstName: u.firstName || '',
                                          lastName: u.lastName || '',
                                          role: u.role || 'developer',
                                          invitedBy: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
                                        }),
                                      });
                                      const data = await res.json();
                                      setResendToast(data.emailSent ? { msg: `Invite resent to ${u.email}`, ok: true } : { msg: `Could not send email to ${u.email}`, ok: false });
                                    } catch {
                                      setResendToast({ msg: 'Failed to resend invite', ok: false });
                                    } finally {
                                      setResendingUserId(null);
                                      setTimeout(() => setResendToast(null), 4000);
                                    }
                                  }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-50">
                                  <RefreshCw size={13} className={resendingUserId === u.id ? 'animate-spin' : ''} />
                                  {resendingUserId === u.id ? 'Sending…' : 'Resend invite'}
                                </button>
                                <div className="my-1 h-px bg-gray-100" />
                                <button onClick={() => { handleToggleActive(u.id, u.isActive !== false); setOpenUserMenu(null); setRoleMenuPos(null); }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 transition-colors text-red-600">
                                  {u.isActive !== false ? <UserX size={13} /> : <UserCheck size={13} className="text-green-600" />}
                                  {u.isActive !== false ? 'Deactivate user' : 'Activate user'}
                                </button>
                                <button onClick={() => { setDeleteConfirmUser(u); setOpenUserMenu(null); setRoleMenuPos(null); }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-red-50 transition-colors text-red-700 font-medium">
                                  <Trash2 size={13} /> Delete user
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {usersLoading ? (
                <div className="py-12 text-center">
                  <div className="inline-block w-6 h-6 border-2 border-gray-200 border-t-blue-500 rounded-full animate-spin mb-3" />
                  <p className="text-sm text-gray-400">Loading users…</p>
                </div>
              ) : filteredUsers.length === 0 ? (
                <div className="py-12 text-center text-sm text-gray-400">No users found</div>
              ) : null}
            </div>
          </>
        )}

        {activeUserTab === 'groups' && (
          <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
            <Users size={28} className="text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">No groups configured</p>
            <p className="text-xs text-gray-400 mt-1">Groups help manage permissions at scale</p>
          </div>
        )}

        {activeUserTab === 'access' && (
          <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
            <UserPlus size={28} className="text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">No pending access requests</p>
            <p className="text-xs text-gray-400 mt-1">New access requests will appear here</p>
          </div>
        )}

        {/* Invite Modal */}
        {showInviteModal && (
          <>
            <div className="fixed inset-0 bg-black/40 z-50" onClick={() => setShowInviteModal(false)} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-lg shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
                  <h2 className="text-base font-semibold text-gray-900">Invite user</h2>
                  <button onClick={() => setShowInviteModal(false)} className="w-7 h-7 rounded hover:bg-gray-100 flex items-center justify-center text-gray-400">
                    <X size={15} />
                  </button>
                </div>
                <form onSubmit={handleInvite} className="p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">First name</label>
                      <input type="text" value={inviteForm.firstName} onChange={e => setInviteForm(f => ({ ...f, firstName: e.target.value }))}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" required />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Last name</label>
                      <input type="text" value={inviteForm.lastName} onChange={e => setInviteForm(f => ({ ...f, lastName: e.target.value }))}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" required />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                    <input type="email" value={inviteForm.email} onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" required />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
                    <select value={inviteForm.role} onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white">
                      {SELECTABLE_ROLES.map(val => (
                        <option key={val} value={val}>{ROLE_LABELS[val]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={() => setShowInviteModal(false)}
                      className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md transition-colors">
                      Cancel
                    </button>
                    <button type="submit" disabled={inviting}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors">
                      {inviting ? 'Inviting...' : <><UserPlus size={13} /> Invite user</>}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </>
        )}

        {/* ── User Detail Drawer ───────────────────────────────────────────── */}
        {selectedUser && (() => {
          const u = selectedUser;
          const initials = getInitials(u.firstName, u.lastName);
          const color = (['bg-blue-500','bg-purple-500','bg-emerald-500','bg-orange-500','bg-pink-500','bg-indigo-500'])[u.id?.charCodeAt(0) % 6];
          return (
            <>
              {/* backdrop */}
              <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setSelectedUser(null)} />
              {/* drawer */}
              <div className="fixed right-0 top-0 h-full w-[380px] bg-white shadow-2xl z-50 flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-800">User profile</h2>
                  <button onClick={() => setSelectedUser(null)} className="w-7 h-7 rounded-md hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600">
                    <X size={15} />
                  </button>
                </div>

                {/* Profile */}
                <div className="px-5 py-6 border-b border-gray-100 flex items-center gap-4">
                  <div className={`w-14 h-14 rounded-full flex-shrink-0 overflow-hidden ${(u as any).avatarUrl ? '' : `${color} flex items-center justify-center`}`}>
                    {(u as any).avatarUrl
                      ? <img src={(u as any).avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                      : <span className="text-white text-lg font-bold">{initials}</span>
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-bold text-gray-900 truncate">{u.firstName} {u.lastName}</p>
                    <p className="text-sm text-gray-500 truncate">{u.email}</p>
                    <span className={`inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${ROLE_COLORS[u.role] || 'bg-gray-100 text-gray-600'}`}>
                      {ROLE_LABELS[u.role] || u.role}
                    </span>
                  </div>
                </div>

                {/* Details */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                  {/* Status */}
                  <div className="flex items-center justify-between py-3 border-b border-gray-50">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Status</span>
                    <span className={`flex items-center gap-1.5 text-sm font-medium ${u.isActive !== false ? 'text-green-600' : 'text-gray-400'}`}>
                      <span className={`w-2 h-2 rounded-full ${u.isActive !== false ? 'bg-green-500' : 'bg-gray-400'}`} />
                      {u.isActive !== false ? 'Active' : 'Inactive'}
                    </span>
                  </div>

                  {/* Role */}
                  <div className="flex items-center justify-between py-3 border-b border-gray-50">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Role</span>
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          if (openUserMenu === `drawer_${u.id}`) { setOpenUserMenu(null); setRoleMenuPos(null); return; }
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setRoleMenuPos({ top: rect.bottom + 4, left: rect.left - 80 });
                          setOpenUserMenu(`drawer_${u.id}`);
                        }}
                        className="flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors">
                        {ROLE_LABELS[u.role] || u.role}
                        <ChevronDown size={13} className="text-gray-400" />
                      </button>
                      {openUserMenu === `drawer_${u.id}` && roleMenuPos && (
                        <>
                          <div className="fixed inset-0 z-[60]" onClick={() => { setOpenUserMenu(null); setRoleMenuPos(null); }} />
                          <div className="fixed w-52 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-[70]"
                            style={{ top: roleMenuPos.top, left: roleMenuPos.left }}>
                            {SELECTABLE_ROLES.map((val) => (
                              <button key={val} onClick={() => {
                                handleRoleChange(u.id, val);
                                setSelectedUser({ ...u, role: val });
                                setOpenUserMenu(null); setRoleMenuPos(null);
                              }}
                                className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${u.role === val ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                                <span className="flex items-center gap-2">
                                  <span className={`inline-block w-2 h-2 rounded-full ${ROLE_COLORS[val]?.split(' ')[0] || 'bg-gray-300'}`} />
                                  {ROLE_LABELS[val]}
                                </span>
                                {u.role === val && <Check size={12} className="text-blue-600" />}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Email */}
                  <div className="py-3 border-b border-gray-50">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide block mb-1">Email</span>
                    <span className="text-sm text-gray-700 break-all">{u.email}</span>
                  </div>

                  {/* Member since */}
                  {u.createdAt && (
                    <div className="py-3 border-b border-gray-50">
                      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide block mb-1">Member since</span>
                      <span className="text-sm text-gray-700">{new Date(u.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                    </div>
                  )}
                </div>

                {/* Footer actions */}
                <div className="px-5 py-4 border-t border-gray-100 flex gap-2">
                  <button
                    onClick={() => { handleToggleActive(u.id, u.isActive !== false); setSelectedUser({ ...u, isActive: u.isActive === false }); }}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${u.isActive !== false ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-green-200 text-green-600 hover:bg-green-50'}`}>
                    {u.isActive !== false ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await fetch('/api/users/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role,
                            invitedBy: `${user?.firstName} ${user?.lastName}`.trim() }) });
                        setMessage(`Invite resent to ${u.email}`);
                        setTimeout(() => setMessage(''), 4000);
                      } catch { setMessage('Failed to resend invite'); }
                    }}
                    className="flex-1 py-2 rounded-lg text-sm font-medium border border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors">
                    Resend invite
                  </button>
                </div>
              </div>
            </>
          );
        })()}
      </div>
    );
  }

  // Billing
  if (view === 'billing') {
    return (
      <SubPage title="Billing">
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Current Plan</h3>
                <p className="text-xs text-gray-500 mt-0.5">Your current subscription details</p>
              </div>
              <span className="text-xs font-semibold text-blue-700 bg-blue-50 px-3 py-1 rounded-full">Free Plan</span>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-2xl font-bold text-gray-900">{users.length}</p>
                <p className="text-xs text-gray-500 mt-0.5">Users</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-2xl font-bold text-gray-900">{spaces.length}</p>
                <p className="text-xs text-gray-500 mt-0.5">Spaces</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-2xl font-bold text-gray-900">Unlimited</p>
                <p className="text-xs text-gray-500 mt-0.5">Issues</p>
              </div>
            </div>
          </div>
          <div className="p-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Features included</h3>
            <div className="grid grid-cols-2 gap-2">
              {['Unlimited issues', 'Scrum & Kanban boards', 'Sprint management', 'SLA tracking', 'Automation engine', 'JQL search', 'Reports & dashboards', 'File attachments', 'Role-based access', 'WebSocket real-time updates'].map((feature, idx) => (
                <div key={idx} className="flex items-center gap-2 text-sm text-gray-700">
                  <Check size={14} className="text-green-500 flex-shrink-0" /> {feature}
                </div>
              ))}
            </div>
          </div>
        </div>
      </SubPage>
    );
  }

  // Sites
  if (view === 'sites') {
    const handleAddSite = () => {
      const name = newSiteName.trim();
      const domain = newSiteDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!name || !domain) return;
      const id = `site_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
      const supportEmail = `support@${domain}`;
      setSites(prev => [...prev, { id, name, domain, supportEmail }]);
      setNewSiteName('');
      setNewSiteDomain('');
      setShowAddSite(false);
    };

    return (
      <SubPage title="Sites">
        {/* Organization header */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6 flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
            N
          </div>
          <div className="flex-1">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Organization</p>
            <p className="text-base font-bold text-gray-900">Neutara Technologies Ticketing</p>
          </div>
          <span className="text-xs font-semibold bg-green-50 text-green-700 border border-green-200 px-3 py-1 rounded-full">Active</span>
        </div>

        {/* Sign-in URL config */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-800 mb-0.5">Sign-in URL</p>
              <p className="text-xs text-gray-500 mb-3">This URL is included in invite emails so users know where to log in. Update it before going live.</p>
              {appUrlEditing ? (
                <div className="flex items-center gap-2">
                  <input
                    value={appUrlDraft}
                    onChange={e => setAppUrlDraft(e.target.value)}
                    placeholder="https://your-domain.com"
                    className="flex-1 border border-blue-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                  <button
                    disabled={appUrlSaving}
                    onClick={async () => {
                      const val = appUrlDraft.trim().replace(/\/$/, '');
                      if (!val) return;
                      setAppUrlSaving(true);
                      try {
                        await fetch('/api/app-settings', {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ app_url: val }),
                        });
                        setAppUrl(val);
                        setAppUrlEditing(false);
                        setMessage('Sign-in URL updated — new invite emails will use this URL.');
                        setTimeout(() => setMessage(''), 4000);
                      } catch { /* ignore */ }
                      setAppUrlSaving(false);
                    }}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-md disabled:opacity-50 transition-colors">
                    {appUrlSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => setAppUrlEditing(false)}
                    className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-md transition-colors">
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <code className="text-sm text-blue-700 bg-blue-50 border border-blue-100 rounded-md px-3 py-1.5 font-mono break-all">{appUrl || '—'}</code>
                  <button
                    onClick={() => { setAppUrlDraft(appUrl); setAppUrlEditing(true); }}
                    className="flex-shrink-0 px-3 py-1.5 text-sm font-semibold text-blue-600 border border-blue-200 hover:bg-blue-50 rounded-md transition-colors">
                    Change
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sites list */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-bold text-gray-800">Sites</h2>
            <p className="text-xs text-gray-500 mt-0.5">Each site has its own domain and auto-generated support email address</p>
          </div>
          <button onClick={() => setShowAddSite(true)}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors">
            <Plus size={14} /> Add site
          </button>
        </div>

        <div className="space-y-3">
          {sites.map(site => (
            <div key={site.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {/* Site header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-teal-400 to-blue-500 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                    {site.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-gray-900">{site.name}</p>
                      {site.isDefault && (
                        <span className="text-[10px] font-semibold bg-blue-50 text-blue-600 border border-blue-200 px-2 py-0.5 rounded-full">Default</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{site.domain}</p>
                  </div>
                </div>
                {!site.isDefault && (
                  <button onClick={() => setSiteDeleteConfirm(site.id)}
                    className="w-7 h-7 rounded-md hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-400 transition-colors">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              {/* Site details */}
              <div className="px-5 py-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Site domain</p>
                  <div className="flex items-center gap-2">
                    <Globe size={13} className="text-teal-500 flex-shrink-0" />
                    <span className="text-sm font-medium text-gray-700">{site.domain}</span>
                  </div>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Support email domain</p>
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded bg-teal-50 flex items-center justify-center flex-shrink-0">
                      <span className="text-[10px] font-bold text-teal-600">@</span>
                    </div>
                    <span className="text-sm font-medium text-gray-700">{site.supportEmail}</span>
                  </div>
                </div>
              </div>

              {/* Email pattern info */}
              <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
                <p className="text-xs text-gray-500">
                  Service management spaces created under this site will use{' '}
                  <span className="font-semibold text-gray-700">@support.{site.domain}</span>{' '}
                  as their incoming email domain.
                </p>
              </div>

              {/* Spaces under this site */}
              {(() => {
                const siteSpaces = spaces;
                if (siteSpaces.length === 0) return null;
                return (
                  <div className="px-5 py-3 border-t border-gray-100">
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Service management spaces</p>
                    <div className="flex flex-wrap gap-2">
                      {siteSpaces.map(sp => (
                        <div key={sp.key} className="flex items-center gap-1.5 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
                          <div className="w-5 h-5 rounded bg-blue-500 flex items-center justify-center">
                            <span className="text-[9px] font-bold text-white">{sp.key?.slice(0,2)}</span>
                          </div>
                          <span className="text-xs font-semibold text-gray-700">{sp.name || sp.key}</span>
                          <span className="text-[10px] text-gray-400 font-mono ml-1">{sp.key?.toLowerCase()}@support.{site.domain}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          ))}
        </div>

        {/* Add site modal */}
        {showAddSite && (
          <>
            <div className="fixed inset-0 bg-black/40 z-50" onClick={() => { setShowAddSite(false); setNewSiteName(''); setNewSiteDomain(''); }} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                  <div>
                    <h2 className="text-base font-bold text-gray-900">Add new site</h2>
                    <p className="text-xs text-gray-500 mt-0.5">A support email address will be auto-generated from the domain</p>
                  </div>
                  <button onClick={() => { setShowAddSite(false); setNewSiteName(''); setNewSiteDomain(''); }}
                    className="w-7 h-7 rounded-md hover:bg-gray-100 flex items-center justify-center text-gray-400">
                    <X size={15} />
                  </button>
                </div>
                <div className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                      Site name <span className="text-red-500">*</span>
                    </label>
                    <input type="text" value={newSiteName} onChange={e => setNewSiteName(e.target.value)}
                      placeholder="e.g. mycompany"
                      className="w-full border border-gray-300 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                      Domain <span className="text-red-500">*</span>
                    </label>
                    <input type="text" value={newSiteDomain} onChange={e => setNewSiteDomain(e.target.value)}
                      placeholder="e.g. mycompany.com"
                      className="w-full border border-gray-300 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400" />
                    {newSiteDomain.trim() && (
                      <div className="mt-2 flex items-center gap-2 bg-teal-50 border border-teal-200 rounded-md px-3 py-2">
                        <span className="text-xs text-teal-600 font-medium">Support email will be:</span>
                        <span className="text-xs font-bold text-teal-800">support@{newSiteDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => { setShowAddSite(false); setNewSiteName(''); setNewSiteDomain(''); }}
                      className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                      Cancel
                    </button>
                    <button onClick={handleAddSite} disabled={!newSiteName.trim() || !newSiteDomain.trim()}
                      className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                      Add site
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Delete confirm modal */}
        {siteDeleteConfirm && (
          <>
            <div className="fixed inset-0 bg-black/40 z-50" onClick={() => setSiteDeleteConfirm(null)} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
                <h3 className="text-base font-bold text-gray-900 mb-2">Remove site?</h3>
                <p className="text-sm text-gray-500 mb-5">
                  This will remove the site and its support email domain. Spaces using this site will no longer have an associated email address.
                </p>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setSiteDeleteConfirm(null)}
                    className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                    Cancel
                  </button>
                  <button onClick={() => { setSites(prev => prev.filter(s => s.id !== siteDeleteConfirm)); setSiteDeleteConfirm(null); }}
                    className="px-4 py-2 text-sm font-semibold bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors">
                    Remove
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </SubPage>
    );
  }

  // Permissions — role matrix (admin/owner only)
  if (view === 'permissions') {
    if (!isPrivileged) return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-center">
        <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center"><Shield size={28} className="text-red-400" /></div>
        <h2 className="text-lg font-semibold text-gray-800">Access Restricted</h2>
        <p className="text-sm text-gray-500 max-w-xs">You don't have permission to view access settings. Contact your admin.</p>
      </div>
    );

    const displayRoles = ['admin', 'manager', 'migration_engineer', 'account_manager', 'qa_engineer', 'hr', 'developer', 'viewer'] as const;
    const permRows: { label: string; key: keyof Permissions }[] = [
      { label: 'Access Settings',        key: 'accessSettings' },
      { label: 'Manage Users',           key: 'manageUsers' },
      { label: 'Manage Spaces / Boards', key: 'manageSpaces' },
      { label: 'Manage Workflows & SLA', key: 'manageWorkItems' },
      { label: 'View Billing',           key: 'viewBilling' },
      { label: 'View System Logs',       key: 'viewSystemLogs' },
      { label: 'Create Issues',          key: 'createIssues' },
      { label: 'Edit Any Issue',         key: 'editAnyIssue' },
      { label: 'Edit Own Issues',        key: 'editOwnIssue' },
      { label: 'Delete Issues',          key: 'deleteIssues' },
      { label: 'Change Status',          key: 'transitionIssues' },
      { label: 'Assign Issues',          key: 'assignIssues' },
      { label: 'Set Priority',           key: 'setPriority' },
      { label: 'Add Comments',           key: 'addComments' },
      { label: 'Manage Comments',        key: 'manageComments' },
      { label: 'View Reports',           key: 'viewReports' },
      { label: 'Export Data',            key: 'exportData' },
    ];

    return (
      <SubPage title="Permissions">
        <p className="text-sm text-gray-500 mb-4">Role-based access control — defines what each role can do across the platform.</p>
        <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase sticky left-0 bg-gray-50 z-10 min-w-[200px]">Permission</th>
                {displayRoles.map(r => (
                  <th key={r} className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${ALL_ROLE_COLORS[r] || 'bg-gray-100 text-gray-600'}`}>
                      {ALL_ROLE_LABELS[r]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {permRows.map(({ label, key }, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-5 py-2.5 text-sm font-medium text-gray-800 sticky left-0 bg-white hover:bg-gray-50">{label}</td>
                  {displayRoles.map(r => {
                    const allowed = can(r, key);
                    return (
                      <td key={r} className="px-3 py-2.5 text-center">
                        {allowed
                          ? <Check size={15} className="text-green-500 mx-auto" />
                          : <X size={15} className="text-gray-200 mx-auto" />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SubPage>
    );
  }

  return null;
}

// ── API Tokens View ───────────────────────────────────────────────────────────
function NotificationPrefsView({ navigate }: { navigate: (v: any) => void }) {
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const getAuth = () => `Bearer ${localStorage.getItem('jira_token') || ''}`;

  useEffect(() => {
    fetch('/api/notification-preferences', { headers: { Authorization: getAuth() } })
      .then(r => r.json()).then(setPrefs).catch(() => {});
  }, []);

  const toggle = (key: string) => setPrefs(p => p ? { ...p, [key]: !p[key] } : p);

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    await fetch('/api/notification-preferences', {
      method: 'PATCH',
      headers: { Authorization: getAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const rows = [
    { key: 'onAssigned',       title: 'Issue assigned to me',     desc: 'When an issue is assigned to you' },
    { key: 'onCommented',      title: 'Comment added',            desc: 'When someone comments on your issue' },
    { key: 'onStatusChanged',  title: 'Status changed',           desc: 'When an issue you own changes status' },
    { key: 'onMentioned',      title: 'Mentioned in comment',     desc: 'When you are @mentioned in a comment' },
    { key: 'onWatchedUpdated', title: 'Watched issue updated',    desc: 'When an issue you watch is updated' },
    { key: 'onCreated',        title: 'Issue created & assigned', desc: 'When a new issue is assigned to you' },
    { key: 'onUpdated',        title: 'General updates',          desc: 'When summary, priority or type changes on your issue' },
  ];

  return (
    <SubPage title="Notification Preferences">
      <p className="text-sm text-gray-500 -mt-4 mb-6">Choose which in-app notifications you receive</p>
      {!prefs ? (
        <div className="flex justify-center py-10"><div className="w-6 h-6 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" /></div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
            {rows.map(row => (
              <div key={row.key} className="flex items-center justify-between px-6 py-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">{row.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{row.desc}</p>
                </div>
                <button
                  onClick={() => toggle(row.key)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${prefs[row.key] ? 'bg-blue-600' : 'bg-gray-200'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${prefs[row.key] ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center gap-3">
            <button onClick={save} disabled={saving}
              className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save preferences'}
            </button>
            {saved && <span className="text-sm text-green-600 font-medium">✓ Saved</span>}
            <button onClick={() => navigate('main')} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          </div>
        </>
      )}
    </SubPage>
  );
}

function ApiTokensView({ navigate, user }: { navigate: (v: any) => void; user: any }) {
  const [tokens, setTokens] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const getAuth = () => `Bearer ${localStorage.getItem('jira_token') || ''}`;

  const loadTokens = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/api-tokens', { headers: { Authorization: getAuth() } });
      if (res.ok) setTokens(await res.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadTokens(); }, []);

  const handleCreate = async () => {
    if (!newTokenName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/api-tokens', {
        method: 'POST',
        headers: { Authorization: getAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTokenName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setCreatedToken(data.token);
        setNewTokenName('');
        loadTokens();
      }
    } catch {}
    setCreating(false);
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Revoke this token? Any applications using it will lose access.')) return;
    setRevoking(id);
    try {
      await fetch(`/api/api-tokens/${id}`, { method: 'DELETE', headers: { Authorization: getAuth() } });
      setTokens(t => t.filter(x => x.id !== id));
    } catch {}
    setRevoking(null);
  };

  const copyToken = async () => {
    if (!createdToken) return;
    await navigator.clipboard.writeText(createdToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fmtDate = (d: string | null) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  return (
    <div className="max-w-[900px] mx-auto px-6 py-6">
      <button onClick={() => navigate('main')} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mb-5">
        <ArrowLeft size={14} /> Back to settings
      </button>
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-xl font-semibold text-gray-900">API tokens</h1>
        <button
          onClick={() => { setShowModal(true); setCreatedToken(null); setNewTokenName(''); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus size={14} /> Create API token
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-6">API tokens let you authenticate to the Neutara API from scripts and external tools. Treat them like passwords — store them securely.</p>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm gap-2">
            <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" /> Loading…
          </div>
        ) : tokens.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <Zap size={32} className="mb-3 opacity-30" />
            <p className="text-sm font-medium">No API tokens yet</p>
            <p className="text-xs mt-1">Create a token to get started</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_140px_140px_100px_80px] gap-4 px-5 py-3 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              <span>Name</span>
              <span>Created</span>
              <span>Last used</span>
              <span>Prefix</span>
              <span></span>
            </div>
            {tokens.map(tok => (
              <div key={tok.id} className="grid grid-cols-[1fr_140px_140px_100px_80px] gap-4 px-5 py-4 border-b border-gray-100 last:border-0 items-center hover:bg-gray-50 transition-colors">
                <span className="text-sm font-medium text-gray-800">{tok.name}</span>
                <span className="text-sm text-gray-500">{fmtDate(tok.createdAt)}</span>
                <span className="text-sm text-gray-500">{fmtDate(tok.lastUsedAt)}</span>
                <code className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{tok.prefix}…</code>
                <button
                  onClick={() => handleRevoke(tok.id)}
                  disabled={revoking === tok.id}
                  className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-50"
                >
                  {revoking === tok.id ? <div className="w-3 h-3 border border-red-400 border-t-red-600 rounded-full animate-spin" /> : <Trash2 size={13} />}
                  Revoke
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Create modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
            {createdToken ? (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center"><Check size={16} className="text-green-600" /></div>
                  <h2 className="text-base font-semibold text-gray-900">Token created</h2>
                </div>
                <p className="text-sm text-gray-500 mb-4">Copy this token now. <span className="font-semibold text-gray-700">You won't be able to see it again.</span></p>
                <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 mb-5">
                  <code className="flex-1 text-xs font-mono text-gray-800 break-all select-all">{createdToken}</code>
                  <button onClick={copyToken} className="flex-shrink-0 text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1">
                    {copied ? <><Check size={12} /> Copied</> : 'Copy'}
                  </button>
                </div>
                <button
                  onClick={() => { setShowModal(false); setCreatedToken(null); }}
                  className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-semibold text-gray-900">Create API token</h2>
                  <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
                </div>
                <p className="text-sm text-gray-500 mb-4">Give your token a descriptive name so you remember what it's used for.</p>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">Token name</label>
                <input
                  type="text"
                  value={newTokenName}
                  onChange={e => setNewTokenName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  placeholder="e.g. CI/CD pipeline, Local dev"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button onClick={() => setShowModal(false)} className="flex-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg text-gray-700 hover:bg-gray-50 transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={creating || !newTokenName.trim()}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    {creating ? 'Creating…' : 'Create token'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Connectors view ───────────────────────────────────────────────────────────

type ConnectorType = 'webhook' | 'slack' | 'teams';
const CONNECTOR_EVENTS = [
  { id: 'issue.created',           label: 'Issue created' },
  { id: 'issue.updated',           label: 'Issue updated' },
  { id: 'issue.deleted',           label: 'Issue deleted' },
  { id: 'issue.status_changed',    label: 'Status changed' },
  { id: 'issue.assigned',          label: 'Assignee changed' },
  { id: 'issue.commented',         label: 'Comment added' },
  { id: 'issue.department_changed',label: 'Department changed' },
];
const CONNECTOR_TYPES: { type: ConnectorType; label: string; desc: string; icon: React.ReactNode; color: string }[] = [
  { type: 'webhook', label: 'Webhook',          desc: 'Send JSON payloads to any URL on ticket events', icon: <Webhook size={20} />, color: 'bg-violet-50 text-violet-600 border-violet-200' },
  { type: 'slack',   label: 'Slack',            desc: 'Post messages to a Slack channel via incoming webhook', icon: <Slack size={20} />, color: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  { type: 'teams',   label: 'Microsoft Teams',  desc: 'Post adaptive cards to a Teams channel', icon: <Activity size={20} />, color: 'bg-blue-50 text-blue-600 border-blue-200' },
];

interface ConnectorRow { id: string; name: string; type: ConnectorType; config: Record<string,any>; events: string[]; space_ids: string[]; enabled: boolean; created_at: string; }

function ConnectorsView({ navigate }: { navigate: (v: string) => void }) {
  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ connId: string; rows: any[] } | null>(null);
  const [testMsg, setTestMsg] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const token = typeof window !== 'undefined' ? localStorage.getItem('jira_token') || '' : '';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/connectors', { headers });
      if (r.ok) setConnectors(await r.json());
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (c: ConnectorRow) => {
    await fetch(`/api/connectors/${c.id}`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: !c.enabled }) });
    load();
  };
  const del = async (id: string) => {
    if (!confirm('Delete this connector?')) return;
    await fetch(`/api/connectors/${id}`, { method: 'DELETE', headers });
    load();
  };
  const test = async (id: string) => {
    setTestMsg(null);
    const r = await fetch(`/api/connectors/${id}/test`, { method: 'POST', headers });
    const data = await r.json();
    setTestMsg({ id, ok: data.ok, msg: data.ok ? 'Test event sent!' : (data.error || 'Failed') });
    setTimeout(() => setTestMsg(null), 4000);
  };
  const loadLogs = async (id: string) => {
    const r = await fetch(`/api/connectors/${id}/logs`, { headers });
    if (r.ok) setLogs({ connId: id, rows: await r.json() });
  };

  const editConnector = connectors.find(c => c.id === editId);

  return (
    <div className="max-w-[900px] mx-auto px-6 py-6">
      <button onClick={() => navigate('main')} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mb-5">
        <ArrowLeft size={14} /> Back to settings
      </button>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Connectors</h1>
          <p className="text-sm text-gray-500 mt-0.5">Connect your ticketing system to external apps. Events fire in real-time.</p>
        </div>
        <button onClick={() => { setShowAdd(true); setEditId(null); }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
          <Plus size={15} /> Add connector
        </button>
      </div>

      {/* Available connector types */}
      {!showAdd && !editId && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          {CONNECTOR_TYPES.map(ct => (
            <div key={ct.type} className={`border rounded-xl p-4 flex flex-col gap-2 ${ct.color}`}>
              <div className="flex items-center gap-2.5">
                {ct.icon}
                <span className="font-semibold text-sm">{ct.label}</span>
              </div>
              <p className="text-xs opacity-80 leading-relaxed">{ct.desc}</p>
              <button onClick={() => { setShowAdd(true); setEditId(null); }}
                className="mt-auto self-start text-xs font-medium underline opacity-70 hover:opacity-100">
                Configure →
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit form */}
      {(showAdd || editId) && (
        <ConnectorForm
          initial={editConnector}
          onSave={async (data) => {
            if (editId) {
              await fetch(`/api/connectors/${editId}`, { method: 'PATCH', headers, body: JSON.stringify(data) });
            } else {
              await fetch('/api/connectors', { method: 'POST', headers, body: JSON.stringify(data) });
            }
            setShowAdd(false); setEditId(null); load();
          }}
          onCancel={() => { setShowAdd(false); setEditId(null); }}
        />
      )}

      {/* Connector list */}
      {loading ? (
        <div className="text-center py-8 text-gray-400 text-sm">Loading…</div>
      ) : connectors.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-xl p-10 text-center">
          <Link2 size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">No connectors yet</p>
          <p className="text-xs text-gray-400 mt-1">Add a webhook or integration to get started</p>
        </div>
      ) : (
        <div className="space-y-3">
          {connectors.map(c => {
            const ct = CONNECTOR_TYPES.find(t => t.type === c.type);
            const isTestMsg = testMsg?.id === c.id;
            return (
              <div key={c.id} className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                <div className="flex items-start gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 border ${ct?.color || 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                    {ct?.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-gray-900">{c.name}</span>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 uppercase">{c.type}</span>
                      {c.enabled
                        ? <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700">Active</span>
                        : <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Disabled</span>}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {c.events.map(e => (
                        <span key={e} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100">{e.replace('issue.', '')}</span>
                      ))}
                    </div>
                    {isTestMsg && (
                      <p className={`text-xs mt-1.5 font-medium ${testMsg.ok ? 'text-green-600' : 'text-red-500'}`}>{testMsg.msg}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => test(c.id)} title="Send test event"
                      className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors">
                      <FlaskConical size={14} />
                    </button>
                    <button onClick={() => loadLogs(c.id)} title="View logs"
                      className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                      <Activity size={14} />
                    </button>
                    <button onClick={() => toggle(c)} title={c.enabled ? 'Disable' : 'Enable'}
                      className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                      {c.enabled ? <ToggleRight size={16} className="text-green-600" /> : <ToggleLeft size={16} />}
                    </button>
                    <button onClick={() => { setEditId(c.id); setShowAdd(false); }}
                      className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors">
                      <Settings size={14} />
                    </button>
                    <button onClick={() => del(c.id)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Logs panel */}
                {logs?.connId === c.id && (
                  <div className="mt-3 border-t border-gray-100 pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-gray-600">Recent delivery logs</span>
                      <button onClick={() => setLogs(null)} className="text-xs text-gray-400 hover:text-gray-600">Close</button>
                    </div>
                    {logs.rows.length === 0 ? (
                      <p className="text-xs text-gray-400">No logs yet</p>
                    ) : (
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {logs.rows.map((l: any, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-[11px]">
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${l.status === 'success' ? 'bg-green-500' : 'bg-red-500'}`} />
                            <span className="text-gray-500 font-mono">{new Date(l.created_at).toLocaleString()}</span>
                            <span className="text-gray-600">{l.event}</span>
                            {l.issue_key && <span className="text-blue-600">{l.issue_key}</span>}
                            {l.error && <span className="text-red-500 truncate">{l.error}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConnectorForm({ initial, onSave, onCancel }: {
  initial?: ConnectorRow;
  onSave: (data: any) => Promise<void>;
  onCancel: () => void;
}) {
  const [type, setType] = useState<ConnectorType>(initial?.type || 'webhook');
  const [name, setName] = useState(initial?.name || '');
  const [url, setUrl] = useState(initial?.config?.url || initial?.config?.webhookUrl || '');
  const [secret, setSecret] = useState(initial?.config?.secret || '');
  const [events, setEvents] = useState<string[]>(initial?.events || ['issue.created', 'issue.status_changed']);
  const [saving, setSaving] = useState(false);

  const toggleEvent = (id: string) =>
    setEvents(ev => ev.includes(id) ? ev.filter(e => e !== id) : [...ev, id]);

  const handleSave = async () => {
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    const config = type === 'webhook'
      ? { url, ...(secret ? { secret } : {}) }
      : { webhookUrl: url };
    await onSave({ name: name.trim(), type, config, events, space_ids: [], enabled: true });
    setSaving(false);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-4">{initial ? 'Edit connector' : 'New connector'}</h2>
      <div className="space-y-4">
        {/* Type selector */}
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-2">Type</label>
          <div className="flex gap-2">
            {CONNECTOR_TYPES.map(ct => (
              <button key={ct.type} onClick={() => setType(ct.type)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${type === ct.type ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                {ct.icon} {ct.label}
              </button>
            ))}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1.5">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Slack #alerts"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        {/* URL */}
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1.5">
            {type === 'webhook' ? 'Endpoint URL' : 'Incoming webhook URL'}
          </label>
          <input value={url} onChange={e => setUrl(e.target.value)}
            placeholder={type === 'webhook' ? 'https://example.com/hook' : type === 'slack' ? 'https://hooks.slack.com/services/...' : 'https://xxx.webhook.office.com/...'}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
          {type === 'slack' && (
            <p className="text-xs text-gray-400 mt-1">Create at: Slack → Apps → Incoming Webhooks → Add New Webhook</p>
          )}
          {type === 'teams' && (
            <p className="text-xs text-gray-400 mt-1">Create at: Teams channel → ··· → Connectors → Incoming Webhook</p>
          )}
        </div>

        {/* Secret (webhook only) */}
        {type === 'webhook' && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1.5">Secret (optional) — for HMAC-SHA256 signature</label>
            <input value={secret} onChange={e => setSecret(e.target.value)} placeholder="my-secret-key"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
          </div>
        )}

        {/* Events */}
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-2">Trigger on events</label>
          <div className="grid grid-cols-2 gap-2">
            {CONNECTOR_EVENTS.map(ev => (
              <label key={ev.id} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={events.includes(ev.id)} onChange={() => toggleEvent(ev.id)}
                  className="w-3.5 h-3.5 rounded text-blue-600" />
                <span className="text-xs text-gray-700">{ev.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
          <button onClick={handleSave} disabled={saving || !name.trim() || !url.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : (initial ? 'Save changes' : 'Create connector')}
          </button>
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function SettingsMenuItem({ icon, iconBg, title, desc, onClick, external }: { icon: React.ReactNode; iconBg?: string; title: string; desc: string; onClick: () => void; external?: boolean }) {
  const colorClass = iconBg ? iconBg.split(' ').find(c => c.startsWith('text-')) || 'text-gray-500' : 'text-gray-500';
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-4 px-4 py-4 hover:bg-gray-50 transition-colors text-left group first:rounded-t-xl last:rounded-b-xl">
      <div className={`flex-shrink-0 ${colorClass}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-800 group-hover:text-violet-700 transition-colors">{title}</p>
        <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
      </div>
      {external ? <ExternalLink size={14} className="text-gray-300 group-hover:text-gray-500 flex-shrink-0" /> : <ChevronRight size={15} className="text-gray-300 group-hover:text-violet-500 flex-shrink-0 transition-colors" />}
    </button>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex h-64 items-center justify-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'-0.3s'}} /><span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'-0.15s'}} /><span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'0s'}} /></div>}>
      <SettingsContent />
    </Suspense>
  );
}
