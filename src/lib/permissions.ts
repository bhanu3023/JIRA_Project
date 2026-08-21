/**
 * Jira-style Role-Based Access Control (RBAC)
 *
 * Role hierarchy (highest → lowest):
 *   admin > migration_manager / infra_lead > migration_engineer / infra_engineer
 *   > account_manager > qa_engineer > hr > developer > viewer
 *
 * "developer" is the default role assigned to all CloudFuze team members.
 *
 * The generic "manager" role was removed (folded into migration_manager,
 * since a bare "Manager" title with no board/domain scope had drifted into
 * meaning different things to different teams -- every real elevated-access
 * user now gets a role that says what they actually manage). Existing users
 * with role='manager' must be migrated to 'migration_manager' directly in
 * the DB when this ships; see deploy notes.
 *
 * "lead" and "shift_lead" previously appeared in ROLE_LABELS/ROLE_COLORS
 * (and were checked as privileged roles in a couple of authorization gates
 * in jira-pg-api.ts) but were never in this AppRole union or PERMISSION_MAP
 * -- SELECTABLE_ROLES's `as AppRole[]` cast hid the mismatch from the type
 * checker, but any user actually assigned either role would have silently
 * fallen back to viewer-level permissions via getPermissions()'s `?? viewer`
 * default, despite being treated as privileged everywhere else. Given proper
 * permissions here rather than removed, since removing them would break
 * whatever those two authorization checks were originally guarding.
 */

export type AppRole =
  | 'admin'
  | 'lead'
  | 'shift_lead'
  | 'migration_manager'
  | 'migration_engineer'
  | 'infra_lead'
  | 'infra_engineer'
  | 'account_manager'
  | 'qa_engineer'
  | 'hr'
  | 'developer'
  | 'viewer'
  | 'agent'; // internal/system role — not shown in UI

// ─────────────────────────────────────────────────────────────────────────────
// Role display metadata
// ─────────────────────────────────────────────────────────────────────────────

// Record<string, ...> (not Record<AppRole, ...>) deliberately -- callers
// look these up with a raw DB string (an issue's/user's stored role, which
// TypeScript can't narrow to AppRole) and already fall back to the raw
// value on a miss (e.g. `ROLE_LABELS[u.role] || u.role`), so keeping the
// index type wide here is what makes that safe fallback pattern typecheck.
export const ROLE_LABELS: Record<string, string> = {
  admin:               'Admin',
  lead:                'Lead',
  shift_lead:          'Shift Lead',
  migration_manager:   'Migration Manager',
  migration_engineer:  'Migration Engineer',
  infra_lead:          'Infra Lead',
  infra_engineer:      'Infra Engineer',
  account_manager:     'Account Manager',
  qa_engineer:         'QA Engineer',
  hr:                  'HR',
  developer:           'Developer',
  viewer:              'Viewer',
  agent:               'Agent',
};

/** Roles that can be selected when inviting / editing a user (excludes the internal-only "agent" role) */
export const SELECTABLE_ROLES = (Object.keys(ROLE_LABELS) as AppRole[]).filter(r => r !== 'agent');

export const ROLE_COLORS: Record<string, string> = {
  admin:               'bg-violet-100 text-violet-700',
  lead:                'bg-indigo-100 text-indigo-700',
  shift_lead:          'bg-teal-100 text-teal-700',
  migration_manager:   'bg-sky-100 text-sky-700',
  migration_engineer:  'bg-orange-100 text-orange-700',
  infra_lead:          'bg-blue-100 text-blue-700',
  infra_engineer:      'bg-lime-100 text-lime-700',
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

// Record<AppRole, ...> (exhaustive, minus 'agent' which is defined further
// down) makes TypeScript itself catch the next version of the exact gap that
// let lead/shift_lead silently fall back to viewer permissions -- add a role
// to AppRole without a matching entry here and this won't compile.
const PERMISSION_MAP: Record<Exclude<AppRole, 'agent'>, Permissions> & { agent: Permissions } = {
  admin: {
    accessSettings: true,  manageUsers: true,       manageSpaces: true,
    manageWorkItems: true,  viewBilling: true,        viewSystemLogs: true,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: true,     transitionIssues: true,   assignIssues: true,
    setPriority: true,      addComments: true,        manageComments: true,
    viewReports: true,      exportData: true,
  },

  // Same tier "manager" used to occupy -- kept for the two roles that were
  // already checked as privileged in jira-pg-api.ts's authorization gates
  // (isPrivilegedGlobalPatch, isSpaceAdmin) despite never having a real
  // permission entry of their own.
  lead: {
    accessSettings: false, manageUsers: false,      manageSpaces: true,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: true,
    setPriority: true,      addComments: true,        manageComments: true,
    viewReports: true,      exportData: true,
  },

  shift_lead: {
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

  // Same permission tier as migration_manager, by request -- Infra Lead is
  // the infra-team equivalent of the Migration Manager role.
  infra_lead: {
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

  // Same permission tier as migration_engineer, by request -- Infra
  // Engineer is the infra-team equivalent of the Migration Engineer role.
  infra_engineer: {
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
    viewReports: true,      exportData: true,
  },

  qa_engineer: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: true,       editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: false,
    setPriority: true,      addComments: true,        manageComments: false,
    viewReports: true,      exportData: true,
  },

  hr: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: false,      editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: false,
    setPriority: false,     addComments: true,        manageComments: false,
    viewReports: false,     exportData: true,
  },

  developer: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: false,      editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: false,
    setPriority: false,     addComments: true,        manageComments: false,
    viewReports: false,     exportData: true,
  },

  viewer: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: false,    editAnyIssue: false,      editOwnIssue: false,
    deleteIssues: false,    transitionIssues: false,  assignIssues: false,
    setPriority: false,     addComments: false,       manageComments: false,
    viewReports: false,     exportData: true,
  },

  agent: {
    accessSettings: false, manageUsers: false,      manageSpaces: false,
    manageWorkItems: false, viewBilling: false,       viewSystemLogs: false,
    createIssues: true,     editAnyIssue: false,      editOwnIssue: true,
    deleteIssues: false,    transitionIssues: true,   assignIssues: false,
    setPriority: false,     addComments: true,        manageComments: false,
    viewReports: false,     exportData: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Get full permission set for a role */
export function getPermissions(role?: string | null): Permissions {
  // `role` comes from the DB as a plain string (not narrowed to AppRole),
  // so an unrecognized value must still resolve safely to viewer instead of
  // a lookup error -- hence the cast to a wider index type here only.
  return (PERMISSION_MAP as Record<string, Permissions>)[role ?? 'viewer'] ?? PERMISSION_MAP.viewer;
}

/** Check a single permission for a role */
export function can(role: string | null | undefined, permission: keyof Permissions): boolean {
  return getPermissions(role)[permission] ?? false;
}

/** True if the role has admin-level access */
export function isPrivileged(role?: string | null): boolean {
  return role === 'admin';
}

/**
 * True if the role can manage spaces / boards. Mirrors exactly which roles
 * carry manageSpaces:true in PERMISSION_MAP (admin, lead, shift_lead) --
 * migration_manager and infra_lead deliberately do NOT have manageSpaces,
 * matching their existing permission entries (callers that also want to
 * include migration_manager already OR it in explicitly, e.g.
 * my-dashboard's canViewMigrationQueue).
 */
export function isManager(role?: string | null): boolean {
  return isPrivileged(role) || role === 'lead' || role === 'shift_lead';
}
