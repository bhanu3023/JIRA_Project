/**
 * Jira-style Role-Based Access Control (RBAC)
 *
 * Role hierarchy (highest → lowest):
 *   admin > manager > migration_engineer > account_manager > qa_engineer > hr > developer > viewer
 *
 * "developer" is the default role assigned to all CloudFuze team members.
 */

export type AppRole =
  | 'admin'
  | 'manager'
  | 'migration_manager'
  | 'migration_engineer'
  | 'account_manager'
  | 'qa_engineer'
  | 'hr'
  | 'developer'
  | 'viewer'
  | 'agent'; // internal/system role — not shown in UI

// ─────────────────────────────────────────────────────────────────────────────
// Role display metadata
// ─────────────────────────────────────────────────────────────────────────────

export const ROLE_LABELS: Record<string, string> = {
  admin:               'Admin',
  manager:             'Manager',
  lead:                'Lead',
  shift_lead:          'Shift Lead',
  migration_manager:   'Migration Manager',
  migration_engineer:  'Migration Engineer',
  account_manager:     'Account Manager',
  qa_engineer:         'QA Engineer',
  hr:                  'HR',
  developer:           'Developer',
  viewer:              'Viewer',
};

/** Roles that can be selected when inviting / editing a user */
export const SELECTABLE_ROLES = Object.keys(ROLE_LABELS) as AppRole[];

export const ROLE_COLORS: Record<string, string> = {
  admin:               'bg-violet-100 text-violet-700',
  manager:             'bg-blue-100 text-blue-700',
  lead:                'bg-indigo-100 text-indigo-700',
  shift_lead:          'bg-teal-100 text-teal-700',
  migration_manager:   'bg-sky-100 text-sky-700',
  migration_engineer:  'bg-orange-100 text-orange-700',
  account_manager:     'bg-cyan-100 text-cyan-700',
  qa_engineer:         'bg-amber-100 text-amber-700',
  hr:                  'bg-pink-100 text-pink-700',
  developer:           'bg-emerald-100 text-emerald-700',
  viewer:              'bg-gray-100 text-gray-600',
  agent:               'bg-gray-100 text-gray-500',
};

// ─────────────────────────────────────────────────────────────────────────────
// Permission definitions  (same concept as Jira global + project permissions)
// ─────────────────────────────────────────────────────────────────────────────

export interface Permissions {
  // ── Global / Settings ──────────────────────────────────────────────────────
  /** Access the /settings page */
  accessSettings: boolean;
  /** Manage users (invite, deactivate, change roles) */
  manageUsers: boolean;
  /** Manage spaces / boards (create, edit, delete) */
  manageSpaces: boolean;
  /** Manage custom fields, workflows, SLA settings */
  manageWorkItems: boolean;
  /** View billing & subscription info */
  viewBilling: boolean;
  /** View system / audit logs */
  viewSystemLogs: boolean;

  // ── Issues ─────────────────────────────────────────────────────────────────
  /** Create new issues in any space */
  createIssues: boolean;
  /** Edit any issue (not just own) */
  editAnyIssue: boolean;
  /** Edit only issues created by or assigned to self */
  editOwnIssue: boolean;
  /** Delete issues */
  deleteIssues: boolean;
  /** Change issue status */
  transitionIssues: boolean;
  /** Assign issues to other users */
  assignIssues: boolean;
  /** Set / change issue priority */
  setPriority: boolean;

  // ── Comments ───────────────────────────────────────────────────────────────
  /** Add comments to issues */
  addComments: boolean;
  /** Edit / delete any comment */
  manageComments: boolean;

  // ── Reports / Dashboard ────────────────────────────────────────────────────
  /** View reports and analytics */
  viewReports: boolean;
  /** Export data (CSV / reports) */
  exportData: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission matrix  — mirrors Jira's built-in role permissions
// ─────────────────────────────────────────────────────────────────────────────

const PERMISSION_MAP: Record<string, Permissions> = {
  admin: {
    accessSettings: true,  manageUsers: true,       manageSpaces: true,
    manageWorkItems: true,  viewBilling: true,        viewSystemLogs: true,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: true,     transitionIssues: true,   assignIssues: true,
    setPriority: true,      addComments: true,        manageComments: true,
    viewReports: true,      exportData: true,
  },

  manager: {
    accessSettings: false, manageUsers: false,      manageSpaces: true,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: true,
    setPriority: true,      addComments: true,        manageComments: true,
    viewReports: true,      exportData: true,
  },

  migration_manager: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: true,
    setPriority: true,      addComments: true,        manageComments: true,
    viewReports: true,      exportData: true,
  },

  migration_engineer: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: true,
    setPriority: true,      addComments: true,        manageComments: false,
    viewReports: true,      exportData: true,
  },

  account_manager: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: true,
    setPriority: true,      addComments: true,        manageComments: false,
    viewReports: true,      exportData: false,
  },

  qa_engineer: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: false,
    setPriority: true,      addComments: true,        manageComments: false,
    viewReports: true,      exportData: false,
  },

  hr: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: false,      editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: false,
    setPriority: false,     addComments: true,        manageComments: false,
    viewReports: false,     exportData: false,
  },

  developer: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: false,      editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: false,
    setPriority: false,     addComments: true,        manageComments: false,
    viewReports: false,     exportData: false,
  },

  viewer: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: false,    editAnyIssue: false,      editOwnIssue: false,
    deleteIssues: false,    transitionIssues: false,  assignIssues: false,
    setPriority: false,     addComments: false,       manageComments: false,
    viewReports: false,     exportData: false,
  },

  agent: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: false,      editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: false,
    setPriority: false,     addComments: true,        manageComments: false,
    viewReports: false,     exportData: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Get full permission set for a role */
export function getPermissions(role?: string | null): Permissions {
  return PERMISSION_MAP[role ?? 'viewer'] ?? PERMISSION_MAP.viewer;
}

/** Check a single permission for a role */
export function can(role: string | null | undefined, permission: keyof Permissions): boolean {
  return getPermissions(role)[permission] ?? false;
}

/** True if the role has admin-level access */
export function isPrivileged(role?: string | null): boolean {
  return role === 'admin';
}

/** True if the role can manage spaces / boards */
export function isManager(role?: string | null): boolean {
  return isPrivileged(role) || role === 'manager';
}
