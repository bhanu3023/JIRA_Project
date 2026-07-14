'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { getInitials } from '@/lib/utils';
import {
  Settings, Users, Tag, GitBranch, Clock, ShieldCheck, Bell,
  List, Monitor, UserCheck, Plus, ChevronRight, Trash2, Edit2,
  Check, X, Info, Globe, Lock, Eye, Zap, Calendar, ChevronDown,
  ChevronUp, MoreHorizontal, ArrowLeft, GripVertical, AlertTriangle,
  Mail, Copy, ToggleLeft, ToggleRight, RefreshCw, Shield, Filter, ExternalLink, Power, Search
} from 'lucide-react';
import { PriorityIcon, getPriorityMeta } from '@/components/ui/PriorityIcon';
import { ROLE_LABELS, SELECTABLE_ROLES } from '@/lib/permissions';

// ── Sidebar nav ───────────────────────────────────────────────────────────────
const NAV = [
  { group: 'Project settings', items: [
    { id: 'general',       label: 'General',              icon: Settings },
    { id: 'summary',       label: 'Summary',              icon: Info },
  ]},
  { group: 'Access', items: [
    { id: 'people',        label: 'People and access',    icon: Users },
    { id: 'permissions',   label: 'Space permissions',    icon: ShieldCheck },
    { id: 'customer',      label: 'Customer permissions', icon: UserCheck },
    { id: 'notifications', label: 'Notifications',        icon: Bell },
  ]},
  { group: 'Service management', items: [
    { id: 'sla',           label: 'SLAs',                 icon: Clock },
    { id: 'queues',        label: 'Queues',               icon: List },
    { id: 'fields',        label: 'Customer fields',      icon: Tag },
    { id: 'email',         label: 'Email',                icon: Mail },
    { id: 'roundrobin',    label: 'Round Robin',          icon: RefreshCw },
  ]},
  { group: 'Development', items: [
    { id: 'workflow',      label: 'Workflows',            icon: GitBranch },
    { id: 'screens',       label: 'Screens',              icon: Monitor },
    { id: 'labels',        label: 'Labels',               icon: Tag },
    { id: 'automation',    label: 'Automation',           icon: Zap },
  ]},
];

// ── Types ─────────────────────────────────────────────────────────────────────
interface SLAGoal {
  id: string;
  jql: string;
  calendar: string;
  timeValue: string;
  timeUnit: string;
  isPriorityGroup?: boolean;
  priorityRows?: { priority: string; calendar: string; timeValue: string; timeUnit: string }[];
}

interface SLAItem {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  goals: SLAGoal[];
  startCondition: string;
  pauseCondition: string;
  pauseStatuses: string[];
  stopCondition: string;
}

const CALENDARS = ['24/7 Calendar (Default)', 'Sample 9-5 Calendar', 'Business Hours (9-5 Mon-Fri)'];
const TIME_UNITS = ['minutes', 'hours', 'days'];
const PRIORITIES_LIST = ['highest', 'high', 'medium', 'low', 'lowest'];

const DEFAULT_SLAS: SLAItem[] = [
  {
    id: '1',
    name: 'Time to first response',
    status: 'active',
    goals: [
      {
        id: 'g1',
        jql: 'type in (Task, Bug, Story)',
        calendar: '24/7 Calendar (Default)',
        timeValue: '',
        timeUnit: 'hours',
        isPriorityGroup: true,
        priorityRows: [
          { priority: 'highest', calendar: '24/7 Calendar (Default)', timeValue: '4',  timeUnit: 'hours' },
          { priority: 'high',    calendar: '24/7 Calendar (Default)', timeValue: '8',  timeUnit: 'hours' },
          { priority: 'medium',  calendar: '24/7 Calendar (Default)', timeValue: '16', timeUnit: 'hours' },
          { priority: 'low',     calendar: '24/7 Calendar (Default)', timeValue: '24', timeUnit: 'hours' },
          { priority: 'lowest',  calendar: '24/7 Calendar (Default)', timeValue: '48', timeUnit: 'hours' },
        ],
      },
      {
        id: 'g2',
        jql: 'All remaining work items',
        calendar: 'Sample 9-5 Calendar',
        timeValue: '80',
        timeUnit: 'hours',
        isPriorityGroup: false,
      },
    ],
    startCondition: 'Issue created',
    pauseCondition: 'Status = Waiting for customer',
    pauseStatuses: ['Waiting for Customer'],
    stopCondition: 'Status = Resolved OR Status = Closed',
  },
  {
    id: '2',
    name: 'Time to resolution',
    status: 'active',
    goals: [
      {
        id: 'g3',
        jql: 'type in (Task, Sub-task, Bug, "Emailed request")',
        calendar: '24/7 Calendar (Default)',
        timeValue: '',
        timeUnit: 'hours',
        isPriorityGroup: true,
        priorityRows: [
          { priority: 'highest', calendar: '24/7 Calendar (Default)', timeValue: '6',  timeUnit: 'hours' },
          { priority: 'high',    calendar: '24/7 Calendar (Default)', timeValue: '8',  timeUnit: 'hours' },
          { priority: 'medium',  calendar: '24/7 Calendar (Default)', timeValue: '24', timeUnit: 'hours' },
          { priority: 'low',     calendar: '24/7 Calendar (Default)', timeValue: '48', timeUnit: 'hours' },
          { priority: 'lowest',  calendar: '24/7 Calendar (Default)', timeValue: '60', timeUnit: 'hours' },
        ],
      },
      {
        id: 'g4',
        jql: 'All remaining work items',
        calendar: 'Sample 9-5 Calendar',
        timeValue: '80',
        timeUnit: 'hours',
        isPriorityGroup: false,
      },
    ],
    startCondition: 'Issue created',
    pauseCondition: 'Status = Waiting for customer',
    pauseStatuses: ['Waiting for Customer'],
    stopCondition: 'Status = Resolved OR Status = Closed',
  },
];

// ── Small reusable components ─────────────────────────────────────────────────
function Badge({ children, color = 'gray' }: { children: React.ReactNode; color?: string }) {
  const cls: Record<string, string> = {
    gray:   'bg-gray-100 text-gray-600',
    blue:   'bg-blue-50 text-blue-700',
    green:  'bg-emerald-50 text-emerald-700',
    red:    'bg-red-50 text-red-600',
    yellow: 'bg-amber-50 text-amber-700',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${cls[color] || cls.gray}`}>{children}</span>;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-gray-900">{title}</h2>
        {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ── People & Access section (own component so hooks are always called) ─────────
const MEMBER_ROLES = [
  { value: 'admin',     label: 'Admin',     desc: 'Full control over space settings and members' },
  { value: 'developer', label: 'Developer', desc: 'Can create and manage issues' },
  { value: 'viewer',    label: 'Viewer',    desc: 'Read-only access to the space' },
];

function PeopleSection({
  currentSpace, users, spaceKey, onAddMember, onReload,
}: {
  currentSpace: any;
  users: any[];
  spaceKey: string;
  onAddMember: (userId: string, role: string, department?: string) => Promise<void>;
  onReload: () => void;
}) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [selectedRole, setSelectedRole] = useState('developer');
  const [selectedDept, setSelectedDept] = useState('');
  const [addingMember, setAddingMember] = useState(false);
  const [addMemberMsg, setAddMemberMsg] = useState('');
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);
  const [editingDeptVal, setEditingDeptVal] = useState('');
  const [removingId,   setRemovingId]   = useState<string | null>(null);
  const [resendingId,  setResendingId]  = useState<string | null>(null);
  const [resendMsg,    setResendMsg]    = useState<{id:string; ok:boolean; text:string} | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [suspendingId, setSuspendingId] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState('');

  // Members already in this space — match by email to avoid member-id vs user-id mismatch
  const memberEmails = new Set(
    (currentSpace.members || []).map((m: any) => (m.email || m.user?.email || '').toLowerCase())
  );
  const availableUsers = users.filter(u => !memberEmails.has((u.email || '').toLowerCase()));
  const filteredUsers  = availableUsers.filter(u => {
    const q = memberSearch.toLowerCase();
    return !q
      || (u.firstName + ' ' + u.lastName).toLowerCase().includes(q)
      || (u.email || '').toLowerCase().includes(q);
  });

  const DEPT_OPTIONS = ['', 'Migration', 'Dev', 'QA', 'Pre-Sales', 'Support'];

  const openModal = () => {
    setShowAddModal(true);
    setSelectedUser(null);
    setMemberSearch('');
    setSelectedRole('developer');
    setSelectedDept('');
    setAddMemberMsg('');
  };

  const doAddMember = async () => {
    if (!selectedUser) return;
    setAddingMember(true);
    setAddMemberMsg('');
    try {
      await onAddMember(selectedUser.id, selectedRole, selectedDept);
      setAddMemberMsg(`${selectedUser.firstName} ${selectedUser.lastName} added successfully.`);
      setSelectedUser(null);
      setMemberSearch('');
      setTimeout(() => { setShowAddModal(false); setAddMemberMsg(''); }, 1200);
    } catch {
      setAddMemberMsg('Failed to add member. Please try again.');
    } finally {
      setAddingMember(false);
    }
  };

  return (
    <Section title="People and access" description="Manage who has access to this space and their roles.">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" onClick={() => setActionMenuId(null)}>

        {/* Sticky bar: Members count + Search + Add button */}
        <div className="sticky top-0 z-20 bg-white px-5 py-3.5 border-b border-gray-100 flex items-center gap-3">
          <p className="text-sm font-bold text-gray-700 whitespace-nowrap">Members ({currentSpace.members?.length || 0})</p>
          <div className="flex-1 relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search members..."
              value={memberFilter}
              onChange={e => setMemberFilter(e.target.value)}
              className="w-full pl-7 pr-3 py-1.5 text-[12.5px] border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 bg-gray-50"
            />
          </div>
          <button onClick={openModal}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 text-white text-[12.5px] font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm whitespace-nowrap">
            <Plus size={14} /> Add member
          </button>
        </div>

        {/* Table with sticky thead */}
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
        <table className="w-full">
          <colgroup>
            <col style={{width:'28%'}} /><col style={{width:'27%'}} /><col style={{width:'13%'}} /><col style={{width:'16%'}} /><col style={{width:'16%'}} />
          </colgroup>
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-100">Name</th>
              <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-100">Email</th>
              <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-100">Role</th>
              <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-100">Department</th>
              <th className="px-5 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-100">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {(currentSpace.members || []).filter((m: any) => {
              if (!memberFilter.trim()) return true;
              const q = memberFilter.toLowerCase();
              const name = `${m.firstName || m.user?.firstName || ''} ${m.lastName || m.user?.lastName || ''}`.toLowerCase();
              const email = (m.email || m.user?.email || '').toLowerCase();
              return name.includes(q) || email.includes(q);
            }).map((m: any) => {
              const firstName = m.firstName || m.user?.firstName || '';
              const lastName  = m.lastName  || m.user?.lastName  || '';
              const email     = m.email     || m.user?.email     || '';
              const role      = m.role || 'agent';
              return (
                <tr key={m.id} className="hover:bg-gray-50 transition-colors group">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0">
                        {getInitials(firstName, lastName)}
                      </div>
                      <p className="text-sm font-semibold text-gray-900">{firstName} {lastName}</p>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-gray-500">{email}</td>
                  <td className="px-5 py-3.5">
                    <select
                      value={role}
                      onChange={async (e) => {
                        const newRole = e.target.value;
                        await fetch(`/api/spaces/${spaceKey}/members/${m.userId || m.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ role: newRole }),
                        });
                        onReload();
                      }}
                      className="text-[12px] border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                    >
                      {SELECTABLE_ROLES.map(r => (
                        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-5 py-3.5">
                    {editingDeptId === (m.userId || m.id) ? (
                      <div className="flex items-center gap-1">
                        <select value={editingDeptVal} onChange={e => setEditingDeptVal(e.target.value)}
                          className="text-[12px] border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500">
                          {['', 'Migration', 'Dev', 'QA', 'Pre-Sales', 'Support'].map(d => (
                            <option key={d} value={d}>{d || '— None —'}</option>
                          ))}
                        </select>
                        <button onClick={async () => {
                          await fetch(`/api/spaces/${spaceKey}/members/${m.userId || m.id}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ department: editingDeptVal || null }),
                          });
                          setEditingDeptId(null);
                          onReload();
                        }} className="text-[11px] px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
                        <button onClick={() => setEditingDeptId(null)} className="text-[11px] px-1.5 py-1 text-gray-500 hover:text-gray-700">✕</button>
                      </div>
                    ) : (
                      <button onClick={() => { setEditingDeptId(m.userId || m.id); setEditingDeptVal(m.department || ''); }}
                        className="text-[12px] text-gray-600 hover:text-blue-600 hover:underline">
                        {m.department || <span className="text-gray-300 italic">Set dept</span>}
                      </button>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="relative flex items-center justify-end">
                      {resendMsg?.id === m.id && (
                        <span className={`mr-2 text-[11px] font-medium ${resendMsg.ok ? 'text-green-600' : 'text-red-500'}`}>
                          {resendMsg.text}
                        </span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setActionMenuId(actionMenuId === m.id ? null : m.id); }}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-md hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm">
                        Actions <ChevronDown size={12} className="text-gray-400" />
                      </button>
                      {actionMenuId === m.id && (
                        <div
                          className="absolute right-0 top-full mt-1 w-40 bg-white border border-gray-200 rounded-lg shadow-lg z-30 py-1"
                          onClick={e => e.stopPropagation()}>
                          {/* Resend invite */}
                          <button
                            disabled={resendingId === m.id}
                            onClick={async () => {
                              setActionMenuId(null);
                              setResendingId(m.id);
                              setResendMsg(null);
                              try {
                                const res = await fetch('/api/users/invite', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ email, firstName, lastName, role, invitedBy: 'Admin' }),
                                });
                                const data = await res.json();
                                setResendMsg({ id: m.id, ok: data.emailSent, text: data.emailSent ? 'Invite sent!' : 'Not configured' });
                              } catch {
                                setResendMsg({ id: m.id, ok: false, text: 'Failed to send' });
                              } finally {
                                setResendingId(null);
                                setTimeout(() => setResendMsg(null), 3000);
                              }
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50">
                            <Mail size={13} /> {resendingId === m.id ? 'Sending…' : 'Resend invite'}
                          </button>
                          {/* Suspend */}
                          <button
                            disabled={suspendingId === m.id}
                            onClick={async () => {
                              setActionMenuId(null);
                              if (!confirm(`Suspend ${firstName} ${lastName}? They will not be able to log in.`)) return;
                              setSuspendingId(m.id);
                              try {
                                await fetch(`/api/jira-pg?path=users/${m.userId || m.id}`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ isActive: false }),
                                });
                                onReload();
                              } finally { setSuspendingId(null); }
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-gray-700 hover:bg-yellow-50 hover:text-yellow-700 disabled:opacity-50">
                            <Power size={13} /> {suspendingId === m.id ? 'Suspending…' : 'Suspend'}
                          </button>
                          {/* Divider */}
                          <div className="border-t border-gray-100 my-1" />
                          {/* Delete / Remove */}
                          <button
                            disabled={removingId === m.id}
                            onClick={async () => {
                              setActionMenuId(null);
                              if (!confirm(`Remove ${firstName} ${lastName} from this space?`)) return;
                              setRemovingId(m.id);
                              try {
                                // Resolve the real userId — m.id may be an email in some data shapes
                                let memberId = m.userId || m.id;
                                if (!memberId || memberId.includes('@')) {
                                  const allUsers = await api.request<any[]>('/users').catch(() => []);
                                  const found = allUsers.find((u: any) => u.email === email);
                                  if (found) memberId = found.id;
                                }
                                await api.request(`/spaces/${spaceKey}/members/${memberId}`, { method: 'DELETE' });
                                onReload();
                              } catch { alert('Network error. Please try again.'); }
                              finally { setRemovingId(null); }
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-red-600 hover:bg-red-50 disabled:opacity-50">
                            <Trash2 size={13} /> {removingId === m.id ? 'Removing…' : 'Delete'}
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {(!currentSpace.members || currentSpace.members.length === 0) && (
              <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-gray-400">No members yet.</td></tr>
            )}
          </tbody>
        </table>
        </div>{/* end scrollable wrapper */}
      </div>

      {/* Add Member Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col" style={{ maxHeight: '85vh' }}>

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h3 className="text-[15px] font-bold text-gray-900">Add member</h3>
              <button onClick={() => setShowAddModal(false)}
                className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

              {/* Search */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-700 mb-1.5">
                  Search by name or email <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  autoFocus
                  placeholder="Search users..."
                  value={memberSearch}
                  onChange={e => { setMemberSearch(e.target.value); setSelectedUser(null); }}
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
                />
                <div className="mt-2 border border-gray-200 rounded-lg overflow-hidden divide-y divide-gray-100 max-h-52 overflow-y-auto">
                  {filteredUsers.length === 0 ? (
                    <div className="px-4 py-5 text-center text-sm text-gray-400">
                      {availableUsers.length === 0
                        ? 'All users are already members of this space.'
                        : 'No users match your search.'}
                    </div>
                  ) : filteredUsers.map(u => {
                    const isSel = selectedUser?.id === u.id;
                    return (
                      <button key={u.id} type="button"
                        onClick={() => setSelectedUser(isSel ? null : u)}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors ${isSel ? 'bg-blue-50' : ''}`}>
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${isSel ? 'bg-blue-600 text-white' : 'bg-gradient-to-br from-indigo-400 to-purple-500 text-white'}`}>
                          {isSel ? <Check size={14} /> : getInitials(u.firstName, u.lastName)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-[13px] font-semibold ${isSel ? 'text-blue-700' : 'text-gray-900'}`}>{u.firstName} {u.lastName}</p>
                          <p className="text-[11.5px] text-gray-400 truncate">{u.email}</p>
                        </div>
                        {isSel && <Check size={15} className="text-blue-600 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Role */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-700 mb-2">Role</label>
                <div className="space-y-2">
                  {MEMBER_ROLES.map(r => (
                    <label key={r.value}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${selectedRole === r.value ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                      <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${selectedRole === r.value ? 'border-blue-600 bg-blue-600' : 'border-gray-300 bg-white'}`}>
                        {selectedRole === r.value && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                      </div>
                      <input type="radio" name="member_role" value={r.value} checked={selectedRole === r.value}
                        onChange={() => setSelectedRole(r.value)} className="sr-only" />
                      <div>
                        <p className={`text-[13px] font-semibold ${selectedRole === r.value ? 'text-blue-700' : 'text-gray-900'}`}>{r.label}</p>
                        <p className="text-[11.5px] text-gray-500 mt-0.5">{r.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Department */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-700 mb-1.5">Department <span className="text-gray-400 font-normal">(optional)</span></label>
                <select value={selectedDept} onChange={e => setSelectedDept(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {DEPT_OPTIONS.map(d => <option key={d} value={d}>{d || '— None —'}</option>)}
                </select>
                <p className="text-[11px] text-gray-400 mt-1">Determines which dept tickets this member sees by default on the board.</p>
              </div>

              {addMemberMsg && (
                <div className={`px-3 py-2.5 rounded-lg text-[12.5px] font-medium ${addMemberMsg.includes('success') ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                  {addMemberMsg}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-between px-5 py-3.5 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <p className="text-[12px] text-gray-500">
                {selectedUser
                  ? <><span className="text-gray-400">Adding:</span> <span className="font-semibold text-gray-700">{selectedUser.firstName} {selectedUser.lastName}</span></>
                  : 'Select a user above'}
              </p>
              <div className="flex gap-2">
                <button onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-[12.5px] font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button onClick={doAddMember} disabled={!selectedUser || addingMember}
                  className="px-4 py-2 text-[12.5px] font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  {addingMember ? 'Adding…' : 'Add member'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

function ToggleSwitch({ defaultOn = false }: { defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button onClick={() => setOn(v => !v)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent cursor-pointer transition-colors ${on ? 'bg-blue-600' : 'bg-gray-200'}`}>
      <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition duration-200 ${on ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

// ── SLA Detail / Edit view ────────────────────────────────────────────────────
function SLADetailView({ sla, onBack, onSave, spaceStatuses = [] }: { sla: SLAItem; onBack: () => void; onSave: (updated: SLAItem) => void; spaceStatuses?: string[] }) {
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState<SLAItem>(JSON.parse(JSON.stringify(sla)));
  const [expandedGoals, setExpandedGoals] = useState<string[]>(sla.goals.map(g => g.id));

  const toggleGoal = (id: string) =>
    setExpandedGoals(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const updatePriorityRow = (goalId: string, priority: string, field: 'calendar' | 'timeValue' | 'timeUnit', val: string) => {
    setData(d => ({
      ...d,
      goals: d.goals.map(g => g.id !== goalId ? g : {
        ...g,
        priorityRows: g.priorityRows?.map(r => r.priority === priority ? { ...r, [field]: val } : r),
      }),
    }));
  };

  const updateGoal = (goalId: string, field: string, val: string) => {
    setData(d => ({ ...d, goals: d.goals.map(g => g.id !== goalId ? g : { ...g, [field]: val }) }));
  };

  const addGoal = () => {
    const newGoal: SLAGoal = {
      id: Date.now().toString(),
      jql: '',
      calendar: '24/7 Calendar (Default)',
      timeValue: '8',
      timeUnit: 'hours',
      isPriorityGroup: false,
    };
    setData(d => ({ ...d, goals: [...d.goals, newGoal] }));
    setExpandedGoals(prev => [...prev, newGoal.id]);
  };

  const removeGoal = (goalId: string) => {
    setData(d => ({ ...d, goals: d.goals.filter(g => g.id !== goalId) }));
  };

  const totalGoals = data.goals.reduce((acc, g) => acc + (g.isPriorityGroup ? (g.priorityRows?.length ?? 0) + 1 : 1), 0);

  return (
    <div className="space-y-5">
      {/* Back + title bar */}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors">
          <ArrowLeft size={15} /> Back to SLAs
        </button>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button onClick={() => { setEditing(false); setData(JSON.parse(JSON.stringify(sla))); }}
                className="px-4 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-all">
                Cancel
              </button>
              <button onClick={() => { onSave(data); setEditing(false); }}
                className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-all shadow-sm">
                Save SLA
              </button>
            </>
          ) : (
            <button onClick={() => setEditing(true)}
              className="px-4 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-all flex items-center gap-1.5">
              <Edit2 size={13} /> Edit
            </button>
          )}
        </div>
      </div>

      {/* SLA name + goal count */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <Clock size={18} className="text-blue-500 flex-shrink-0" />
            {editing ? (
              <input value={data.name} onChange={e => setData(d => ({ ...d, name: e.target.value }))}
                className="text-lg font-bold text-gray-900 border-b-2 border-blue-400 focus:outline-none bg-transparent" />
            ) : (
              <h3 className="text-lg font-bold text-gray-900">{data.name}</h3>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500 font-medium">{totalGoals} goal{totalGoals !== 1 ? 's' : ''}</span>
            <button
              onClick={() => {
                const next = data.status === 'active' ? 'inactive' : 'active';
                const updated = { ...data, status: next as 'active' | 'inactive' };
                setData(updated);
                onSave(updated);
              }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-all ${
                data.status === 'active'
                  ? 'bg-green-50 text-green-700 border-green-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200'
                  : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-green-50 hover:text-green-700 hover:border-green-200'
              }`}
              title={data.status === 'active' ? 'Click to disable SLA' : 'Click to enable SLA'}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${data.status === 'active' ? 'bg-green-500' : 'bg-gray-400'}`} />
              {data.status === 'active' ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        </div>

        {/* ── GOALS section ── */}
        <div className="px-5 py-4">
          <div className="mb-3">
            <h4 className="text-sm font-bold text-gray-800">Goals</h4>
            <p className="text-xs text-gray-500 mt-0.5">
              Work items will be checked against this list, top to bottom, and assigned a time goal based on the first matching JQL statement.
            </p>
          </div>

          {/* Column headers */}
          <div className="grid grid-cols-[1fr_200px_160px] gap-3 px-3 pb-1.5 text-[11px] font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100">
            <span>Apply to work items</span>
            <span>Calendar</span>
            <span>Time target</span>
          </div>

          <div className="space-y-2 mt-2">
            {data.goals.map((goal, gi) => (
              <div key={goal.id} className="border border-gray-200 rounded-xl overflow-hidden">
                {/* Goal header row */}
                <div
                  className="grid grid-cols-[1fr_200px_160px] gap-3 px-3 py-3 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors items-center"
                  onClick={() => goal.isPriorityGroup && toggleGoal(goal.id)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {goal.isPriorityGroup && (
                      expandedGoals.includes(goal.id)
                        ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
                        : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />
                    )}
                    {editing ? (
                      <input
                        value={goal.jql}
                        onClick={e => e.stopPropagation()}
                        onChange={e => updateGoal(goal.id, 'jql', e.target.value)}
                        className="flex-1 text-sm text-orange-600 font-medium bg-orange-50 border border-orange-200 rounded px-2 py-0.5 focus:outline-none"
                      />
                    ) : (
                      <span className="text-sm text-orange-600 font-medium truncate">{goal.jql || 'All remaining work items'}</span>
                    )}
                  </div>
                  {!goal.isPriorityGroup ? (
                    <>
                      <div className="flex items-center gap-1.5 text-sm text-gray-600">
                        <Calendar size={13} className="text-gray-400 flex-shrink-0" />
                        {editing ? (
                          <select value={goal.calendar} onClick={e => e.stopPropagation()}
                            onChange={e => updateGoal(goal.id, 'calendar', e.target.value)}
                            className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none bg-white flex-1">
                            {CALENDARS.map(c => <option key={c}>{c}</option>)}
                          </select>
                        ) : (
                          <span className="text-xs truncate">{goal.calendar}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {editing ? (
                          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                            <input type="number" value={goal.timeValue} onChange={e => updateGoal(goal.id, 'timeValue', e.target.value)}
                              className="w-14 text-sm border border-gray-200 rounded px-2 py-0.5 focus:outline-none" />
                            <select value={goal.timeUnit} onChange={e => updateGoal(goal.id, 'timeUnit', e.target.value)}
                              className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none bg-white">
                              {TIME_UNITS.map(u => <option key={u}>{u}</option>)}
                            </select>
                          </div>
                        ) : (
                          <span className="text-sm font-semibold text-gray-800">{goal.timeValue}{goal.timeUnit === 'hours' ? 'h' : goal.timeUnit === 'days' ? 'd' : 'm'}</span>
                        )}
                        {editing && gi > 0 && (
                          <button onClick={e => { e.stopPropagation(); removeGoal(goal.id); }}
                            className="ml-2 p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-xs text-gray-400">Priority-based</div>
                      <div className="text-xs text-gray-400">Multiple</div>
                    </>
                  )}
                </div>

                {/* Priority sub-rows */}
                {goal.isPriorityGroup && expandedGoals.includes(goal.id) && goal.priorityRows && (
                  <div className="divide-y divide-gray-100">
                    {goal.priorityRows.map(row => {
                      const pm = getPriorityMeta(row.priority);
                      return (
                        <div key={row.priority} className="grid grid-cols-[1fr_200px_160px] gap-3 px-3 py-2.5 hover:bg-blue-50/30 transition-colors items-center">
                          <div className="flex items-center gap-2 pl-5">
                            <PriorityIcon priority={row.priority} size={14} />
                            <span className="text-sm font-medium capitalize" style={{ color: pm.color }}>{pm.label}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-sm text-gray-600">
                            <Calendar size={13} className="text-gray-400 flex-shrink-0" />
                            {editing ? (
                              <select value={row.calendar}
                                onChange={e => updatePriorityRow(goal.id, row.priority, 'calendar', e.target.value)}
                                className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none bg-white flex-1">
                                {CALENDARS.map(c => <option key={c}>{c}</option>)}
                              </select>
                            ) : (
                              <span className="text-xs truncate">{row.calendar}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {editing ? (
                              <div className="flex items-center gap-1">
                                <input type="number" value={row.timeValue}
                                  onChange={e => updatePriorityRow(goal.id, row.priority, 'timeValue', e.target.value)}
                                  className="w-14 text-sm border border-gray-200 rounded px-2 py-0.5 focus:outline-none" />
                                <select value={row.timeUnit}
                                  onChange={e => updatePriorityRow(goal.id, row.priority, 'timeUnit', e.target.value)}
                                  className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none bg-white">
                                  {TIME_UNITS.map(u => <option key={u}>{u}</option>)}
                                </select>
                              </div>
                            ) : (
                              <span className="text-sm font-semibold text-gray-800">
                                {row.timeValue}{row.timeUnit === 'hours' ? 'h' : row.timeUnit === 'days' ? 'd' : 'm'}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {/* "All remaining priorities" row */}
                    <div className="grid grid-cols-[1fr_200px_160px] gap-3 px-3 py-2.5 bg-gray-50/50 items-center">
                      <span className="text-sm text-gray-500 pl-5">All remaining priorities</span>
                      <div className="flex items-center gap-1.5">
                        <Calendar size={13} className="text-gray-400" />
                        <span className="text-xs text-gray-500">24/7 Calendar (Default)</span>
                      </div>
                      <span className="text-sm text-gray-400">—</span>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* All remaining work items — always last */}
            {editing && (
              <button onClick={addGoal}
                className="w-full flex items-center justify-center gap-1.5 py-2 border border-dashed border-gray-300 rounded-xl text-sm text-gray-400 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50/30 transition-all">
                <Plus size={14} /> Add goal row
              </button>
            )}
          </div>
        </div>

        {/* ── CONDITIONS section ── */}
        <div className="px-5 py-4 border-t border-gray-100">
          <h4 className="text-sm font-bold text-gray-800 mb-1">Conditions</h4>
          <p className="text-xs text-gray-500 mb-4">Time will be measured based on when start/stop/pause conditions are met.</p>
          <div className="space-y-3">
            {/* Start condition */}
            <div className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
              <div className="w-2 h-2 rounded-full bg-green-500 mt-1.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold uppercase tracking-wider text-green-600 mb-0.5">Start condition</p>
                <p className="text-[11px] text-gray-400 mb-1.5">When does the SLA clock start?</p>
                {editing ? (
                  <input value={data.startCondition} onChange={e => setData(d => ({ ...d, startCondition: e.target.value }))}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-100 bg-white" placeholder="e.g. Issue created" />
                ) : (
                  <code className="text-xs text-gray-700 bg-white border border-gray-200 rounded px-2 py-1 font-mono">{data.startCondition}</code>
                )}
              </div>
            </div>

            {/* Pause condition — status multi-select */}
            <div className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
              <div className="w-2 h-2 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold uppercase tracking-wider text-amber-600 mb-0.5">Pause condition</p>
                <p className="text-[11px] text-gray-400 mb-1.5">SLA timer pauses when issue is in these statuses</p>
                {editing ? (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {spaceStatuses.filter(s => !['done'].includes(s.toLowerCase())).map(status => {
                      const selected = (data.pauseStatuses || []).includes(status);
                      return (
                        <button key={status} type="button"
                          onClick={() => setData(d => ({
                            ...d,
                            pauseStatuses: selected
                              ? (d.pauseStatuses || []).filter(s => s !== status)
                              : [...(d.pauseStatuses || []), status],
                          }))}
                          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${selected ? 'bg-amber-100 border-amber-400 text-amber-800' : 'bg-white border-gray-200 text-gray-500 hover:border-amber-300'}`}>
                          {status}
                        </button>
                      );
                    })}
                    {spaceStatuses.length === 0 && <span className="text-xs text-gray-400">No statuses available</span>}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {(data.pauseStatuses || []).length === 0
                      ? <span className="text-xs text-gray-400 italic">None selected</span>
                      : (data.pauseStatuses || []).map(s => (
                          <span key={s} className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 border border-amber-200 text-amber-700">{s}</span>
                        ))
                    }
                  </div>
                )}
              </div>
            </div>

            {/* Stop condition */}
            <div className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
              <div className="w-2 h-2 rounded-full bg-red-500 mt-1.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold uppercase tracking-wider text-red-600 mb-0.5">Stop condition</p>
                <p className="text-[11px] text-gray-400 mb-1.5">When does the SLA clock stop?</p>
                {editing ? (
                  <input value={data.stopCondition} onChange={e => setData(d => ({ ...d, stopCondition: e.target.value }))}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-100 bg-white" placeholder="e.g. Status = Resolved" />
                ) : (
                  <code className="text-xs text-gray-700 bg-white border border-gray-200 rounded px-2 py-1 font-mono">{data.stopCondition}</code>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Bottom Save / Cancel bar (only in edit mode) ── */}
        {editing && (
          <div className="px-5 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2 rounded-b-xl">
            <button
              onClick={() => { setEditing(false); setData(JSON.parse(JSON.stringify(sla))); }}
              className="px-5 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-100 transition-all">
              Cancel
            </button>
            <button
              onClick={() => { onSave(data); setEditing(false); }}
              className="px-6 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-all shadow-sm flex items-center gap-2">
              <Check size={14} /> Save SLA
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Create SLA modal ──────────────────────────────────────────────────────────
function CreateSLAModal({ onClose, onCreate }: { onClose: () => void; onCreate: (sla: SLAItem) => void }) {
  const [name, setName] = useState('');
  const [startCond, setStartCond] = useState('Issue created');
  const [stopCond,  setStopCond]  = useState('Status = Resolved OR Status = Closed');
  const [pauseCond, setPauseCond] = useState('Status = Waiting for customer');

  const handleCreate = () => {
    if (!name.trim()) return;
    const newSLA: SLAItem = {
      id: Date.now().toString(),
      name: name.trim(),
      status: 'active',
      goals: [{
        id: Date.now().toString() + '_g',
        jql: 'type in (Task, Bug)',
        calendar: '24/7 Calendar (Default)',
        timeValue: '',
        timeUnit: 'hours',
        isPriorityGroup: true,
        priorityRows: [
          { priority: 'highest', calendar: '24/7 Calendar (Default)', timeValue: '4',  timeUnit: 'hours' },
          { priority: 'high',    calendar: '24/7 Calendar (Default)', timeValue: '8',  timeUnit: 'hours' },
          { priority: 'medium',  calendar: '24/7 Calendar (Default)', timeValue: '24', timeUnit: 'hours' },
          { priority: 'low',     calendar: '24/7 Calendar (Default)', timeValue: '48', timeUnit: 'hours' },
          { priority: 'lowest',  calendar: '24/7 Calendar (Default)', timeValue: '72', timeUnit: 'hours' },
        ],
      }, {
        id: Date.now().toString() + '_g2',
        jql: 'All remaining work items',
        calendar: '24/7 Calendar (Default)',
        timeValue: '80',
        timeUnit: 'hours',
        isPriorityGroup: false,
      }],
      startCondition: startCond,
      pauseCondition: pauseCond,
      pauseStatuses:  [],
      stopCondition:  stopCond,
    };
    onCreate(newSLA);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-[520px] border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-900">Create SLA</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"><X size={16} /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">SLA name <span className="text-red-500">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
              placeholder="e.g. Time to first response" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Start condition</label>
            <input value={startCond} onChange={e => setStartCond(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100"
              placeholder="e.g. Issue created" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Pause condition</label>
            <input value={pauseCond} onChange={e => setPauseCond(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100"
              placeholder="e.g. Status = Waiting for customer" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Stop condition</label>
            <input value={stopCond} onChange={e => setStopCond(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100"
              placeholder="e.g. Status = Resolved" />
          </div>
          <p className="text-xs text-gray-400 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
            Goals (time targets per priority) can be configured after creation.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-all">Cancel</button>
          <button onClick={handleCreate} disabled={!name.trim()}
            className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-40 transition-all shadow-sm">
            Create SLA
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso: string | undefined): string {
  if (!iso || iso === 'Never') return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months > 1 ? 's' : ''} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years > 1 ? 's' : ''} ago`;
}

// ── EmailTab component ────────────────────────────────────────────────────────
function EmailTab({
  spaceKey, emailEnabled, setEmailEnabled, emailAddress,
  emailAutoReply, setEmailAutoReply, emailAutoReplyText, setEmailAutoReplyText,
  emailDefaultType, setEmailDefaultType,
  connectedEmails, setConnectedEmails,
  showAddEmail, setShowAddEmail,
  newExternalEmail, setNewExternalEmail,
  viewingLogs, setViewingLogs,
  emailLogs, loadEmailLogs,
  sendingTestEmail, setSendingTestEmail,
  testEmailFrom, setTestEmailFrom,
  testEmailSubject, setTestEmailSubject,
  showTestEmailForm, setShowTestEmailForm,
  emailActionsMenuId, setEmailActionsMenuId,
}: {
  spaceKey: string;
  emailEnabled: boolean; setEmailEnabled: (v: any) => void;
  emailAddress: string;
  emailAutoReply: boolean; setEmailAutoReply: (v: any) => void;
  emailAutoReplyText: string; setEmailAutoReplyText: (v: any) => void;
  emailDefaultType: string; setEmailDefaultType: (v: string) => void;
  connectedEmails: any[]; setConnectedEmails: (v: any) => void;
  showAddEmail: boolean; setShowAddEmail: (v: any) => void;
  newExternalEmail: string; setNewExternalEmail: (v: string) => void;
  viewingLogs: string | null; setViewingLogs: (v: string | null) => void;
  emailLogs: any[]; loadEmailLogs: () => void;
  sendingTestEmail: boolean; setSendingTestEmail: (v: boolean) => void;
  testEmailFrom: string; setTestEmailFrom: (v: string) => void;
  testEmailSubject: string; setTestEmailSubject: (v: string) => void;
  showTestEmailForm: boolean; setShowTestEmailForm: (v: any) => void;
  emailActionsMenuId: string | null; setEmailActionsMenuId: (v: string | null) => void;
}) {
  const [connectForm, setConnectForm] = React.useState({ email: '', password: '', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' });
  const [connecting, setConnecting] = React.useState(false);
  const [connectionStatus, setConnectionStatus] = React.useState<{ ok: boolean; message: string; address?: string } | null>(null);
  const [showConnectForm, setShowConnectForm] = React.useState(false);
  const [showProviderSelect, setShowProviderSelect] = React.useState(false);
  const [selectedProvider, setSelectedProvider] = React.useState<'google' | 'microsoft' | 'other' | null>(null);
  const [pollerActive, setPollerActive] = React.useState(false);
  // Reply-to dropdown
  const [showReplyToDropdown, setShowReplyToDropdown] = React.useState(false);
  // Create Neutara email modal
  const [showCreateNeutara, setShowCreateNeutara] = React.useState(false);
  const [neutaraPrefix, setNeutaraPrefix] = React.useState('');
  const [neutaraPassword, setNeutaraPassword] = React.useState('');
  const [neutaraShowPass, setNeutaraShowPass] = React.useState(false);
  const [neutaraRequestType, setNeutaraRequestType] = React.useState('Emailed request');
  const [neutaraNotifyType, setNeutaraNotifyType] = React.useState('admins');
  const [neutaraNotifyEmail, setNeutaraNotifyEmail] = React.useState('');
  const [neutaraNotifyCustomer, setNeutaraNotifyCustomer] = React.useState(true);
  const [neutaraCreating, setNeutaraCreating] = React.useState(false);
  const [neutaraPrefixError, setNeutaraPrefixError] = React.useState('');
  const [neutaraConnectStatus, setNeutaraConnectStatus] = React.useState<{ok: boolean; msg: string} | null>(null);

  React.useEffect(() => {
    fetch('/api/email/connect').then(r => r.json()).then(async d => {
      setPollerActive(d.pollerActive);
      if (d.configured && d.pollerActive) {
        setConnectionStatus({ ok: true, message: `Connected: polling ${d.address}`, address: d.address });
      }

      // Auto-reconnect OAuth emails if poller is not running for them
      const activeEmails = (d.activePollers || []).map((p: any) => p.email?.toLowerCase());
      const savedEmails: any[] = (() => {
        try { return JSON.parse(localStorage.getItem(`connectedEmails_${spaceKey}`) || '[]'); } catch { return []; }
      })();
      for (const em of savedEmails) {
        if (!activeEmails.includes(em.address?.toLowerCase())) {
          // Poller not running — restart via OAuth token
          fetch(`/api/auth/oauth/microsoft?spaceKey=${spaceKey}&returnUrl=${encodeURIComponent(`/spaces/${spaceKey}/settings?tab=email`)}&mode=restart&loginHint=${encodeURIComponent(em.address)}`).catch(() => {});
          // Try to reconnect using stored token via email/connect
          fetch('/api/email/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: em.address,
              imapHost: 'outlook.office365.com',
              smtpHost: 'smtp.office365.com',
              spaceKey,
              autoReply: true,
              appUrl: window.location.origin,
            }),
          }).catch(() => {});
        }
      }
    }).catch(() => {});
  }, []);

  const emailsWithLiveData = connectedEmails.map((e: any) => {
    if (e.isReplyTo && emailLogs.length > 0) {
      return { ...e, lastReceivedIso: emailLogs[0].time };
    }
    return e;
  });

  return (
    <div className="space-y-0" onClick={() => { setEmailActionsMenuId(null); setShowReplyToDropdown(false); }}>

      {/* Page header */}
      <div className="flex items-start justify-between pb-5 border-b border-gray-200">
        <div className="flex-1">
          <h2 className="text-[22px] font-semibold text-gray-900 mb-2">Email</h2>
          <p className="text-[13.5px] text-gray-700 max-w-2xl leading-relaxed">
            Use the email channel to turn customer emails into requests in your service space. Each service space can have up to 10 connected email accounts.{' '}
            <span className="text-blue-600 hover:underline cursor-pointer text-[13.5px]">Find more information on connecting multiple email addresses.</span>
          </p>
          <p className="text-[13.5px] text-gray-700 mt-2">
            Manage permissions for sending email requests and adding other participants by email in{' '}
            <span className="text-blue-600 hover:underline cursor-pointer">Customer permissions</span>.
          </p>
        </div>
        <button className="p-1.5 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 ml-4 flex-shrink-0">
          <MoreHorizontal size={18} />
        </button>
      </div>

      {/* Virtual service agent */}
      <div className="py-6 border-b border-gray-200">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-[14.5px] font-semibold text-gray-900 mb-1">Virtual service agent</p>
            <p className="text-[13px] text-gray-600">
              Automatically respond to email requests with{' '}
              <span className="text-blue-600 hover:underline cursor-pointer inline-flex items-center gap-0.5">
                AI answers <ExternalLink size={11} className="inline" />
              </span>{' '}
              using relevant information from your knowledge base.
            </p>
          </div>
          <button onClick={(e) => { e.stopPropagation(); setEmailEnabled((v: boolean) => !v); }}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${emailEnabled ? 'bg-blue-600' : 'bg-gray-300'}`}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${emailEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      {/* Reply-to address */}
      <div className="py-6 border-b border-gray-200">
        <p className="text-[14.5px] font-semibold text-gray-900 mb-1">Reply-to address</p>
        <p className="text-[13px] text-gray-600 mb-3 max-w-2xl">
          The selected email address is used when customers reply to email notifications for requests raised via channels other than email.{' '}
          <span className="text-blue-600 hover:underline cursor-pointer">Read more about reply-to email addresses.</span>
        </p>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setShowReplyToDropdown(v => !v); }}
              className="flex items-center gap-2 border border-gray-300 rounded px-3 py-1.5 text-[13px] text-gray-700 bg-white hover:bg-gray-50 min-w-[260px] text-left"
            >
              <span className="flex-1 truncate">
                {connectedEmails.find((e: any) => e.isReplyTo)?.address || emailAddress}
              </span>
              <ChevronDown size={13} className="ml-auto text-gray-400 flex-shrink-0" />
            </button>
            {showReplyToDropdown && (
              <div className="absolute left-0 top-full mt-1 z-30 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[260px]" onClick={e => e.stopPropagation()}>
                {connectedEmails.length === 0 ? (
                  <div className="px-4 py-2 text-[12px] text-gray-400">No email accounts connected yet.</div>
                ) : (
                  connectedEmails.map((email: any) => (
                    <button
                      key={email.id}
                      onClick={() => {
                        setConnectedEmails((prev: any[]) => prev.map((e: any) => ({ ...e, isReplyTo: e.id === email.id })));
                        setShowReplyToDropdown(false);
                      }}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-gray-700 hover:bg-gray-50 text-left"
                    >
                      <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
                        {email.isReplyTo && <Check size={14} className="text-blue-600" />}
                      </div>
                      <span className="truncate">{email.address}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setShowReplyToDropdown(false)}
            className="px-3 py-1.5 border border-gray-300 rounded text-[13px] text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Update
          </button>
        </div>
      </div>

      {/* Connected email accounts */}
      <div className="py-6 border-b border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[14.5px] font-semibold text-gray-900">Connected email accounts</p>
          <div className="flex items-center gap-2">
            <button onClick={(e) => { e.stopPropagation(); setShowCreateNeutara(true); setNeutaraPrefix(''); setNeutaraPrefixError(''); setNeutaraNotifyType('admins'); setNeutaraNotifyEmail(''); setNeutaraNotifyCustomer(true); setNeutaraRequestType('Emailed request'); }}
              className="px-3 py-1.5 bg-blue-600 text-white text-[13px] font-medium rounded hover:bg-blue-700 transition-colors">
              Create CloudFuze email
            </button>
            <button onClick={(e) => { e.stopPropagation(); setShowProviderSelect(true); setShowAddEmail(false); setConnectionStatus(null); }}
              className="px-3 py-1.5 border border-gray-300 text-[13px] text-gray-700 rounded hover:bg-gray-50 transition-colors">
              Add external email
            </button>
          </div>
        </div>

        {/* Add external email — full connect form */}
        {showAddEmail && (
          <div className="mb-4 border border-blue-200 bg-blue-50/40 rounded-xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-blue-100 bg-white">
              <div className="flex items-center gap-2">
                {selectedProvider === 'google' ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" className="flex-shrink-0">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                ) : selectedProvider === 'microsoft' ? (
                  <svg width="18" height="18" viewBox="0 0 21 21" className="flex-shrink-0">
                    <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
                    <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
                    <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
                    <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
                  </svg>
                ) : (
                  <div className="w-[18px] h-[18px] rounded bg-blue-600 flex items-center justify-center flex-shrink-0">
                    <Mail size={11} className="text-white" />
                  </div>
                )}
                <p className="text-[13.5px] font-semibold text-gray-900">
                  {selectedProvider === 'google' ? 'Connect Gmail' : selectedProvider === 'microsoft' ? 'Connect Microsoft / Outlook' : 'Connect email inbox'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { setShowAddEmail(false); setShowProviderSelect(true); setConnectionStatus(null); }}
                  className="text-[12px] text-blue-600 hover:underline">← Back</button>
                <button onClick={() => { setShowAddEmail(false); setSelectedProvider(null); setNewExternalEmail(''); setConnectForm(f => ({ ...f, email: '', password: '' })); setConnectionStatus(null); }}
                  className="p-1 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100">
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="px-5 py-4 space-y-4">
              {/* Provider — only show for "other", Google/Microsoft are pre-set */}
              {selectedProvider === 'other' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-1.5">IMAP Host</label>
                    <input type="text" value={connectForm.imapHost} onChange={e => setConnectForm(f => ({ ...f, imapHost: e.target.value }))}
                      className="input-field w-full" placeholder="imap.yourprovider.com" />
                  </div>
                  <div>
                    <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-1.5">SMTP Host</label>
                    <input type="text" value={connectForm.smtpHost} onChange={e => setConnectForm(f => ({ ...f, smtpHost: e.target.value }))}
                      className="input-field w-full" placeholder="smtp.yourprovider.com" />
                  </div>
                </div>
              )}
              {/* Email + Password */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Email address</label>
                  <input
                    type="email"
                    value={connectForm.email || newExternalEmail}
                    onChange={e => { setConnectForm(f => ({ ...f, email: e.target.value })); setNewExternalEmail(e.target.value); }}
                    className="input-field w-full"
                    placeholder="support@gmail.com"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-1.5">
                    {selectedProvider === 'google' ? 'App Password' : 'Password'}
                  </label>
                  <input
                    type="password"
                    value={connectForm.password}
                    onChange={e => setConnectForm(f => ({ ...f, password: e.target.value }))}
                    className="input-field w-full"
                    placeholder={selectedProvider === 'google' ? 'xxxx xxxx xxxx xxxx' : '••••••••'}
                  />
                </div>
              </div>
              {/* Request type */}
              <div>
                <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Request type</label>
                <select value={emailDefaultType} onChange={e => setEmailDefaultType(e.target.value)} className="input-field w-full">
                  <option value="task">Emailed request</option>
                  <option value="bug">Bug report</option>
                  <option value="story">Feature request</option>
                </select>
              </div>
              {/* Gmail hint */}
              {selectedProvider === 'google' && (
                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <Info size={13} className="text-amber-600 mt-0.5 flex-shrink-0" />
                  <p className="text-[12px] text-amber-800">
                    Gmail requires an <strong>App Password</strong> (not your regular password).{' '}
                    <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="underline text-blue-700 font-medium">
                      Create one here
                    </a>{' '}
                    → select "Mail" → copy the 16-character code.
                  </p>
                </div>
              )}
              {/* Error */}
              {connectionStatus && !connectionStatus.ok && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-[12px] text-red-700 flex items-start gap-2">
                  <X size={13} className="mt-0.5 flex-shrink-0" />
                  {connectionStatus.message}
                </div>
              )}
              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  disabled={connecting}
                  onClick={async () => {
                    const email = connectForm.email || newExternalEmail;
                    if (!email || !connectForm.password) { alert('Email and password are required.'); return; }
                    setConnecting(true); setConnectionStatus(null);
                    try {
                      const rt = emailDefaultType === 'task' ? 'Emailed request' : emailDefaultType === 'bug' ? 'Bug report' : 'Feature request';
                      const res = await fetch('/api/email/connect', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          email,
                          password: connectForm.password,
                          imapHost: connectForm.imapHost,
                          smtpHost: connectForm.smtpHost,
                          spaceKey,
                          autoReply: emailAutoReply,
                          autoReplyText: emailAutoReplyText,
                          appUrl: window.location.origin,
                        }),
                      });
                      const result = await res.json();
                      if (result.ok) {
                        // Register in mock store
                        try {
                          const rec = await api.addEmailAddress(spaceKey, { address: email, requestType: rt, isReplyTo: false, autoReply: emailAutoReply });
                          setConnectedEmails((prev: any[]) => {
                            const already = prev.find((x: any) => x.address === email);
                            if (already) return prev;
                            return [...prev, { id: rec.id, address: rec.address, requestType: rt, isReplyTo: false, lastReceivedIso: undefined, logs: [] }];
                          });
                        } catch {
                          setConnectedEmails((prev: any[]) => {
                            const already = prev.find((x: any) => x.address === email);
                            if (already) return prev;
                            return [...prev, { id: `ext_${Date.now()}`, address: email, requestType: rt, isReplyTo: false, lastReceivedIso: undefined, logs: [] }];
                          });
                        }
                        setPollerActive(true);
                        setConnectionStatus({ ok: true, message: result.message, address: email });
                        setShowAddEmail(false);
                        setNewExternalEmail('');
                        setConnectForm(f => ({ ...f, password: '' }));
                      } else {
                        setConnectionStatus({ ok: false, message: result.error || 'Connection failed. Check your credentials.' });
                      }
                    } catch {
                      setConnectionStatus({ ok: false, message: 'Network error — make sure the app is running.' });
                    } finally {
                      setConnecting(false);
                    }
                  }}
                  className="px-4 py-2 bg-blue-600 text-white text-[13px] font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {connecting ? (
                    <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Testing connection…</>
                  ) : (
                    <><Mail size={13} />Connect & start polling</>
                  )}
                </button>
                <button onClick={() => { setShowAddEmail(false); setSelectedProvider(null); setNewExternalEmail(''); setConnectForm(f => ({ ...f, email: '', password: '' })); setConnectionStatus(null); }}
                  className="px-4 py-2 border border-gray-300 text-[13px] text-gray-600 rounded-lg hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Accounts table */}
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="pb-2 text-left text-[13px] font-semibold text-gray-800">Email address</th>
              <th className="pb-2 text-left text-[13px] font-semibold text-gray-800 px-4">Request type</th>
              <th className="pb-2 text-left text-[13px] font-semibold text-gray-800 px-4">Incoming email logs</th>
              <th className="pb-2 text-left text-[13px] font-semibold text-gray-800 px-4">Last email received</th>
              <th className="pb-2 text-left text-[13px] font-semibold text-gray-800 px-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {emailsWithLiveData.length === 0 ? (
              <tr><td colSpan={5} className="py-10 text-center text-[13px] text-gray-400">No email accounts connected yet.</td></tr>
            ) : emailsWithLiveData.map((email: any) => (
              <tr key={email.id} className="hover:bg-gray-50 transition-colors group">
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded bg-blue-600 flex items-center justify-center flex-shrink-0">
                      <Zap size={13} className="text-white fill-white" />
                    </div>
                    <span className="text-[13.5px] text-gray-900">{email.address}</span>
                    {email.isReplyTo && (
                      <span className="text-[10px] font-semibold bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-sm uppercase tracking-wide leading-tight">
                        Reply-to address
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-3 px-4">
                  <Link
                    href={`/spaces/${spaceKey}/settings/request-types/${email.requestType.toLowerCase().replace(/\s+/g, '-')}`}
                    className="text-[13.5px] text-blue-600 hover:underline"
                    onClick={e => e.stopPropagation()}
                  >
                    {email.requestType}
                  </Link>
                </td>
                <td className="py-3 px-4">
                  <button onClick={(e) => { e.stopPropagation(); setViewingLogs(email.id); }}
                    className="text-[13.5px] text-blue-600 hover:underline hover:text-blue-800">
                    View logs
                    {emailLogs.length > 0 && email.isReplyTo && (
                      <span className="ml-1.5 bg-blue-600 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5">
                        {emailLogs.length}
                      </span>
                    )}
                  </button>
                </td>
                <td className="py-3 px-4 text-[13.5px] text-gray-600">
                  {email.lastReceivedIso ? timeAgo(email.lastReceivedIso) : 'No emails received'}
                </td>
                <td className="py-3 px-4">
                  <div className="relative">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEmailActionsMenuId(emailActionsMenuId === email.id ? null : email.id); }}
                      className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200 transition-colors">
                      <MoreHorizontal size={15} />
                    </button>
                    {emailActionsMenuId === email.id && (
                      <div className="absolute right-0 top-7 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-56" onClick={e => e.stopPropagation()}>
                        {!email.isReplyTo && (
                          <button onClick={() => {
                            setConnectedEmails((prev: any[]) => prev.map((e: any) => ({ ...e, isReplyTo: e.id === email.id })));
                            setEmailActionsMenuId(null);
                          }} className="w-full text-left px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50">
                            Set as reply-to address
                          </button>
                        )}
                        <button onClick={() => { setViewingLogs(email.id); setEmailActionsMenuId(null); }}
                          className="w-full text-left px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50">
                          View incoming email logs
                        </button>
                        <button onClick={(e) => {
                          e.stopPropagation();
                          setEmailActionsMenuId(null);
                          setConnectForm(f => ({ ...f, email: email.address }));
                          setShowConnectForm(true);
                        }} className="w-full text-left px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50">
                          {pollerActive && connectionStatus?.address === email.address ? '⚡ Disconnect inbox' : 'Connect inbox (IMAP)'}
                        </button>
                        <button onClick={(e) => {
                          e.stopPropagation();
                          setEmailActionsMenuId(null);
                          setTestEmailFrom('customer@example.com');
                          setTestEmailSubject('Need help with my account');
                          setShowTestEmailForm(true);
                        }} className="w-full text-left px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50">
                          Send test email
                        </button>
                        <button onClick={() => { alert('Email channel disabled.'); setEmailActionsMenuId(null); }}
                          className="w-full text-left px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50">
                          Disable
                        </button>
                        <div className="border-t border-gray-100 my-1" />
                        <button onClick={async () => {
                          if (!window.confirm(`Remove ${email.address}? Emails to this address will no longer create tickets.`)) return;
                          try {
                            await api.removeEmailAddress(spaceKey, email.id);
                            setConnectedEmails((prev: any[]) => {
                              const next = prev.filter((e: any) => e.id !== email.id);
                              try { localStorage.setItem(`connectedEmails_${spaceKey}`, JSON.stringify(next)); } catch {}
                              return next;
                            });
                          } catch { alert('Failed to remove.'); }
                          setEmailActionsMenuId(null);
                        }} className="w-full text-left px-4 py-2 text-[13px] text-red-600 hover:bg-red-50">
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Incoming email logs modal */}
      {viewingLogs && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setViewingLogs(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-[680px] max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <p className="text-[16px] font-semibold text-gray-900">Incoming email logs</p>
                <p className="text-[12px] text-gray-500 mt-0.5">
                  {connectedEmails.find((e: any) => e.id === viewingLogs)?.address} — emails automatically create issues
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={loadEmailLogs}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded text-[12px] text-gray-600 hover:bg-gray-50">
                  <RefreshCw size={12} /> Refresh
                </button>
                <button onClick={() => setViewingLogs(null)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100">
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {emailLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center px-6">
                  <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center mb-4">
                    <Mail size={20} className="text-blue-400" />
                  </div>
                  <p className="text-[14px] font-semibold text-gray-700">No incoming emails yet</p>
                  <p className="text-[13px] text-gray-400 mt-1.5 max-w-sm">When a customer emails your support address, a ticket is automatically created and logged here in real time.</p>
                  <button onClick={() => { setViewingLogs(null); setShowTestEmailForm(true); }}
                    className="mt-4 px-4 py-2 bg-blue-600 text-white text-[13px] font-medium rounded hover:bg-blue-700">
                    Send a test email
                  </button>
                </div>
              ) : (
                <>
                  <div className="px-6 py-2 bg-green-50 border-b border-green-100 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-[12px] text-green-700 font-medium">Live — auto-refreshes every 10 seconds</span>
                  </div>
                  <table className="w-full text-[13px]">
                    <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-6 py-3 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">From</th>
                        <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Subject</th>
                        <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Issue created</th>
                        <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Received</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {emailLogs.map((log: any) => (
                        <tr key={log.id} className="hover:bg-gray-50">
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-[11px] font-bold text-blue-700 flex-shrink-0 uppercase">
                                {(log.from || '?')[0]}
                              </div>
                              <span className="text-gray-800">{log.from}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-gray-700 max-w-[200px]">
                            <span className="block truncate">{log.subject}</span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-blue-600 font-semibold hover:underline cursor-pointer">{log.issue}</span>
                            <span className="ml-2 text-[10px] bg-green-100 text-green-700 font-semibold px-1.5 py-0.5 rounded uppercase">Created</span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-[12px]">{timeAgo(log.time)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Create Neutara Email Modal (Jira-style) ── */}
      {showCreateNeutara && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={() => setShowCreateNeutara(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-[600px] overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-start justify-between px-8 pt-8 pb-2">
              <div>
                <h2 className="text-[22px] font-semibold text-gray-900 mb-1.5">Create new CloudFuze email address</h2>
                <p className="text-[14px] text-gray-600">
                  Customers can use this email address to raise requests only in <strong>{spaceKey}</strong>.
                </p>
              </div>
              <button onClick={() => setShowCreateNeutara(false)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100 -mt-1 ml-4 flex-shrink-0">
                <X size={20} />
              </button>
            </div>

            <div className="px-8 py-5 space-y-5">
              {/* Email address row */}
              <div>
                <label className="block text-[13px] font-semibold text-gray-800 mb-1.5">
                  Email address <span className="text-red-500">*</span>
                </label>
                <div className="flex items-stretch rounded-lg overflow-hidden border border-gray-300 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500">
                  <input
                    type="text"
                    value={neutaraPrefix}
                    onChange={e => {
                      const val = e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '');
                      setNeutaraPrefix(val);
                      setNeutaraPrefixError('');
                    }}
                    placeholder="e.g. l1board"
                    autoFocus
                    className="flex-1 px-3 py-2.5 text-[13.5px] outline-none bg-white min-w-0"
                  />
                  <div className="flex items-center px-3 bg-gray-50 text-[13px] text-gray-500 whitespace-nowrap select-none border-l border-gray-200">
                    @cloudfuze.com
                  </div>
                </div>
                {neutaraPrefixError && (
                  <p className="mt-1 text-[12px] text-red-600">{neutaraPrefixError}</p>
                )}
                {neutaraPrefix && (
                  <p className="mt-1 text-[12px] text-gray-500">
                    Full address: <strong>{neutaraPrefix}@cloudfuze.com</strong>
                  </p>
                )}
              </div>

              {/* Request type */}
              <div>
                <label className="block text-[12.5px] font-semibold text-gray-700 mb-1.5">
                  Request type <span className="text-red-500">*</span>
                </label>
                <select
                  value={neutaraRequestType}
                  onChange={e => setNeutaraRequestType(e.target.value)}
                  className="input-field w-full"
                >
                  <option value="Emailed request">Emailed request</option>
                  <option value="Bug report">Bug report</option>
                  <option value="Feature request">Feature request</option>
                </select>
              </div>

              {/* Notify customers toggle */}
              <div className="flex items-start gap-3 py-0.5">
                <button
                  type="button"
                  onClick={() => setNeutaraNotifyCustomer(v => !v)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 mt-0.5 focus:outline-none ${neutaraNotifyCustomer ? 'bg-blue-600' : 'bg-gray-300'}`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${neutaraNotifyCustomer ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
                <div>
                  <p className="text-[13.5px] font-medium text-gray-800">Auto-reply with ticket number</p>
                  <p className="text-[12.5px] text-gray-500 mt-0.5">
                    Sender receives an auto-reply with the ticket number when their email creates a ticket.
                  </p>
                </div>
              </div>

              {/* Microsoft OAuth info box */}
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-4">
                <p className="text-[13px] font-semibold text-blue-800 mb-1">Microsoft 365 Authentication</p>
                <p className="text-[12.5px] text-blue-700 leading-relaxed">
                  Click <strong>"Connect with Microsoft"</strong> below. You'll be asked to sign in as{' '}
                  <strong>{neutaraPrefix ? `${neutaraPrefix}@cloudfuze.com` : 'prefix@cloudfuze.com'}</strong>{' '}
                  using Microsoft OAuth. This securely connects the inbox without needing a password.
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="px-8 py-5 border-t border-gray-100">
              <div className="flex justify-end gap-3">
                <button onClick={() => { setShowCreateNeutara(false); setNeutaraPrefixError(''); }}
                  className="px-4 py-2 text-[13px] text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (!neutaraPrefix.trim()) { setNeutaraPrefixError('Email prefix is required.'); return; }
                    if (neutaraPrefix.length < 2) { setNeutaraPrefixError('Prefix must be at least 2 characters.'); return; }
                    const address = `${neutaraPrefix.trim()}@cloudfuze.com`;
                    if (connectedEmails.find((e: any) => e.address === address)) {
                      setNeutaraPrefixError('This email address is already connected.');
                      return;
                    }
                    // Save pending config to localStorage so the OAuth callback can read it
                    localStorage.setItem('pending_email_config', JSON.stringify({
                      requestType: neutaraRequestType,
                      autoReply: neutaraNotifyCustomer,
                    }));
                    // Redirect to Microsoft OAuth — user signs in as l1board@cloudfuze.com
                    const returnUrl = `/spaces/${spaceKey}/settings?tab=email`;
                    const oauthUrl = `/api/auth/oauth/microsoft?spaceKey=${spaceKey}&returnUrl=${encodeURIComponent(returnUrl)}&mode=email&loginHint=${encodeURIComponent(address)}`;
                    window.location.href = oauthUrl;
                  }}
                  className="flex items-center gap-2 px-5 py-2 bg-[#0078D4] text-white text-[13px] font-medium rounded-lg hover:bg-[#006CBE] transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 1h10v10H1z" fill="#F25022"/>
                    <path d="M12 1h10v10H12z" fill="#7FBA00"/>
                    <path d="M1 12h10v10H1z" fill="#00A4EF"/>
                    <path d="M12 12h10v10H12z" fill="#FFB900"/>
                  </svg>
                  Connect with Microsoft
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Provider Selection Modal (Jira-style) ── */}
      {showProviderSelect && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={() => setShowProviderSelect(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-[520px] overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-start justify-between px-8 pt-8 pb-0">
              <div>
                <h2 className="text-[20px] font-semibold text-gray-900 mb-1.5">Add external email address</h2>
                <p className="text-[13.5px] text-gray-500">Select an email provider to get started.</p>
              </div>
              <button onClick={() => setShowProviderSelect(false)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100 -mt-1">
                <X size={18} />
              </button>
            </div>

            {/* Provider buttons */}
            <div className="px-8 py-6 space-y-3">
              {/* Google */}
              <button
                onClick={() => {
                  // Use real OAuth if configured, otherwise fall back to IMAP form
                  const oauthUrl = `/api/auth/oauth/google?spaceKey=${spaceKey}&returnUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`;
                  setShowProviderSelect(false);
                  window.location.href = oauthUrl;
                }}
                className="w-full flex items-center gap-4 px-5 py-4 border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all text-left"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" className="flex-shrink-0">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                <span className="text-[15px] font-medium text-gray-800">Continue with Google</span>
              </button>

              {/* Microsoft */}
              <button
                onClick={() => {
                  const oauthUrl = `/api/auth/oauth/microsoft?spaceKey=${spaceKey}&returnUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`;
                  setShowProviderSelect(false);
                  window.location.href = oauthUrl;
                }}
                className="w-full flex items-center gap-4 px-5 py-4 border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all text-left"
              >
                <svg width="22" height="22" viewBox="0 0 21 21" className="flex-shrink-0">
                  <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
                  <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
                  <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
                  <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
                </svg>
                <span className="text-[15px] font-medium text-gray-800">Continue with Microsoft</span>
              </button>

              {/* Other */}
              <button
                onClick={() => {
                  setSelectedProvider('other');
                  setConnectForm(f => ({ ...f, imapHost: '', smtpHost: '', email: '', password: '' }));
                  setShowProviderSelect(false);
                  setShowAddEmail(true);
                  setConnectionStatus(null);
                }}
                className="w-full flex items-center gap-4 px-5 py-4 border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all text-left"
              >
                <div className="w-[22px] h-[22px] rounded-full border-2 border-gray-400 flex items-center justify-center flex-shrink-0">
                  <Mail size={11} className="text-gray-500" />
                </div>
                <span className="text-[15px] font-medium text-gray-800">Continue with Other</span>
              </button>
            </div>

            {/* Footer */}
            <div className="px-8 pb-6 space-y-4">
              <p className="text-[11px] text-gray-400 leading-relaxed">
                * Use and transfer of information received from mail providers will comply with their respective API Services User Data Policies, including the Limited Use requirements.
              </p>
              <div className="flex justify-end">
                <button onClick={() => setShowProviderSelect(false)}
                  className="px-4 py-2 text-[13px] text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── IMAP Connect Modal ── */}
      {showConnectForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowConnectForm(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-[540px] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <p className="text-[16px] font-semibold text-gray-900">
                {pollerActive ? 'IMAP inbox connected' : 'Connect inbox (IMAP)'}
              </p>
              <button onClick={() => setShowConnectForm(false)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100"><X size={16} /></button>
            </div>
            <div className="p-6 space-y-4">
              {pollerActive && connectionStatus?.ok ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
                    <p className="text-[13px] text-green-800 font-medium">{connectionStatus.message}</p>
                  </div>
                  <p className="text-[12.5px] text-gray-500">New emails to <strong>{connectionStatus.address}</strong> are checked every 30 seconds and create tickets automatically.</p>
                  <button onClick={async () => {
                    await fetch('/api/email/connect', { method: 'DELETE' });
                    setPollerActive(false); setConnectionStatus(null); setShowConnectForm(false);
                  }} className="px-4 py-2 border border-red-300 text-red-600 text-[13px] rounded hover:bg-red-50">
                    Disconnect
                  </button>
                </div>
              ) : (
                <>
                  <div className="p-3 bg-yellow-50 border border-yellow-200 rounded text-[12px] text-yellow-800">
                    <strong>Gmail:</strong> Use an <strong>App Password</strong> — go to{' '}
                    <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="underline text-blue-700">myaccount.google.com/apppasswords</a> → create password for "Mail".
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[12px] font-semibold text-gray-600 mb-1">Email address</label>
                      <input type="email" value={connectForm.email} onChange={e => setConnectForm(f => ({ ...f, email: e.target.value }))}
                        className="input-field w-full" placeholder="support@gmail.com" />
                    </div>
                    <div>
                      <label className="block text-[12px] font-semibold text-gray-600 mb-1">App Password</label>
                      <input type="password" value={connectForm.password} onChange={e => setConnectForm(f => ({ ...f, password: e.target.value }))}
                        className="input-field w-full" placeholder="xxxx xxxx xxxx xxxx" />
                    </div>
                    <div>
                      <label className="block text-[12px] font-semibold text-gray-600 mb-1">IMAP Host</label>
                      <select value={connectForm.imapHost} onChange={e => setConnectForm(f => ({ ...f, imapHost: e.target.value, smtpHost: e.target.value === 'imap.gmail.com' ? 'smtp.gmail.com' : e.target.value === 'outlook.office365.com' ? 'smtp.office365.com' : f.smtpHost }))} className="input-field w-full">
                        <option value="imap.gmail.com">Gmail (imap.gmail.com)</option>
                        <option value="outlook.office365.com">Outlook / Office 365</option>
                        <option value="imap.yahoo.com">Yahoo Mail</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[12px] font-semibold text-gray-600 mb-1">Tickets created in space</label>
                      <input type="text" value={spaceKey} readOnly className="input-field w-full bg-gray-50 text-gray-500" />
                    </div>
                  </div>
                  {connectionStatus && !connectionStatus.ok && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded text-[12px] text-red-700">❌ {connectionStatus.message}</div>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <button disabled={connecting} onClick={async () => {
                      if (!connectForm.email || !connectForm.password) { alert('Email and password required.'); return; }
                      setConnecting(true); setConnectionStatus(null);
                      try {
                        const res = await fetch('/api/email/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: connectForm.email, password: connectForm.password, imapHost: connectForm.imapHost, smtpHost: connectForm.smtpHost, spaceKey, autoReply: emailAutoReply, autoReplyText: emailAutoReplyText, appUrl: window.location.origin }) });
                        const result = await res.json();
                        if (result.ok) {
                          setPollerActive(true); setShowConnectForm(false);
                          setConnectionStatus({ ok: true, message: result.message, address: result.address });
                          setConnectedEmails((prev: any[]) => { const already = prev.find((x: any) => x.address === connectForm.email); if (already) return prev; return [...prev, { id: `real_${Date.now()}`, address: connectForm.email, requestType: 'Emailed request', isReplyTo: false, lastReceivedIso: undefined, logs: [] }]; });
                        } else { setConnectionStatus({ ok: false, message: result.error || 'Connection failed.' }); }
                      } catch { setConnectionStatus({ ok: false, message: 'Network error.' }); }
                      finally { setConnecting(false); }
                    }} className="px-4 py-2 bg-blue-600 text-white text-[13px] font-medium rounded hover:bg-blue-700 disabled:opacity-50">
                      {connecting ? 'Testing connection…' : 'Connect & start polling'}
                    </button>
                    <button onClick={() => setShowConnectForm(false)} className="px-4 py-2 border border-gray-300 text-[13px] text-gray-600 rounded hover:bg-gray-50">Cancel</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Test Email Modal ── */}
      {showTestEmailForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowTestEmailForm(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-[560px] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <p className="text-[16px] font-semibold text-gray-900">Send test email</p>
                <p className="text-[12px] text-gray-500 mt-0.5">Simulates an inbound email through the full pipeline</p>
              </div>
              <button onClick={() => setShowTestEmailForm(false)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100"><X size={16} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-2 p-2.5 bg-blue-50 border border-blue-100 rounded text-[12px] text-blue-700">
                <span className="font-semibold">Webhook URL:</span>
                <code className="font-mono text-[11px]">{typeof window !== 'undefined' ? window.location.origin : ''}/api/email/receive</code>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">From (customer email)</label>
                  <input type="email" value={testEmailFrom} onChange={e => setTestEmailFrom(e.target.value)} className="input-field w-full" placeholder="customer@example.com" />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">To (service address)</label>
                  <select className="input-field w-full" id="testEmailToModal">
                    {connectedEmails.map((e: any) => <option key={e.id} value={e.address}>{e.address}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Subject</label>
                  <input type="text" value={testEmailSubject} onChange={e => setTestEmailSubject(e.target.value)} className="input-field w-full" placeholder="Need help with my account" />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button disabled={sendingTestEmail} onClick={async () => {
                  setSendingTestEmail(true);
                  const toAddr = (document.getElementById('testEmailToModal') as HTMLSelectElement)?.value || connectedEmails.find((e: any) => e.isReplyTo)?.address || connectedEmails[0]?.address || '';
                  try {
                    const result = await api.receiveEmail({ from: testEmailFrom, to: toAddr, subject: testEmailSubject, body: `Test email from ${testEmailFrom} sent via the test panel.` });
                    loadEmailLogs(); setShowTestEmailForm(false);
                    setViewingLogs(connectedEmails.find((e: any) => e.isReplyTo)?.id || connectedEmails[0]?.id || null);
                    alert(`✅ ${result.message || `Issue ${result.issueKey} created!`}${result.autoReply ? `\n📧 Auto-reply queued to ${testEmailFrom}` : ''}`);
                  } catch (err: any) { alert(err?.message || 'Failed.'); }
                  finally { setSendingTestEmail(false); }
                }} className="px-4 py-2 bg-blue-600 text-white text-[13px] font-medium rounded hover:bg-blue-700 disabled:opacity-50">
                  {sendingTestEmail ? 'Sending…' : 'Send test email'}
                </button>
                <button onClick={() => setShowTestEmailForm(false)} className="px-4 py-2 border border-gray-300 text-[13px] text-gray-600 rounded hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auto-reply */}
      <div className="py-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-[14.5px] font-semibold text-gray-900 mb-1">Auto-reply</p>
            <p className="text-[13px] text-gray-600">Automatically send a reply to customers when their email creates a new issue.</p>
          </div>
          <button onClick={(e) => { e.stopPropagation(); setEmailAutoReply((v: boolean) => !v); }}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${emailAutoReply ? 'bg-blue-600' : 'bg-gray-300'}`}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${emailAutoReply ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        {emailAutoReply && (
          <div className="mt-4">
            <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Auto-reply message</label>
            <textarea rows={4} value={emailAutoReplyText} onChange={e => setEmailAutoReplyText(e.target.value)}
              className="input-field w-full max-w-2xl resize-none text-[13px]" />
            <p className="text-[12px] text-gray-400 mt-1.5">This message is sent to customers immediately after their email creates a ticket.</p>
          </div>
        )}
      </div>

    </div>
  );
}

// ── Automation Tab ────────────────────────────────────────────────────────────
const WORK_TYPES = ['Task', 'Bug', 'Story', 'Sub-task', 'Epic', 'Incident', 'Change', 'Problem', 'Service Request'];

// Standard ticket fields that can be copied to the new ticket
const STANDARD_FIELDS = [
  { id: 'summary',      label: 'Summary',       icon: '📝', category: 'Basic' },
  { id: 'description',  label: 'Description',   icon: '📄', category: 'Basic' },
  { id: 'priority',     label: 'Priority',      icon: '🔺', category: 'Basic' },
  { id: 'type',         label: 'Issue Type',    icon: '🏷️', category: 'Basic' },
  { id: 'assignee',     label: 'Assignee',      icon: '👤', category: 'People' },
  { id: 'reporter',     label: 'Reporter',      icon: '👤', category: 'People' },
  { id: 'dueDate',      label: 'Due Date',      icon: '📅', category: 'Dates' },
  { id: 'storyPoints',  label: 'Story Points',  icon: '🎯', category: 'Planning' },
  { id: 'labels',       label: 'Labels',        icon: '🔖', category: 'Planning' },
  { id: 'sprintId',     label: 'Sprint',        icon: '🏃', category: 'Planning' },
];

interface AutoRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { statuses: string[] };
  condition: { status: string };
  createAction: { spaceKey: string; workType: string };
  copyFields: string[]; // field ids to copy to the new ticket
}

function AutomationTab({ spaceKey, currentStatuses }: {
  spaceKey: string;
  currentStatuses: string[];
}) {
  const [allSpaces, setAllSpaces] = useState<any[]>([]);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    api.getSpaces().then(setAllSpaces).catch(() => {});
    // Load persisted flow rules
    api.getFlowRules(spaceKey).then((data) => {
      const flowRules = data.filter((r: any) => r.trigger !== undefined);
      if (flowRules.length > 0) {
        setRules(flowRules.map((r: any) => ({
          id: r.id,
          name: r.name || `${spaceKey} TO L2 TICKET`,
          enabled: r.enabled !== false,
          trigger: r.trigger || { statuses: [] },
          condition: r.condition || { status: '' },
          createAction: r.createAction || { spaceKey: '', workType: 'Task' },
          copyFields: r.copyFields || ['summary', 'priority', 'description'],
        })));
      }
    }).catch(() => {});
  }, [spaceKey]);

  const defaultRule: AutoRule = {
    id: '1',
    name: `${spaceKey} TO L2 TICKET`,
    enabled: true,
    trigger: { statuses: [] },
    condition: { status: '' },
    createAction: { spaceKey: '', workType: 'Task' },
    copyFields: ['summary', 'priority', 'description'],
  };

  const [rules, setRules] = useState<AutoRule[]>([defaultRule]);
  const [selected, setSelected] = useState<AutoRule | null>(null);
  const [editing, setEditing] = useState<'trigger' | 'condition' | 'create' | 'fields' | null>(null);
  const [showFlowDetails, setShowFlowDetails] = useState(true);
  const [rightTab, setRightTab] = useState<'details' | 'fields'>('details');
  const [customFields, setCustomFields] = useState<any[]>([]);

  // Load custom fields for this space
  useEffect(() => {
    api.getCustomFields().then((fields) => {
      setCustomFields(fields.filter((f: any) =>
        (f.spaceIds || []).some((sid: string) => {
          // match by id or key
          return allSpaces.some(sp => (sp.id === sid || sp.key === sid) && sp.key === spaceKey);
        }) || (f.spaceIds || []).length === 0
      ));
    }).catch(() => {});
  }, [spaceKey, allSpaces]);

  // Edit form state
  const [editTriggerStatuses, setEditTriggerStatuses] = useState<string[]>([]);
  const [editConditionStatus, setEditConditionStatus] = useState('');
  const [editCreateSpaceKey, setEditCreateSpaceKey] = useState('');
  const [editCreateWorkType, setEditCreateWorkType] = useState('Task');

  const statusOptions = currentStatuses;

  const openRule = (rule: AutoRule) => {
    setSelected({ ...rule });
    setEditing(null);
    setShowFlowDetails(true);
  };

  const saveRule = async (updated: AutoRule) => {
    setRules(rs => rs.map(r => r.id === updated.id ? updated : r));
    setSelected(updated);
    setSaveStatus('saving');
    try {
      await api.saveFlowRule(spaceKey, updated);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const startEdit = (node: 'trigger' | 'condition' | 'create' | 'fields') => {
    if (!selected) return;
    setEditing(node);
    if (node === 'trigger') setEditTriggerStatuses([...selected.trigger.statuses]);
    if (node === 'condition') setEditConditionStatus(selected.condition.status);
    if (node === 'create') { setEditCreateSpaceKey(selected.createAction.spaceKey); setEditCreateWorkType(selected.createAction.workType); }
    // 'fields' node opens inline — no extra state needed
  };

  const applyEdit = () => {
    if (!selected || !editing) return;
    let updated = { ...selected };
    if (editing === 'trigger') updated = { ...updated, trigger: { statuses: editTriggerStatuses } };
    if (editing === 'condition') updated = { ...updated, condition: { status: editConditionStatus } };
    if (editing === 'create') updated = { ...updated, createAction: { spaceKey: editCreateSpaceKey, workType: editCreateWorkType } };
    // 'fields' node: copyFields already mutated live via setSelected — just save as-is
    saveRule(updated);
    setEditing(null);
  };

  // ── List view ──
  if (!selected) {
    return (
      <Section title="Automation" description="Automate actions when work item statuses change.">
        <div className="space-y-3">
          {rules.map(rule => (
            <div key={rule.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${rule.enabled ? 'bg-green-50' : 'bg-gray-100'}`}>
                    <Zap size={16} className={rule.enabled ? 'text-green-600' : 'text-gray-400'} />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{rule.name}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      When work item transitions to <span className="font-medium text-gray-700">{rule.trigger.statuses.join(', ')}</span>
                      {' → '}create a new <span className="font-medium text-gray-700">{rule.createAction.workType}</span> in <span className="font-medium text-gray-700">{rule.createAction.spaceKey}</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${rule.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                    {rule.enabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                  <button
                    onClick={() => { setRules(rs => rs.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r)); }}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
                    title={rule.enabled ? 'Disable' : 'Enable'}
                  >
                    <Power size={14} />
                  </button>
                  <button onClick={() => openRule(rule)} className="px-3 py-1.5 text-[12px] font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
                    Edit flow
                  </button>
                </div>
              </div>
            </div>
          ))}
          <button
            onClick={() => {
              const newRule: AutoRule = {
                id: String(Date.now()),
                name: 'New Automation Rule',
                enabled: false,
                trigger: { statuses: [] },
                condition: { status: '' },
                createAction: { spaceKey: allSpaces.find(s => s.key !== spaceKey)?.key || '', workType: 'Task' },
                copyFields: ['summary', 'priority', 'description'],
              };
              setRules(rs => [...rs, newRule]);
              openRule(newRule);
            }}
            className="flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-blue-600 border border-dashed border-blue-300 rounded-xl hover:bg-blue-50 transition-colors w-full justify-center"
          >
            <Plus size={15} /> Create rule
          </button>
        </div>
      </Section>
    );
  }

  // ── Flow builder view ──
  const FlowNode = ({
    icon, color, title, subtitle, nodeKey, editLabel,
  }: {
    icon: React.ReactNode; color: string; title: string; subtitle: string;
    nodeKey: 'trigger' | 'condition' | 'create' | 'fields'; editLabel: string;
  }) => (
    <div className="relative group">
      <div className={`bg-white rounded-xl border-2 ${editing === nodeKey ? 'border-blue-400 shadow-blue-100 shadow-lg' : 'border-gray-200 hover:border-blue-300'} shadow-sm transition-all p-4 flex items-start gap-3`}>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-gray-900">{title}</p>
          <p className="text-[12px] text-gray-500 mt-0.5">{subtitle}</p>
        </div>
        <button
          onClick={() => editing === nodeKey ? setEditing(null) : startEdit(nodeKey)}
          className={`flex-shrink-0 p-1.5 rounded-lg transition-colors ${editing === nodeKey ? 'bg-blue-100 text-blue-600' : 'text-gray-300 hover:text-blue-500 hover:bg-blue-50'}`}
          title={editLabel}
        >
          <Edit2 size={14} />
        </button>
      </div>

      {/* Inline edit panel */}
      {editing === nodeKey && (
        <div className="mt-2 bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          {nodeKey === 'trigger' && (
            <>
              <p className="text-[12px] font-semibold text-blue-800">Select trigger statuses (To):</p>
              {statusOptions.length === 0
                ? <p className="text-[12px] text-gray-400 italic">No statuses found — add statuses in the Workflows section first.</p>
                : <div className="flex flex-wrap gap-2">
                    {statusOptions.map(s => (
                      <button key={s} type="button"
                        onClick={() => setEditTriggerStatuses(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}
                        className={`px-3 py-1 rounded-full text-[12px] font-medium border transition-colors ${editTriggerStatuses.includes(s) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:border-blue-400'}`}>
                        {s}
                      </button>
                    ))}
                  </div>
              }
              {statusOptions.length > 0 && editTriggerStatuses.length === 0 && <p className="text-[11px] text-amber-600">⚠ Select at least one status</p>}
            </>
          )}
          {nodeKey === 'condition' && (
            <>
              <p className="text-[12px] font-semibold text-blue-800">Status equals:</p>
              {statusOptions.length === 0
                ? <p className="text-[12px] text-gray-400 italic">No statuses found — add statuses in the Workflows section first.</p>
                : <div className="flex flex-wrap gap-2">
                    {statusOptions.map(s => (
                      <button key={s} type="button"
                        onClick={() => setEditConditionStatus(s)}
                        className={`px-3 py-1 rounded-full text-[12px] font-medium border transition-colors ${editConditionStatus === s ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:border-blue-400'}`}>
                        {s}
                      </button>
                    ))}
                  </div>
              }
            </>
          )}
          {nodeKey === 'create' && (
            <>
              <p className="text-[12px] font-semibold text-blue-800">Create a new:</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-gray-600 mb-1">Work type</label>
                  <select value={editCreateWorkType} onChange={e => setEditCreateWorkType(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-[12px] focus:outline-none focus:border-blue-400 bg-white">
                    {WORK_TYPES.map(w => <option key={w} value={w}>{w}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-gray-600 mb-1">In space / board</label>
                  <select value={editCreateSpaceKey} onChange={e => setEditCreateSpaceKey(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-[12px] focus:outline-none focus:border-blue-400 bg-white">
                    {allSpaces.map(sp => <option key={sp.key} value={sp.key}>{sp.name || sp.key} ({sp.key})</option>)}
                  </select>
                </div>
              </div>
            </>
          )}
          {nodeKey === 'fields' && (
            <>
              <p className="text-[12px] font-semibold text-blue-800">Select fields to copy to new ticket:</p>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full font-semibold">
                  {selected ? selected.copyFields.length : 0} selected
                </span>
                <button type="button" onClick={() => { if (selected) { const all = [...STANDARD_FIELDS.map(f => f.id), ...customFields.map((f:any) => `cf_${f.id}`)]; setSelected(s => s ? { ...s, copyFields: all } : s); } }} className="text-[11px] text-blue-600 hover:underline">All</button>
                <button type="button" onClick={() => { if (selected) setSelected(s => s ? { ...s, copyFields: [] } : s); }} className="text-[11px] text-gray-400 hover:underline">Clear</button>
              </div>

              {/* Group: Basic */}
              {(['Basic', 'People', 'Dates', 'Planning'] as const).map(cat => (
                <div key={cat} className="mb-2">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">{cat}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {STANDARD_FIELDS.filter(f => f.category === cat).map(field => {
                      const checked = selected?.copyFields.includes(field.id) ?? false;
                      return (
                        <button key={field.id} type="button"
                          onClick={() => {
                            if (!selected) return;
                            const next = checked
                              ? selected.copyFields.filter(id => id !== field.id)
                              : [...selected.copyFields, field.id];
                            setSelected(s => s ? { ...s, copyFields: next } : s);
                          }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-left transition-all ${checked ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-700 hover:border-blue-400 hover:bg-blue-50'}`}
                        >
                          <span className="text-sm">{field.icon}</span>
                          <span className="text-[11px] font-medium truncate">{field.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Custom fields */}
              {customFields.length > 0 && (
                <div className="mb-2">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Custom Fields</p>
                  <div className="grid grid-cols-2 gap-1">
                    {customFields.map((cf: any) => {
                      const fid = `cf_${cf.id}`;
                      const checked = selected?.copyFields.includes(fid) ?? false;
                      return (
                        <button key={fid} type="button"
                          onClick={() => {
                            if (!selected) return;
                            const next = checked
                              ? selected.copyFields.filter(id => id !== fid)
                              : [...selected.copyFields, fid];
                            setSelected(s => s ? { ...s, copyFields: next } : s);
                          }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-left transition-all ${checked ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-700 hover:border-blue-400 hover:bg-blue-50'}`}
                        >
                          <span className="text-sm">🔧</span>
                          <span className="text-[11px] font-medium truncate">{cf.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={applyEdit} className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-[12px] font-semibold hover:bg-blue-700 transition-colors">
              Apply
            </button>
            <button onClick={() => setEditing(null)} className="px-4 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-lg text-[12px] font-medium hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-0">
      {/* Top bar */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => { setSelected(null); setEditing(null); }} className="flex items-center gap-1.5 text-[12px] text-blue-600 hover:underline font-medium">
          <ArrowLeft size={13} /> Automation
        </button>
        <ChevronRight size={14} className="text-gray-400" />
        <span className="text-[12px] text-gray-600 font-medium">{selected.name}</span>
      </div>

      <div className="flex gap-6 items-start">
        {/* Flow canvas */}
        <div className="flex-1 min-w-0">
          {/* Rule header */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-base font-bold text-gray-900">{selected.name}</span>
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${selected.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                {selected.enabled ? 'ENABLED' : 'DISABLED'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {saveStatus === 'saved' && <span className="text-[11px] text-emerald-600 font-semibold">✓ Saved</span>}
              {saveStatus === 'error' && <span className="text-[11px] text-red-500 font-semibold">✗ Failed</span>}
              <button
                onClick={() => { const upd = { ...selected, enabled: !selected.enabled }; saveRule(upd); }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${selected.enabled ? 'bg-blue-600' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform ${selected.enabled ? 'translate-x-4' : 'translate-x-1'}`} />
              </button>
              <button
                onClick={() => saveRule(selected)}
                disabled={saveStatus === 'saving'}
                className="px-4 py-1.5 bg-blue-600 text-white text-[12px] font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60"
              >
                {saveStatus === 'saving' ? 'Saving…' : 'Update'}
              </button>
            </div>
          </div>

          {/* Flow */}
          <div className="flex flex-col items-center gap-0">
            {/* Trigger */}
            <div className="w-full max-w-lg">
              <FlowNode
                nodeKey="trigger"
                icon={<GitBranch size={16} className="text-green-600" />}
                color="bg-green-50"
                title="Work item transitioned"
                subtitle={selected.trigger.statuses.length > 0 ? `To: ${selected.trigger.statuses.join(', ')}` : 'Click ✏ to select transition statuses'}
                editLabel="Edit trigger statuses"
              />
            </div>

            {/* Arrow + IF badge */}
            <div className="flex flex-col items-center">
              <div className="w-0.5 h-6 bg-gray-200" />
              <div className="bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-bold px-3 py-1 rounded-full">
                IF
              </div>
              <div className="w-0.5 h-6 bg-gray-200" />
            </div>

            {/* Condition */}
            <div className="w-full max-w-lg">
              <FlowNode
                nodeKey="condition"
                icon={<Filter size={16} className="text-orange-500" />}
                color="bg-orange-50"
                title="If matches"
                subtitle={selected.condition.status ? `Status equals: ${selected.condition.status}` : 'Click ✏ to select condition status'}
                editLabel="Edit condition"
              />
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center">
              <div className="w-0.5 h-8 bg-gray-200" />
              <div className="w-2 h-2 rounded-full bg-gray-300" />
              <div className="w-0.5 h-2 bg-gray-200" />
            </div>

            {/* Create action */}
            <div className="w-full max-w-lg">
              <FlowNode
                nodeKey="create"
                icon={<Plus size={16} className="text-blue-600" />}
                color="bg-blue-50"
                title="Create a new"
                subtitle={selected.createAction.spaceKey ? `${selected.createAction.workType} in ${selected.createAction.spaceKey} – BOARD` : 'Click ✏ to select work type and target board'}
                editLabel="Edit create action"
              />
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center">
              <div className="w-0.5 h-8 bg-gray-200" />
              <div className="w-2 h-2 rounded-full bg-gray-300" />
              <div className="w-0.5 h-2 bg-gray-200" />
            </div>

            {/* Copy Fields step */}
            <div className="w-full max-w-lg">
              <FlowNode
                nodeKey="fields"
                icon={<span className="text-sm">📋</span>}
                color="bg-teal-50"
                title="Copy fields to new ticket"
                subtitle={
                  selected.copyFields.length === 0
                    ? 'Click ✏ to select fields to copy'
                    : `${selected.copyFields.length} field${selected.copyFields.length !== 1 ? 's' : ''}: ${selected.copyFields.slice(0, 3).map(id => {
                        const sf = STANDARD_FIELDS.find(f => f.id === id);
                        if (sf) return sf.label;
                        const cf = customFields.find((f: any) => `cf_${f.id}` === id);
                        return cf ? cf.name : id;
                      }).join(', ')}${selected.copyFields.length > 3 ? ` +${selected.copyFields.length - 3} more` : ''}`
                }
                editLabel="Select fields to copy"
              />
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center">
              <div className="w-0.5 h-8 bg-gray-200" />
              <div className="w-2 h-2 rounded-full bg-gray-300" />
              <div className="w-0.5 h-2 bg-gray-200" />
            </div>

            {/* Link action (fixed) */}
            <div className="w-full max-w-lg">
              <div className="bg-white rounded-xl border-2 border-gray-200 shadow-sm p-4 flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                  <ExternalLink size={16} className="text-purple-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-gray-900">Link work item to</p>
                  <p className="text-[12px] text-gray-500 mt-0.5">Most recently created work item</p>
                </div>
                <div className="flex-shrink-0 p-1.5 text-gray-200 cursor-default" title="Fixed action">
                  <Edit2 size={14} />
                </div>
              </div>
            </div>

            {/* Add step button */}
            <div className="flex flex-col items-center mt-2">
              <div className="w-0.5 h-6 bg-gray-200" />
              <button className="flex items-center gap-1.5 px-4 py-2 border border-dashed border-gray-300 rounded-xl text-[12px] text-gray-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-colors">
                <Plus size={13} /> Add step
              </button>
            </div>
          </div>
        </div>

        {/* Right panel — tabbed: Flow details | Fields */}
        <div className="w-80 flex-shrink-0">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">

            {/* Tab bar */}
            <div className="flex border-b border-gray-200">
              {(['details', 'fields'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setRightTab(tab)}
                  className={`flex-1 py-2.5 text-[12px] font-semibold transition-colors ${rightTab === tab ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50/40' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'}`}
                >
                  {tab === 'details' ? 'Flow details' : '📋 Fields'}
                </button>
              ))}
            </div>

            {/* Flow details tab */}
            {rightTab === 'details' && (
              <div className="p-4 space-y-4">
                <p className="text-[11px] text-gray-500">Required fields are marked with an asterisk *</p>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-700 mb-1">
                    Name <span className="text-red-500">*</span> <span className="text-gray-400 font-normal">(required)</span>
                  </label>
                  <input
                    type="text"
                    value={selected.name}
                    onChange={e => setSelected(s => s ? { ...s, name: e.target.value } : s)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-700 mb-1">Description</label>
                  <textarea
                    rows={3}
                    placeholder="Add a description to your flow"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-700 mb-1">Scope</label>
                  <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="w-5 h-5 rounded bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[9px] font-bold">{spaceKey.slice(0,1)}</div>
                    <span className="text-[12px] font-medium text-gray-700">{spaceKey}</span>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1">Scope can only be modified in global administration.</p>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-700 mb-1">
                    Owner <span className="text-red-500">*</span> <span className="text-gray-400 font-normal">(required)</span>
                  </label>
                  <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="w-5 h-5 rounded-full bg-teal-500 flex items-center justify-center text-white text-[9px] font-bold">SM</div>
                    <span className="text-[12px] text-gray-700">Space Admin</span>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1">The owner will receive emails when the flow fails.</p>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-700 mb-1">
                    Actor <span className="text-red-500">*</span> <span className="text-gray-400 font-normal">(required)</span>
                  </label>
                  <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-white text-[9px] font-bold">A</div>
                    <span className="text-[12px] text-gray-700">Automation for Jira</span>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1">Actions defined in this flow will be performed by the user selected as the actor.</p>
                </div>
              </div>
            )}

            {/* Fields tab */}
            {rightTab === 'fields' && (
              <div className="p-4 space-y-4">
                <div>
                  <p className="text-[12px] font-semibold text-gray-800">Fields to copy to new ticket</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">Selected fields will be carried over when automation creates a ticket in the target board.</p>
                </div>

                {/* Count badge */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full font-semibold">
                    {selected.copyFields.length} field{selected.copyFields.length !== 1 ? 's' : ''} selected
                  </span>
                  <button
                    onClick={() => {
                      const allIds = [
                        ...STANDARD_FIELDS.map(f => f.id),
                        ...customFields.map((f: any) => `cf_${f.id}`),
                      ];
                      const updated = { ...selected, copyFields: allIds };
                      setSelected(updated);
                    }}
                    className="text-[11px] text-blue-600 hover:underline"
                  >Select all</button>
                  <button
                    onClick={() => { const updated = { ...selected, copyFields: [] }; setSelected(updated); }}
                    className="text-[11px] text-gray-400 hover:underline"
                  >Clear</button>
                </div>

                {/* Standard fields grouped by category */}
                {(['Basic', 'People', 'Dates', 'Planning'] as const).map(cat => {
                  const catFields = STANDARD_FIELDS.filter(f => f.category === cat);
                  return (
                    <div key={cat}>
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">{cat}</p>
                      <div className="space-y-1">
                        {catFields.map(field => {
                          const checked = selected.copyFields.includes(field.id);
                          return (
                            <label key={field.id} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-all ${checked ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-100 hover:border-gray-300 hover:bg-gray-50'}`}>
                              <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'border-gray-300'}`}>
                                {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                              </div>
                              <span className="text-base">{field.icon}</span>
                              <span className={`text-[12px] font-medium flex-1 ${checked ? 'text-blue-800' : 'text-gray-700'}`}>{field.label}</span>
                              <input
                                type="checkbox"
                                className="hidden"
                                checked={checked}
                                onChange={() => {
                                  const next = checked
                                    ? selected.copyFields.filter(id => id !== field.id)
                                    : [...selected.copyFields, field.id];
                                  setSelected(s => s ? { ...s, copyFields: next } : s);
                                }}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Custom fields */}
                {customFields.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Custom Fields</p>
                    <div className="space-y-1">
                      {customFields.map((cf: any) => {
                        const fid = `cf_${cf.id}`;
                        const checked = selected.copyFields.includes(fid);
                        return (
                          <label key={fid} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-all ${checked ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-100 hover:border-gray-300 hover:bg-gray-50'}`}>
                            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'border-gray-300'}`}>
                              {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                            </div>
                            <span className="text-base">🔧</span>
                            <div className="flex-1 min-w-0">
                              <span className={`text-[12px] font-medium ${checked ? 'text-blue-800' : 'text-gray-700'}`}>{cf.name}</span>
                              <span className="ml-1.5 text-[10px] text-gray-400 capitalize">{cf.type}</span>
                            </div>
                            <input
                              type="checkbox"
                              className="hidden"
                              checked={checked}
                              onChange={() => {
                                const next = checked
                                  ? selected.copyFields.filter(id => id !== fid)
                                  : [...selected.copyFields, fid];
                                setSelected(s => s ? { ...s, copyFields: next } : s);
                              }}
                            />
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Save reminder */}
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-[11px] text-gray-400">Click <span className="font-semibold text-gray-600">Update</span> to save field selections.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Round Robin Tab ───────────────────────────────────────────────────────────
function RoundRobinTab({ spaceKey, spaceMembers }: { spaceKey: string; spaceMembers: any[] }) {
  const [departments, setDepartments] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [newDeptName, setNewDeptName] = React.useState('');
  // Sub-boards
  const [subBoards, setSubBoards] = React.useState<string[]>([]);
  const [allSpaces, setAllSpaces] = React.useState<{key: string; name: string}[]>([]);
  const [subBoardSaved, setSubBoardSaved] = React.useState(false);
  // Department options from "Department Routing" custom fields
  const [deptFieldOptions, setDeptFieldOptions] = React.useState<string[]>([]);
  // Agent search per department index
  const [agentSearch, setAgentSearch] = React.useState<Record<number, string>>({});
  const [agentDropOpen, setAgentDropOpen] = React.useState<number | null>(null);
  const [agentDropRect, setAgentDropRect] = React.useState<DOMRect | null>(null);
  const agentDropRef = React.useRef<HTMLDivElement | null>(null);
  const agentBtnRefs = React.useRef<Record<number, HTMLButtonElement | null>>({});

  // Close dropdown when clicking outside — no backdrop overlay needed
  React.useEffect(() => {
    if (agentDropOpen === null) return;
    const handler = (e: MouseEvent) => {
      const btn = agentBtnRefs.current[agentDropOpen];
      const panel = agentDropRef.current;
      if (btn && btn.contains(e.target as Node)) return;
      if (panel && panel.contains(e.target as Node)) return;
      setAgentDropOpen(null);
      setAgentDropRect(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [agentDropOpen]);

  const getToken = () => typeof window !== 'undefined' ? localStorage.getItem('jira_token') || '' : '';

  React.useEffect(() => {
    setLoading(true);
    const headers = { Authorization: `Bearer ${getToken()}` };

    Promise.allSettled([
      fetch(`/api/spaces/${spaceKey}/rr-config`, { headers }).then(r => r.json()),
      fetch(`/api/custom-fields`, { headers }).then(r => r.ok ? r.json() : null),
      fetch(`/api/spaces`, { headers }).then(r => r.ok ? r.json() : null),
    ]).then(([rrRes, cfRes, spacesRes]) => {
      if (rrRes.status === 'fulfilled') {
        setDepartments(rrRes.value?.config?.departments || []);
        setSubBoards(rrRes.value?.config?.subBoardKeys || rrRes.value?.subBoardKeys || []);
      }
      if (cfRes.status === 'fulfilled' && cfRes.value) {
        const fields: any[] = cfRes.value?.fields || cfRes.value || [];
        const opts: string[] = [];
        for (const f of fields) {
          if (f.fieldType === 'department-routing' || f.type === 'Department Routing') {
            for (const opt of (f.options || [])) {
              const name = String(opt).split('|')[0].trim();
              if (name && !opts.includes(name)) opts.push(name);
            }
          }
        }
        setDeptFieldOptions(opts);
      }
      if (spacesRes.status === 'fulfilled' && spacesRes.value) {
        const list: any[] = spacesRes.value?.spaces || spacesRes.value || [];
        setAllSpaces(list.filter((s: any) => s.key !== spaceKey).map((s: any) => ({ key: s.key, name: s.name })));
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [spaceKey]);

  const saveSubBoards = async (keys: string[]) => {
    try {
      await fetch(`/api/spaces/${spaceKey}/sub-boards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ subBoardKeys: keys }),
      });
      setSubBoardSaved(true);
      setTimeout(() => setSubBoardSaved(false), 2500);
    } catch { /* ignore */ }
  };

  const toggleSubBoard = (key: string) => {
    const updated = subBoards.includes(key) ? subBoards.filter(k => k !== key) : [...subBoards, key];
    setSubBoards(updated);
    saveSubBoards(updated);
  };

  const saveDepts = async (depts: any[]) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/spaces/${spaceKey}/rr-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ departments: depts }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } catch {}
    setSaving(false);
  };

  const addDept = () => {
    if (!newDeptName.trim()) return;
    const newDept = {
      name: newDeptName.trim(),
      order: departments.length,
      isDefault: departments.length === 0,
      agents: [],
      currentIndex: 0,
    };
    const updated = [...departments, newDept];
    setDepartments(updated);
    setNewDeptName('');
    saveDepts(updated);
  };

  const removeDept = (idx: number) => {
    const updated = departments.filter((_: any, i: number) => i !== idx);
    setDepartments(updated);
    saveDepts(updated);
  };

  const toggleDefault = (idx: number) => {
    const updated = departments.map((d: any, i: number) => ({ ...d, isDefault: i === idx }));
    setDepartments(updated);
    saveDepts(updated);
  };

  const addAgent = (deptIdx: number, userId: string) => {
    const member = spaceMembers.find((m: any) => (m.userId || m.id) === userId);
    if (!member) return;
    const user = member.user || member;
    const agent = {
      userId: user.id || userId,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || userId,
      isActive: true,
      maxTickets: 10,
    };
    const updated = departments.map((d: any, i: number) =>
      i === deptIdx
        ? { ...d, agents: d.agents.find((a: any) => a.userId === agent.userId) ? d.agents : [...d.agents, agent] }
        : d
    );
    setDepartments(updated);
    saveDepts(updated);
  };

  const removeAgent = (deptIdx: number, agentUserId: string) => {
    const updated = departments.map((d: any, i: number) =>
      i === deptIdx ? { ...d, agents: d.agents.filter((a: any) => a.userId !== agentUserId) } : d
    );
    setDepartments(updated);
    saveDepts(updated);
  };

  const toggleAgent = (deptIdx: number, agentUserId: string) => {
    const updated = departments.map((d: any, i: number) =>
      i === deptIdx
        ? { ...d, agents: d.agents.map((a: any) => a.userId === agentUserId ? { ...a, isActive: !a.isActive } : a) }
        : d
    );
    setDepartments(updated);
    saveDepts(updated);
  };

  const updateAgentShift = (deptIdx: number, agentUserId: string, field: 'shiftStart' | 'shiftEnd', value: string) => {
    const updated = departments.map((d: any, i: number) =>
      i === deptIdx
        ? { ...d, agents: d.agents.map((a: any) => a.userId === agentUserId ? { ...a, [field]: value || undefined } : a) }
        : d
    );
    setDepartments(updated);
    saveDepts(updated);
  };

  if (loading) return <div className="flex items-center justify-center py-20"><div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;

  return (
    <Section title="Round Robin Assignment" description="Configure departments and agent pools for automatic round-robin ticket assignment.">
      <div className="space-y-4">
        {/* Add department — dropdown from Department Routing field options */}
        <div className="flex items-center gap-2">
          {deptFieldOptions.length > 0 ? (
            <select
              value={newDeptName}
              onChange={e => setNewDeptName(e.target.value)}
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-100"
            >
              <option value="">Select a department to add</option>
              {deptFieldOptions
                .filter(opt => !departments.find((d: any) => d.name.toUpperCase() === opt.toUpperCase()))
                .map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
            </select>
          ) : (
            <div className="flex-1 border border-dashed border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-400 bg-gray-50">
              No departments found — create a <strong>Department Routing</strong> field in <a href="/settings?section=work-items" className="text-blue-500 underline">Settings → Fields</a> first
            </div>
          )}
          <button
            onClick={addDept}
            disabled={!newDeptName}
            className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
            <Plus size={14} /> Add Department
          </button>
          {saved && <span className="text-xs text-green-600 font-medium flex items-center gap-1"><Check size={12} /> Saved</span>}
        </div>

        {departments.length === 0 && (
          <div className="text-center py-14 bg-white rounded-xl border border-gray-200">
            <RefreshCw size={32} className="text-gray-200 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-400">No departments configured</p>
            <p className="text-xs text-gray-400 mt-1">Add a department to start round-robin assignment.</p>
          </div>
        )}

        {departments.map((dept: any, deptIdx: number) => (
          <div key={dept.name + deptIdx} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-gray-50">
              <div className="flex items-center gap-3">
                <span className="font-bold text-gray-800 text-sm">{dept.name}</span>
                <span className="text-xs text-gray-500">Order: {dept.order}</span>
                <button
                  onClick={() => toggleDefault(deptIdx)}
                  title={dept.isDefault ? 'Default (email tickets)' : 'Set as default for email tickets'}
                  className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors ${dept.isDefault ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-100 border-gray-200 text-gray-500 hover:border-blue-300'}`}
                >
                  {dept.isDefault ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
                  {dept.isDefault ? 'Default' : 'Set default'}
                </button>
              </div>
              <button onClick={() => removeDept(deptIdx)} className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                <Trash2 size={13} />
              </button>
            </div>

            <div className="px-5 py-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Agents ({dept.agents.length})</p>
              <div className="space-y-2 mb-3">
                {dept.agents.map((agent: any) => (
                  <div key={agent.userId} className="rounded-lg bg-gray-50 border border-gray-100 overflow-hidden">
                    {/* Agent header row */}
                    <div className="flex items-center justify-between py-1.5 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                          {getInitials(agent.name)}
                        </div>
                        <span className="text-xs font-medium text-gray-700">{agent.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleAgent(deptIdx, agent.userId)}
                          className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${agent.isActive !== false ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`}
                        >
                          {agent.isActive !== false ? 'Active' : 'Inactive'}
                        </button>
                        <button onClick={() => removeAgent(deptIdx, agent.userId)} className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500">
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                    {/* Shift timing row */}
                    <div className="flex items-center gap-2 px-3 py-1.5 border-t border-gray-100 bg-white">
                      <span className="text-[10px] text-gray-400 font-medium w-16 flex-shrink-0">Shift hours</span>
                      <div className="flex items-center gap-1.5 flex-1">
                        <input
                          type="time"
                          value={agent.shiftStart || ''}
                          onChange={e => updateAgentShift(deptIdx, agent.userId, 'shiftStart', e.target.value)}
                          className="border border-gray-200 rounded px-2 py-0.5 text-[11px] text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-blue-300 w-24"
                          title="Shift start time"
                        />
                        <span className="text-[10px] text-gray-400">to</span>
                        <input
                          type="time"
                          value={agent.shiftEnd || ''}
                          onChange={e => updateAgentShift(deptIdx, agent.userId, 'shiftEnd', e.target.value)}
                          className="border border-gray-200 rounded px-2 py-0.5 text-[11px] text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-blue-300 w-24"
                          title="Shift end time"
                        />
                        {agent.shiftStart && agent.shiftEnd ? (
                          <span className="text-[10px] text-emerald-600 font-medium ml-1">{agent.shiftStart} – {agent.shiftEnd}</span>
                        ) : (
                          <span className="text-[10px] text-gray-400 italic ml-1">No shift set — always available</span>
                        )}
                        {(agent.shiftStart || agent.shiftEnd) && (
                          <button
                            onClick={() => {
                              updateAgentShift(deptIdx, agent.userId, 'shiftStart', '');
                              updateAgentShift(deptIdx, agent.userId, 'shiftEnd', '');
                            }}
                            className="ml-auto text-[10px] text-gray-400 hover:text-red-400 underline"
                            title="Clear shift"
                          >clear</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {dept.agents.length === 0 && <p className="text-xs text-gray-400 italic">No agents added yet.</p>}
              </div>

              {/* Add agent — searchable dropdown */}
              <div className="relative">
                {/* Trigger button */}
                <button
                  ref={el => { agentBtnRefs.current[deptIdx] = el; }}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    if (agentDropOpen === deptIdx) {
                      setAgentDropOpen(null);
                      setAgentDropRect(null);
                    } else {
                      setAgentDropOpen(deptIdx);
                      setAgentDropRect(rect);
                    }
                  }}
                  className={`w-full flex items-center justify-between border rounded-lg px-3 py-2 text-xs bg-white transition-colors text-gray-500 ${agentDropOpen === deptIdx ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200 hover:bg-gray-50'}`}
                >
                  <span className="flex items-center gap-1.5"><Plus size={12} className="text-blue-500" /> Add agent from space members</span>
                  <ChevronDown size={12} className={`text-gray-400 transition-transform ${agentDropOpen === deptIdx ? 'rotate-180' : ''}`} />
                </button>

                {/* Dropdown panel — fixed positioning escapes overflow-hidden, no backdrop so sidebar stays untouched */}
                {agentDropOpen === deptIdx && agentDropRect && (() => {
                  const dropH = 280; // approx max height of dropdown
                  const spaceBelow = window.innerHeight - agentDropRect.bottom;
                  const openUpward = spaceBelow < dropH + 8;
                  const style: React.CSSProperties = {
                    position: 'fixed',
                    left: agentDropRect.left,
                    width: agentDropRect.width,
                    zIndex: 9999,
                    ...(openUpward
                      ? { bottom: window.innerHeight - agentDropRect.top + 4 }
                      : { top: agentDropRect.bottom + 4 }),
                  };
                  return (
                  <div
                    ref={agentDropRef}
                    style={style}
                    className="bg-white rounded-xl border border-gray-200 shadow-2xl overflow-hidden">
                    {/* Search bar */}
                    <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-100 bg-gray-50">
                      <Search size={13} className="text-gray-400 flex-shrink-0" />
                      <input
                        autoFocus
                        type="text"
                        value={agentSearch[deptIdx] || ''}
                        onChange={e => setAgentSearch(prev => ({ ...prev, [deptIdx]: e.target.value }))}
                        placeholder="Search by name or email..."
                        className="flex-1 bg-transparent text-xs outline-none text-gray-700 placeholder-gray-400"
                      />
                      {agentSearch[deptIdx] && (
                        <button type="button" onClick={() => setAgentSearch(prev => ({ ...prev, [deptIdx]: '' }))}>
                          <X size={12} className="text-gray-400 hover:text-gray-600" />
                        </button>
                      )}
                    </div>
                    {/* Member list */}
                    <div className="overflow-y-auto" style={{maxHeight: '220px'}}>
                      {(() => {
                        const search = (agentSearch[deptIdx] || '').toLowerCase();
                        const filtered = spaceMembers.filter((m: any) => {
                          const u = m.user || m;
                          const uid = u.id || m.userId;
                          if (dept.agents.find((a: any) => a.userId === uid)) return false;
                          if (!search) return true;
                          return `${u.firstName} ${u.lastName}`.toLowerCase().includes(search) || (u.email || '').toLowerCase().includes(search);
                        });
                        if (filtered.length === 0) return (
                          <div className="px-3 py-4 text-xs text-gray-400 text-center">No members found</div>
                        );
                        return filtered.map((m: any) => {
                          const u = m.user || m;
                          const uid = u.id || m.userId;
                          const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
                          const initials = name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
                          return (
                            <button key={uid} type="button"
                              onClick={() => { addAgent(deptIdx, uid); setAgentDropOpen(null); setAgentDropRect(null); setAgentSearch(prev => ({ ...prev, [deptIdx]: '' })); }}
                              className="w-full flex items-center gap-3 px-3 py-2.5 text-xs hover:bg-blue-50 text-left transition-colors border-b border-gray-50 last:border-0"
                            >
                              <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0">
                                {initials || '?'}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-semibold text-gray-800 truncate">{name}</div>
                                <div className="text-gray-400 truncate">{u.email}</div>
                              </div>
                            </button>
                          );
                        });
                      })()}
                    </div>
                  </div>
                  );
                })()}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Sub-boards: aggregate tickets from linked boards into this space's queues */}
      <div className="mt-6 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-gray-50">
          <div>
            <span className="font-bold text-gray-800 text-sm">Sub-boards</span>
            <p className="text-xs text-gray-500 mt-0.5">Tickets from these boards will appear in this space&apos;s department queues (e.g. Dev queue shows L2 + L3 tickets)</p>
          </div>
          {subBoardSaved && <span className="text-xs text-green-600 font-medium flex items-center gap-1"><Check size={12} /> Saved</span>}
        </div>
        <div className="px-5 py-3 space-y-1">
          {allSpaces.length === 0 && <p className="text-xs text-gray-400 italic">No other spaces found.</p>}
          {allSpaces.map(sp => (
            <label key={sp.key} className="flex items-center gap-3 py-1.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={subBoards.includes(sp.key)}
                onChange={() => toggleSubBoard(sp.key)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-200"
              />
              <span className="text-xs font-semibold text-gray-700 group-hover:text-blue-600 transition-colors">{sp.key}</span>
              <span className="text-xs text-gray-400">{sp.name}</span>
            </label>
          ))}
        </div>
      </div>
    </Section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
function SpaceSettingsContent() {
  const params      = useParams();
  const searchParams = useSearchParams();
  const spaceKey    = (params.spaceKey as string).toUpperCase();
  const initialTab  = searchParams.get('tab') || 'general';

  // ── Auto-collapse sidebar when settings opens, restore on leave ───────────
  const { sidebarOpen, toggleSidebar } = useStore(s => ({ sidebarOpen: s.sidebarOpen, toggleSidebar: s.toggleSidebar }));
  useEffect(() => {
    const wasOpen = sidebarOpen;
    if (wasOpen) toggleSidebar(); // collapse on mount
    return () => {
      // restore on unmount only if it was open before
      if (wasOpen) toggleSidebar();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handle OAuth callback (Microsoft / Google redirect back) ──────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const oauthSuccess = sp.get('oauth_success');
    const oauthEmail   = sp.get('oauth_email');
    const oauthError   = sp.get('oauth_error');

    if (oauthError) {
      alert(`OAuth connection failed: ${decodeURIComponent(oauthError)}`);
      // Clean URL
      const clean = window.location.pathname + '?tab=email';
      window.history.replaceState({}, '', clean);
    }

    if (oauthSuccess && oauthEmail) {
      const email = decodeURIComponent(oauthEmail);
      setTab('email');

      // Add to UI immediately (duplicate-safe)
      setConnectedEmails((prev: any[]) => {
        if (prev.find((e: any) => e.address === email)) return prev;
        const next = [...prev, {
          id: `oauth_${Date.now()}`,
          address: email,
          requestType: 'Emailed request',
          isReplyTo: false,
          lastReceivedIso: undefined,
          logs: [],
          pollerActive: true,
        }];
        // Persist to localStorage so it survives page refreshes
        try { localStorage.setItem(`connectedEmails_${spaceKey}`, JSON.stringify(next)); } catch {}
        return next;
      });

      // Clean URL
      const clean = window.location.pathname + '?tab=email';
      window.history.replaceState({}, '', clean);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { currentSpace, loadSpace, loadSpaces } = useStore(
    useShallow((s) => ({
      currentSpace: s.currentSpace,
      loadSpace: s.loadSpace,
      loadSpaces: s.loadSpaces,
    })),
  );
  const [tab,       setTab]      = useState(initialTab);
  const [users,     setUsers]    = useState<any[]>([]);
  const [labels,    setLabels]   = useState<any[]>([]);
  const [workflows, setWorkflows]= useState<any[]>([]);
  const [newLabel,  setNewLabel] = useState({ name: '', color: '#3B82F6' });
  const [saving,    setSaving]   = useState(false);
  const [saved,     setSaved]    = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [emailAddress] = useState(`${spaceKey.toLowerCase()}@cloudfuze.com`);
  const [emailCopied, setEmailCopied] = useState(false);
  const [emailSubjectFilter, setEmailSubjectFilter] = useState('');
  const [emailDefaultType, setEmailDefaultType] = useState('task');
  const [emailDefaultPriority, setEmailDefaultPriority] = useState('medium');
  const [emailStripSignature, setEmailStripSignature] = useState(true);
  const [emailAutoReply, setEmailAutoReply] = useState(true);
  const [emailAutoReplyText, setEmailAutoReplyText] = useState('Thank you for contacting us. We have received your request and will get back to you shortly.');
  const [spaceName, setSpaceName]= useState('');
  const [spaceDesc, setSpaceDesc]= useState('');
  const [spaceIcon, setSpaceIcon]= useState('');
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [connectedEmails, setConnectedEmails] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem(`connectedEmails_${spaceKey}`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [showAddEmail, setShowAddEmail] = useState(false);
  const [newExternalEmail, setNewExternalEmail] = useState('');
  const [viewingLogs, setViewingLogs] = useState<string | null>(null);
  const [emailLogs, setEmailLogs] = useState<any[]>([]);
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [testEmailFrom, setTestEmailFrom] = useState('customer@example.com');
  const [testEmailSubject, setTestEmailSubject] = useState('Need help with my account');
  const [showTestEmailForm, setShowTestEmailForm] = useState(false);
  const [emailActionsMenuId, setEmailActionsMenuId] = useState<string | null>(null);
  const emailPollErrorsRef = React.useRef(0);

  // SLA state
  const [slas,          setSlas]         = useState<SLAItem[]>([]);
  const [slaLoading,    setSlaLoading]   = useState(false);
  const [selectedSLA,   setSelectedSLA]  = useState<SLAItem | null>(null);
  const [showCreateSLA, setShowCreateSLA]= useState(false);
  const [spaceStatuses, setSpaceStatuses]= useState<string[]>([]);

  // Queue mock
  const [queues, setQueues] = useState([
    { id: '1', name: 'All open issues', count: 4, filter: 'status = Open',        order: 'Priority' },
    { id: '2', name: 'In Progress',     count: 2, filter: 'status = In Progress', order: 'Created' },
    { id: '3', name: 'Unassigned',      count: 1, filter: 'assignee is EMPTY',    order: 'Priority' },
  ]);

  const [screens] = useState([
    { id: '1', name: 'Default Screen',    fields: ['Summary', 'Description', 'Priority', 'Assignee', 'Labels'] },
    { id: '2', name: 'Transition Screen', fields: ['Resolution', 'Comment'] },
  ]);

  const [fields, setFields] = useState([
    { id: '1', name: 'Organization',  type: 'Text',   required: true  },
    { id: '2', name: 'Phone number',  type: 'Text',   required: false },
    { id: '3', name: 'Account tier',  type: 'Select', required: false },
  ]);

  const loadSLAs = async () => {
    setSlaLoading(true);
    try {
      const data = await api.getSLAs(spaceKey);
      setSlas(data.map((s: any) => ({
        id:             s.id,
        name:           s.name,
        status:         s.status,
        goals:          s.goals || [],
        startCondition: s.startCondition,
        pauseCondition: s.pauseCondition,
        pauseStatuses:  s.pauseStatuses || [],
        stopCondition:  s.stopCondition,
      })));
    } catch {} finally { setSlaLoading(false); }
  };

  useEffect(() => {
    loadSpace(spaceKey);
    api.getUsers().then(setUsers).catch(() => {});
    api.getLabels(spaceKey).then(setLabels).catch(() => {});
    api.getWorkflows(spaceKey).then(setWorkflows).catch(() => {});
    api.getSpace(spaceKey).then((space: any) => {
      if (space?.statuses) setSpaceStatuses(space.statuses.map((s: any) => s.name));
    }).catch(() => {});
    loadSLAs();
    // Load registered email addresses from backend
    api.getEmailAddresses(spaceKey).then((addrs) => {
      if (addrs && addrs.length > 0) {
        const mapped = addrs.map((a: any) => ({
          id: a.id, address: a.address, requestType: a.requestType,
          isReplyTo: a.isReplyTo, lastReceivedIso: undefined, logs: [],
          autoReply: a.autoReply, autoReplyText: a.autoReplyText, enabled: a.enabled,
        }));
        setConnectedEmails(mapped);
        try { localStorage.setItem(`connectedEmails_${spaceKey}`, JSON.stringify(mapped)); } catch {}
      }
    }).catch(() => {});
  }, [spaceKey, loadSpace]);

  // Poll email logs every 10 seconds — stops after 3 consecutive failures
  const loadEmailLogs = React.useCallback(() => {
    if (emailPollErrorsRef.current >= 3) return;
    api.getEmailLogs(spaceKey).then((logs) => {
      emailPollErrorsRef.current = 0;
      setEmailLogs(logs);
      if (logs.length > 0) {
        const latest = logs[0];
        setConnectedEmails((prev) => prev.map((e) =>
          e.isReplyTo ? { ...e, lastReceivedIso: latest.time } : e
        ));
      }
    }).catch(() => {
      emailPollErrorsRef.current += 1;
    });
  }, [spaceKey]);

  useEffect(() => {
    emailPollErrorsRef.current = 0; // reset counter on spaceKey change
    loadEmailLogs();
    const interval = setInterval(loadEmailLogs, 10000);
    return () => clearInterval(interval);
  }, [spaceKey, loadEmailLogs]);

  useEffect(() => {
    if (currentSpace) {
      setSpaceName(currentSpace.name || '');
      setSpaceDesc(currentSpace.description || '');
      setSpaceIcon(currentSpace.icon || '');
    }
  }, [currentSpace]);

  const handleAddMember  = async (userId: string, role = 'developer', department = '') => { await api.addSpaceMember(spaceKey, { userId, role, department: department || null }); loadSpace(spaceKey); };
  const handleAddLabel   = async (e: React.FormEvent) => { e.preventDefault(); await api.createLabel({ spaceKey, ...newLabel }); setNewLabel({ name: '', color: '#3B82F6' }); api.getLabels(spaceKey).then(setLabels); };
  const handleSaveGeneral = async () => {
    setSaving(true);
    try {
      await api.updateSpace(spaceKey, { name: spaceName, description: spaceDesc, icon: spaceIcon });
      // Directly update the store so the sidebar + header reflect the new name immediately
      // without doing a round-trip GET that could return stale cached data
      useStore.setState((s) => ({
        currentSpace: s.currentSpace ? { ...s.currentSpace, name: spaceName, description: spaceDesc, icon: spaceIcon } : s.currentSpace,
        spaces: s.spaces.map((sp) => sp.key === spaceKey.toUpperCase() ? { ...sp, name: spaceName, description: spaceDesc, icon: spaceIcon } : sp),
      }));
      // Also refresh the full spaces list for sidebar
      loadSpaces();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    catch {} finally { setSaving(false); }
  };

  if (!currentSpace) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3">
      <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      <p className="text-[13px] text-gray-400">Loading space settings…</p>
    </div>
  );

  return (
    <div className="flex gap-0 h-screen overflow-hidden">
      {showCreateSLA && <CreateSLAModal onClose={() => setShowCreateSLA(false)} onCreate={async sla => {
        try {
          const created = await api.createSLA(spaceKey, sla);
          setSlas(prev => [...prev, { ...sla, id: created.id }]);
          setShowCreateSLA(false);
        } catch (err) {
          console.error('[SLA] Failed to save:', err);
          alert('Failed to save SLA. Please try again.');
        }
      }} />}

      {/* ── LEFT SIDEBAR ── */}
      <div className="w-56 flex-shrink-0 border-r border-gray-200 bg-white pt-3 pb-10 h-full overflow-y-auto sticky top-0">
        {/* Back to space */}
        <div className="px-3 mb-3">
          <Link
            href={`/spaces/${spaceKey}`}
            className="flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-blue-600 transition-colors py-1.5 px-2 rounded-md hover:bg-gray-50 font-medium"
          >
            <ArrowLeft size={13} />
            Back to space
          </Link>
        </div>
        <div className="px-4 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{spaceKey.slice(0, 2)}</div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{currentSpace.name}</p>
              <p className="text-[11px] text-gray-400 capitalize">{currentSpace.type?.replace('_', ' ')}</p>
            </div>
          </div>
        </div>
        <div className="px-3 space-y-5">
          {NAV.map(group => (
            <div key={group.group}>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-2 mb-1">{group.group}</p>
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const Icon = item.icon;
                  const active = tab === item.id;
                  return (
                    <button key={item.id} onClick={() => { setTab(item.id); setSelectedSLA(null); }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-all text-left ${active ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`}>
                      <Icon size={15} className={active ? 'text-blue-600' : 'text-gray-400'} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── RIGHT CONTENT ── */}
      <div className="flex-1 px-8 pt-6 pb-10 overflow-y-auto bg-gray-50/40 h-full">

        {/* General */}
        {tab === 'general' && (
          <Section title="General" description="Manage your space name, key, and description.">
            <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5 shadow-sm">
              {/* Icon picker */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Space icon</label>
                <div className="flex items-center gap-3">
                  {/* Current icon preview */}
                  <div className="relative">
                    {(() => {
                      let parsed: { emoji: string; bg: string } | null = null;
                      try { const p = JSON.parse(spaceIcon); if (p.emoji) parsed = p; } catch {}
                      return (
                        <button type="button" onClick={() => setShowIconPicker(!showIconPicker)}
                          className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors"
                          style={parsed ? { background: parsed.bg, borderStyle: 'solid', borderColor: 'transparent' } : {}}>
                          {parsed ? parsed.emoji : <span className="text-gray-400 text-xs font-bold">{spaceKey.slice(0,2)}</span>}
                        </button>
                      );
                    })()}
                  </div>
                  <div>
                    <button type="button" onClick={() => setShowIconPicker(!showIconPicker)}
                      className="text-sm text-blue-600 hover:underline font-medium">
                      {spaceIcon ? 'Change icon' : 'Choose icon'}
                    </button>
                    {spaceIcon && (
                      <button type="button" onClick={() => setSpaceIcon('')}
                        className="block text-xs text-gray-400 hover:text-red-500 mt-0.5">Remove</button>
                    )}
                  </div>
                </div>
                {showIconPicker && (
                  <div className="mt-3 p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Choose an icon</p>

                    {/* Category: Infrastructure */}
                    <p className="text-[10px] text-gray-400 mb-1.5 font-medium">Infrastructure & Tech</p>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {[
                        '🖥️','💻','🖱️','⌨️','🖨️','🔌','💾','💿','📀','🖲️',
                        '☁️','🌐','🔧','⚙️','🔩','🔬','📡','🛰️','🗄️','🔐',
                      ].map(emoji => {
                        const val = JSON.stringify({ emoji, bg: '#6366f1' });
                        const selected = spaceIcon === val;
                        return (
                          <button key={emoji} type="button"
                            onClick={() => { setSpaceIcon(val); setShowIconPicker(false); }}
                            className={`w-9 h-9 rounded flex items-center justify-center text-lg border hover:border-blue-400 hover:bg-blue-50 transition-colors ${selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
                            {emoji}
                          </button>
                        );
                      })}
                    </div>

                    {/* Category: Business */}
                    <p className="text-[10px] text-gray-400 mb-1.5 font-medium">Business & Projects</p>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {[
                        '📊','📈','📉','📋','📁','📂','🗂️','📌','📎','✏️',
                        '🏢','🏗️','🎯','🚀','⚡','💡','🔥','🏆','💎','🎨',
                      ].map(emoji => {
                        const val = JSON.stringify({ emoji, bg: '#3b82f6' });
                        const selected = spaceIcon === val;
                        return (
                          <button key={emoji} type="button"
                            onClick={() => { setSpaceIcon(val); setShowIconPicker(false); }}
                            className={`w-9 h-9 rounded flex items-center justify-center text-lg border hover:border-blue-400 hover:bg-blue-50 transition-colors ${selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
                            {emoji}
                          </button>
                        );
                      })}
                    </div>

                    {/* Category: Support */}
                    <p className="text-[10px] text-gray-400 mb-1.5 font-medium">Support & People</p>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {[
                        '🎧','👥','🤝','💬','📞','📧','🔔','🛎️','📣','🗣️',
                        '🛡️','🔑','🌱','🌍','❤️','⭐','✅','🚦','📝','🤖',
                      ].map(emoji => {
                        const val = JSON.stringify({ emoji, bg: '#10b981' });
                        const selected = spaceIcon === val;
                        return (
                          <button key={emoji} type="button"
                            onClick={() => { setSpaceIcon(val); setShowIconPicker(false); }}
                            className={`w-9 h-9 rounded flex items-center justify-center text-lg border hover:border-blue-400 hover:bg-blue-50 transition-colors ${selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
                            {emoji}
                          </button>
                        );
                      })}
                    </div>

                    {/* Custom emoji input */}
                    <div className="border-t border-gray-100 pt-3 mt-1">
                      <p className="text-[10px] text-gray-400 mb-1.5 font-medium">Or type any emoji</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          maxLength={4}
                          placeholder="e.g. 🔥"
                          className="w-20 border border-gray-300 rounded px-2 py-1.5 text-lg text-center focus:outline-none focus:border-blue-400"
                          onChange={e => {
                            const em = e.target.value.trim();
                            if (em) setSpaceIcon(JSON.stringify({ emoji: em, bg: '#6366f1' }));
                          }}
                        />
                        <button type="button" onClick={() => setShowIconPicker(false)}
                          className="text-[12px] text-gray-500 hover:text-gray-700 px-2 py-1.5 border border-gray-200 rounded hover:bg-gray-50">
                          Done
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Space name</label>
                <input type="text" value={spaceName} onChange={e => setSpaceName(e.target.value)} className="input-field w-80" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Space key</label>
                <input type="text" value={currentSpace.key} disabled className="input-field w-40 bg-gray-50 text-gray-400 cursor-not-allowed" />
                <p className="text-xs text-gray-400 mt-1">The key prefixes issue IDs and cannot be changed.</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Type</label>
                <Badge color="blue">{currentSpace.type?.replace('_', ' ')}</Badge>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Description</label>
                <textarea value={spaceDesc} onChange={e => setSpaceDesc(e.target.value)} className="input-field w-full" rows={3} placeholder="Add a description…" />
              </div>
              <button onClick={handleSaveGeneral} disabled={saving}
                className="flex items-center gap-2 bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-all">
                {saved ? <><Check size={14} /> Saved!</> : saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </Section>
        )}

        {/* Summary */}
        {tab === 'summary' && (
          <Section title="Summary" description="Overview of this space's activity and configuration.">
            <div className="grid grid-cols-3 gap-4">
              {[{ label: 'Total issues', value: currentSpace.issueCount ?? '—', color: 'text-blue-600' },
                { label: 'Members',      value: currentSpace.members?.length ?? 0, color: 'text-indigo-600' },
                { label: 'Workflows',    value: workflows.length, color: 'text-purple-600' }].map(s => (
                <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                  <p className={`text-3xl font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-sm text-gray-500 mt-1">{s.label}</p>
                </div>
              ))}
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <h3 className="text-sm font-bold text-gray-700 mb-3">Space statuses</h3>
              <div className="flex flex-wrap gap-2">
                {currentSpace.statuses?.map(s => (
                  <span key={s.id} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-white" style={{ backgroundColor: s.color }}>{s.name}</span>
                ))}
              </div>
            </div>
          </Section>
        )}

        {/* People */}
        {tab === 'people' && (
          currentSpace
            ? <PeopleSection
                currentSpace={currentSpace}
                users={users}
                spaceKey={spaceKey}
                onAddMember={handleAddMember}
                onReload={() => loadSpace(spaceKey)}
              />
            : <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading…</div>
        )}

        {/* Permissions */}
        {tab === 'permissions' && (
          <Section title="Space permissions" description="Control what each role can do within this space.">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase">Permission</th>
                    {['Admin','Manager','Developer','Viewer'].map(r => <th key={r} className="px-5 py-3 text-center text-xs font-bold text-gray-500 uppercase">{r}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {[
                    { perm: 'View issues',        admin: true,  manager: true,  dev: true,  viewer: true  },
                    { perm: 'Create issues',       admin: true,  manager: true,  dev: true,  viewer: false },
                    { perm: 'Edit issues',         admin: true,  manager: true,  dev: true,  viewer: false },
                    { perm: 'Delete issues',       admin: true,  manager: true,  dev: false, viewer: false },
                    { perm: 'Manage members',      admin: true,  manager: true,  dev: false, viewer: false },
                    { perm: 'Manage workflows',    admin: true,  manager: false, dev: false, viewer: false },
                    { perm: 'Manage SLAs',         admin: true,  manager: false, dev: false, viewer: false },
                    { perm: 'Edit space settings', admin: true,  manager: false, dev: false, viewer: false },
                  ].map(row => (
                    <tr key={row.perm} className="hover:bg-gray-50">
                      <td className="px-5 py-3 text-sm text-gray-800 font-medium">{row.perm}</td>
                      {(['admin','manager','dev','viewer'] as const).map(role => (
                        <td key={role} className="px-5 py-3 text-center">
                          {(row as any)[role] ? <Check size={15} className="text-green-500 mx-auto" /> : <X size={15} className="text-gray-200 mx-auto" />}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Customer permissions */}
        {tab === 'customer' && (
          <Section title="Customer permissions" description="Control how customers can raise and view requests.">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-5">
              {[
                { icon: Globe,  label: 'Anyone can submit a request',         desc: 'Customers do not need an account.',                    on: false },
                { icon: Eye,    label: 'Customers can view other requests',    desc: 'Customers see all requests submitted to this service.', on: false },
                { icon: Users,  label: 'Customers can search for other users', desc: 'Allows customers to @mention others on requests.',      on: true  },
                { icon: Lock,   label: 'Require login to submit requests',     desc: 'Customers must have an account.',                       on: true  },
              ].map(item => { const Icon = item.icon; return (
                <div key={item.label} className="flex items-start justify-between gap-4 pb-5 border-b border-gray-100 last:border-0 last:pb-0">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5"><Icon size={16} className="text-blue-600" /></div>
                    <div><p className="text-sm font-semibold text-gray-800">{item.label}</p><p className="text-xs text-gray-500 mt-0.5">{item.desc}</p></div>
                  </div>
                  <ToggleSwitch defaultOn={item.on} />
                </div>
              ); })}
            </div>
          </Section>
        )}

        {/* Notifications */}
        {tab === 'notifications' && (
          <Section title="Notifications" description="Configure when and how team members are notified.">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-4">
              {[
                { label: 'Issue assigned to me',        desc: 'Notify when an issue is assigned to you.',               on: true  },
                { label: 'Issue status changes',        desc: 'Notify when status of a watched issue changes.',          on: true  },
                { label: 'Comment added',               desc: 'Notify when a comment is added to a watched issue.',      on: true  },
                { label: 'SLA breach warning',          desc: 'Notify 30 minutes before an SLA is breached.',            on: true  },
                { label: 'SLA breached',                desc: 'Notify immediately when an SLA is breached.',             on: true  },
                { label: 'Issue created in my queues',  desc: 'Notify when a new issue enters your assigned queues.',    on: false },
                { label: 'Daily digest',                desc: 'Receive a daily summary of your open issues.',            on: false },
              ].map(n => (
                <div key={n.label} className="flex items-center justify-between pb-4 border-b border-gray-100 last:border-0 last:pb-0">
                  <div><p className="text-sm font-semibold text-gray-800">{n.label}</p><p className="text-xs text-gray-500">{n.desc}</p></div>
                  <ToggleSwitch defaultOn={n.on} />
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── SLAs ── */}
        {tab === 'sla' && (
          selectedSLA ? (
            <SLADetailView
              sla={selectedSLA}
              spaceStatuses={spaceStatuses}
              onBack={() => setSelectedSLA(null)}
              onSave={async updated => {
                try {
                  await api.updateSLA(spaceKey, updated.id, updated);
                } catch {}
                setSlas(prev => prev.map(s => s.id === updated.id ? updated : s));
                setSelectedSLA(updated);
              }}
            />
          ) : (
            <Section title="SLAs" description="Define service level agreements to ensure timely responses and resolutions.">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-gray-500">Goals in this space: <span className="border border-gray-300 rounded px-1.5 py-0.5 font-semibold text-gray-700">{slas.reduce((a, s) => a + s.goals.length, 0)} of 90</span></p>
                <button onClick={() => setShowCreateSLA(true)}
                  className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 transition-all shadow-sm">
                  <Plus size={14} /> Create SLA
                </button>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase">SLA name</th>
                      <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase">Goals</th>
                      <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase">Start condition</th>
                      <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase">Status</th>
                      <th className="px-5 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {slas.map(sla => {
                      const totalGoals = sla.goals.reduce((a, g) => a + (g.isPriorityGroup ? (g.priorityRows?.length ?? 0) + 1 : 1), 0);
                      return (
                        <tr key={sla.id} className="hover:bg-gray-50 transition-colors group cursor-pointer" onClick={() => setSelectedSLA(sla)}>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <Clock size={15} className="text-blue-500 flex-shrink-0" />
                              <span className="text-sm font-semibold text-gray-800 hover:text-blue-600 transition-colors">{sla.name}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5"><Badge color="blue">{totalGoals} goal{totalGoals !== 1 ? 's' : ''}</Badge></td>
                          <td className="px-5 py-3.5 text-sm text-gray-500">{sla.startCondition}</td>
                          <td className="px-5 py-3.5" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={async () => {
                                const next = sla.status === 'active' ? 'inactive' : 'active';
                                const updated = { ...sla, status: next as 'active' | 'inactive' };
                                try { await api.updateSLA(spaceKey, sla.id, { status: next }); } catch {}
                                setSlas(prev => prev.map(s => s.id === sla.id ? updated : s));
                              }}
                              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition-all ${
                                sla.status === 'active'
                                  ? 'bg-green-50 text-green-700 border-green-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200'
                                  : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-green-50 hover:text-green-700 hover:border-green-200'
                              }`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${sla.status === 'active' ? 'bg-green-500' : 'bg-gray-400'}`} />
                              {sla.status === 'active' ? 'Enabled' : 'Disabled'}
                            </button>
                          </td>
                          <td className="px-5 py-3.5 text-right" onClick={e => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => setSelectedSLA(sla)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"><Edit2 size={13} /></button>
                              <button onClick={async () => {
                                try { await api.deleteSLA(spaceKey, sla.id); } catch {}
                                setSlas(s => s.filter(x => x.id !== sla.id));
                              }} className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={13} /></button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {slaLoading && (
                  <div className="text-center py-10"><div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full mx-auto" /></div>
                )}
                {!slaLoading && slas.length === 0 && (
                  <div className="text-center py-14">
                    <Clock size={32} className="text-gray-200 mx-auto mb-3" />
                    <p className="text-sm font-medium text-gray-400">No SLAs configured</p>
                    <p className="text-xs text-gray-400 mt-1">Create your first SLA to track response times.</p>
                  </div>
                )}
              </div>
            </Section>
          )
        )}

        {/* Queues */}
        {tab === 'queues' && (
          <Section title="Queues" description="Organize issues into queues so agents can focus on the right work.">
            <div className="flex justify-end mb-1">
              <button className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 transition-all shadow-sm"><Plus size={14} /> Create queue</button>
            </div>
            <div className="space-y-3">
              {queues.map(q => (
                <div key={q.id} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm flex items-center gap-4 group hover:border-blue-200 transition-all">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0"><List size={17} className="text-blue-600" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-800">{q.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5 font-mono">{q.filter}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-center"><p className="text-xl font-bold text-blue-600">{q.count}</p><p className="text-[10px] text-gray-400 uppercase font-semibold">Issues</p></div>
                    <Badge color="gray">Order: {q.order}</Badge>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"><Edit2 size={13} /></button>
                      <button onClick={() => setQueues(qs => qs.filter(x => x.id !== q.id))} className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={13} /></button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Customer fields */}
        {tab === 'fields' && (
          <Section title="Customer fields" description="Custom fields that customers fill in when submitting requests.">
            <div className="flex justify-end mb-1">
              <button className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 transition-all shadow-sm"><Plus size={14} /> Add field</button>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase">Field name</th>
                    <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase">Type</th>
                    <th className="px-5 py-3 text-left text-xs font-bold text-gray-500 uppercase">Required</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {fields.map(f => (
                    <tr key={f.id} className="hover:bg-gray-50 transition-colors group">
                      <td className="px-5 py-3.5 text-sm font-semibold text-gray-800">{f.name}</td>
                      <td className="px-5 py-3.5"><Badge color="gray">{f.type}</Badge></td>
                      <td className="px-5 py-3.5">{f.required ? <Badge color="blue">Required</Badge> : <span className="text-xs text-gray-400">Optional</span>}</td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"><Edit2 size={13} /></button>
                          <button onClick={() => setFields(fs => fs.filter(x => x.id !== f.id))} className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Workflows */}
        {tab === 'workflow' && (
          <Section title="Workflows" description="Manage the workflows and statuses for this space.">
            <div className="space-y-3">
              {workflows.length > 0 ? workflows.map(wf => (
                <div key={wf.id} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm flex items-center gap-4 group hover:border-indigo-200 transition-all">
                  <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0"><GitBranch size={17} className="text-indigo-600" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-800">{wf.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{wf.statuses?.length ?? 0} statuses · {wf.transitions?.length ?? 0} transitions</p>
                  </div>
                  <Link href={`/spaces/${spaceKey}/workflow?workflowId=${wf.id}`}
                    className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800 hover:bg-blue-50 px-3 py-1.5 rounded-lg transition-all">
                    Edit workflow <ChevronRight size={13} />
                  </Link>
                </div>
              )) : (
                <div className="bg-white rounded-xl border border-gray-200 p-10 text-center shadow-sm">
                  <GitBranch size={32} className="text-gray-200 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-400">No workflows configured</p>
                </div>
              )}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100"><p className="text-sm font-bold text-gray-700">Workflow statuses</p></div>
                <div className="divide-y divide-gray-50">
                  {currentSpace.statuses?.map(s => (
                    <div key={s.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                      <span className="text-sm font-medium text-gray-800 flex-1">{s.name}</span>
                      <Badge color={s.category === 'done' ? 'green' : s.category === 'in_progress' ? 'blue' : 'gray'}>{s.category?.replace('_', ' ')}</Badge>
                      <span className="text-xs text-gray-400">Position {s.position}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Section>
        )}

        {/* Screens */}
        {tab === 'screens' && (
          <Section title="Screens" description="Screens determine which fields are shown during issue creation and transitions.">
            <div className="flex justify-end mb-1">
              <button className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 transition-all shadow-sm"><Plus size={14} /> Add screen</button>
            </div>
            <div className="space-y-4">
              {screens.map(sc => (
                <div key={sc.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-2.5"><Monitor size={15} className="text-purple-500" /><p className="text-sm font-bold text-gray-800">{sc.name}</p></div>
                    <button className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:bg-blue-50 px-3 py-1.5 rounded-lg transition-all"><Edit2 size={12} /> Edit</button>
                  </div>
                  <div className="px-5 py-3">
                    <p className="text-[11px] text-gray-400 font-bold uppercase mb-2.5">Fields on this screen</p>
                    <div className="flex flex-wrap gap-2">
                      {sc.fields.map(f => (
                        <span key={f} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-50 border border-gray-200 text-xs font-medium text-gray-700">{f}</span>
                      ))}
                      <button className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-dashed border-gray-300 text-xs font-medium text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors"><Plus size={11} /> Add field</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Labels */}
        {tab === 'labels' && (
          <Section title="Labels" description="Create labels to categorise and filter issues.">
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <div className="flex flex-wrap gap-2 mb-5 min-h-[36px]">
                {labels.length === 0 && <p className="text-sm text-gray-400">No labels yet.</p>}
                {labels.map(l => (
                  <span key={l.id} className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold border"
                    style={{ backgroundColor: l.color + '18', color: l.color, borderColor: l.color + '40' }}>{l.name}</span>
                ))}
              </div>
              <form onSubmit={handleAddLabel} className="flex items-end gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Label name</label>
                  <input type="text" value={newLabel.name} onChange={e => setNewLabel(f => ({ ...f, name: e.target.value }))} className="input-field w-48" required placeholder="e.g. bug-fix" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Colour</label>
                  <input type="color" value={newLabel.color} onChange={e => setNewLabel(f => ({ ...f, color: e.target.value }))} className="w-10 h-10 rounded-lg cursor-pointer border border-gray-200" />
                </div>
                <button type="submit" className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 transition-all shadow-sm"><Plus size={14} /> Add label</button>
              </form>
            </div>
          </Section>
        )}

        {/* Round Robin */}
        {tab === 'roundrobin' && (
          <RoundRobinTab spaceKey={spaceKey} spaceMembers={users} />
        )}

        {/* Automation */}
        {tab === 'automation' && (
          <AutomationTab
            spaceKey={spaceKey}
            currentStatuses={spaceStatuses}
          />
        )}

        {/* Email */}
        {tab === 'email' && (
          <EmailTab
            spaceKey={spaceKey}
            emailEnabled={emailEnabled} setEmailEnabled={setEmailEnabled}
            emailAddress={emailAddress}
            emailAutoReply={emailAutoReply} setEmailAutoReply={setEmailAutoReply}
            emailAutoReplyText={emailAutoReplyText} setEmailAutoReplyText={setEmailAutoReplyText}
            emailDefaultType={emailDefaultType} setEmailDefaultType={setEmailDefaultType}
            connectedEmails={connectedEmails} setConnectedEmails={setConnectedEmails}
            showAddEmail={showAddEmail} setShowAddEmail={setShowAddEmail}
            newExternalEmail={newExternalEmail} setNewExternalEmail={setNewExternalEmail}
            viewingLogs={viewingLogs} setViewingLogs={setViewingLogs}
            emailLogs={emailLogs}
            loadEmailLogs={loadEmailLogs}
            sendingTestEmail={sendingTestEmail} setSendingTestEmail={setSendingTestEmail}
            testEmailFrom={testEmailFrom} setTestEmailFrom={setTestEmailFrom}
            testEmailSubject={testEmailSubject} setTestEmailSubject={setTestEmailSubject}
            showTestEmailForm={showTestEmailForm} setShowTestEmailForm={setShowTestEmailForm}
            emailActionsMenuId={emailActionsMenuId} setEmailActionsMenuId={setEmailActionsMenuId}
          />
        )}

      </div>
    </div>
  );
}

export default function SpaceSettingsPage() {
  return (
    <Suspense fallback={<div className="flex h-64 items-center justify-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'-0.3s'}} /><span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'-0.15s'}} /><span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'0s'}} /></div>}>
      <SpaceSettingsContent />
    </Suspense>
  );
}
