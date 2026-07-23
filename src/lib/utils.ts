import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export const priorityColors: Record<string, string> = {
  highest: '#E11D48',
  high:    '#D97706',
  medium:  '#7C3AED',
  low:     '#0891B2',
  lowest:  '#64748B',
};

export const priorityIcons: Record<string, string> = {
  highest: '⬆⬆',
  high: '⬆',
  medium: '➡',
  low: '⬇',
  lowest: '⬇⬇',
};

export const typeIcons: Record<string, { icon: string; color: string }> = {
  epic:            { icon: '', color: '#6554C0' },
  story:           { icon: '', color: '#36B37E' },
  task:            { icon: '', color: '#0065FF' },
  bug:             { icon: '', color: '#FF5630' },
  subtask:         { icon: '', color: '#0065FF' },
  service_request: { icon: '', color: '#00B8D9' },
  incident:        { icon: '', color: '#FF7452' },
};

export function getInitials(firstName?: string, lastName?: string): string {
  return `${(firstName || '')[0] || ''}${(lastName || '')[0] || ''}`.toUpperCase();
}

export function formatDate(date: string | undefined): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function formatDateTime(date: string | undefined): string {
  if (!date) return '';
  return new Date(date).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** Jira-style: "17/Sep/25 9:04 PM" */
export function formatJiraDateTime(date: string | undefined | null): string {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';
  const day   = String(d.getDate()).padStart(2, '0');
  const month = d.toLocaleString('en-US', { month: 'short' });
  const year  = String(d.getFullYear()).slice(2);
  const time  = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day}/${month}/${year} ${time}`;
}

export type IssueStatusShape = {
  id: string;
  name: string;
  color: string;
  category?: string;
};

const STATUS_CATEGORY_COLORS: Record<string, string> = {
  done: '#10B981',
  in_progress: '#3B82F6',
  todo: '#64748B',
};

const STATUS_NAME_COLORS: Record<string, string> = {
  'resolved': '#10B981',
  'done': '#10B981',
  'closed': '#10B981',
  'completed': '#10B981',
  'fixed': '#10B981',
  'in progress': '#3B82F6',
  'in review': '#60A5FA',
  'active': '#3B82F6',
  'in development': '#3B82F6',
  'open': '#64748B',
  'to do': '#64748B',
  'new': '#64748B',
  'backlog': '#64748B',
  'on hold': '#F59E0B',
  'waiting': '#F59E0B',
  'blocked': '#EF4444',
  'cancelled': '#EF4444',
  'rejected': '#EF4444',
};

export function resolveStatusColor(status: { name?: string; color?: string; category?: string }): string {
  const name = (status.name || '').toLowerCase().trim();
  if (STATUS_NAME_COLORS[name]) return STATUS_NAME_COLORS[name];
  if (status.category && STATUS_CATEGORY_COLORS[status.category]) return STATUS_CATEGORY_COLORS[status.category];
  return status.color || '#64748B';
}

const FALLBACK_ISSUE_STATUS: IssueStatusShape = {
  id: '_unknown',
  name: '—',
  color: '#94a3b8',
  category: 'todo',
};

/** Use when rendering issue rows — missing `status` used to crash the space/issues views. */
export function getIssueStatus(issue: { status?: IssueStatusShape | null }): IssueStatusShape {
  const s = issue.status;
  if (s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.color === 'string') {
    return { ...s, color: resolveStatusColor(s) };
  }
  return FALLBACK_ISSUE_STATUS;
}

export function timeAgo(date: string | undefined | null): string {
  if (!date) return '—';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(date);
}
