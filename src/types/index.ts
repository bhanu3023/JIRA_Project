export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  organizationId: string;
  avatarUrl?: string;
  isActive?: boolean;
  createdAt?: string;
}

export interface Space {
  id: string;
  name: string;
  key: string;
  description?: string;
  type: 'scrum' | 'kanban' | 'service_desk';
  icon?: string;
  leadId?: string;
  leadName?: string;
  issueCount?: number;
  memberCount?: number;
  members?: SpaceMember[];
  statuses?: WorkflowStatus[];
  createdAt?: string;
}

export interface SpaceMember {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
  role: string;
}

export interface WorkflowStatus {
  id: string;
  name: string;
  category: 'todo' | 'in_progress' | 'done';
  color: string;
  position: number;
}

export interface Issue {
  id: string;
  key: string;
  issueNumber: number;
  summary: string;
  description?: string;
  type: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
  priority: 'highest' | 'high' | 'medium' | 'low' | 'lowest';
  status: { id: string; name: string; category: string; color: string };
  spaceKey: string;
  spaceName?: string;
  spaceId: string;
  assignee?: { id: string; firstName: string; lastName: string; avatarUrl?: string; email?: string } | null;
  reporter?: { id: string; firstName: string; lastName: string; email?: string } | null;
  parent?: { id: string; key: string; summary: string } | null;
  parentId?: string;
  sprintId?: string;
  sprintName?: string;
  storyPoints?: number;
  dueDate?: string;
  resolvedAt?: string;
  position?: number;
  commentCount?: number;
  attachmentCount?: number;
  comments?: Comment[];
  labels?: Label[];
  attachments?: Attachment[];
  links?: IssueLink[];
  children?: ChildIssue[];
  activity?: ActivityLog[];
  sla?: SLA[];
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  body: string;
  isInternal: boolean;
  author: { id: string; firstName: string; lastName: string; avatarUrl?: string; email?: string };
  authorName?: string;
  createdAt: string;
  updatedAt: string;
  reactions?: Record<string, string[]>;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Attachment {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  uploader: { firstName: string; lastName: string };
  createdAt: string;
}

export interface IssueLink {
  id: string;
  type: string;
  source: { key: string; summary: string; type: string };
  target: { key: string; summary: string; type: string };
}

export interface ChildIssue {
  id: string;
  key: string;
  cfKey?: string | null;
  summary: string;
  type: string;
  priority: string;
  status: { name: string; color: string };
  assignee?: { id: string; firstName: string; lastName: string; avatarUrl?: string | null } | null;
}

export interface ActivityLog {
  id: string;
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  user: { firstName: string; lastName: string };
  createdAt: string;
}

export interface SLA {
  id: string;
  policyName: string;
  startTime: string;
  dueTime: string;
  isBreached: boolean;
  isCompleted: boolean;
  totalPausedMinutes: number;
}

export interface Sprint {
  id: string;
  name: string;
  goal?: string;
  status: 'planning' | 'active' | 'completed';
  spaceKey?: string;
  startDate?: string;
  endDate?: string;
  issueCount?: number;
  totalPoints?: number;
  completedCount?: number;
  createdAt?: string;
}

export interface AutomationRule {
  id: string;
  name: string;
  isActive: boolean;
  triggerType: string;
  triggerConfig: any;
  conditions: any[];
  actions: any[];
  createdBy: { firstName: string; lastName: string };
  executionCount: number;
  lastExecutedAt?: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  message?: string;
  issueKey?: string;
  isRead: boolean;
  createdAt: string;
}

export interface DashboardData {
  totalIssues: number;
  byStatus: { category: string; name: string; color: string; count: number }[];
  byPriority: { priority: string; count: number }[];
  byType: { type: string; count: number }[];
  byAssignee: { name: string; count: number }[];
  slaBreaches: number;
  trend: { date: string; created: number; resolved: number }[];
  recentActivity: { action: string; field?: string; oldValue?: string; newValue?: string; user: string; issueKey: string; createdAt: string }[];
}
