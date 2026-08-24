'use client';

import { useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { WorkflowStatus, SpaceMember } from '@/types';
import { X, ChevronDown, Info, AlertCircle, Search, Check } from 'lucide-react';
import { getInitials, cn } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import SpaceIcon from '@/components/ui/SpaceIcon';
import { api } from '@/lib/api';
import PriorityDropdown from '@/components/ui/PriorityDropdown';
import DeptDropdown from '@/components/ui/DeptDropdown';
import RichTextEditor, { linkifyPlainUrls } from '@/components/ui/RichTextEditor';
import { MIGRATION_DESCRIPTION_TEMPLATE_HTML } from '@/lib/migration-description-template';

interface Props {
  spaceKey: string;
  statuses: WorkflowStatus[];
  members: SpaceMember[];
  initialDept?: string;
  onClose: () => void;
  onCreated: (issue?: any) => void;
}

// Fallback status list for a queue that's configured but has no queueStatuses
// of its own — shows this minimal set instead of the space's entire unscoped
// list, matching the same default used on the issue detail page's status
// dropdown for the same situation.
const DEFAULT_QUEUE_STATUSES: WorkflowStatus[] = [
  { id: 'qst_default_open', name: 'Open', category: 'todo', color: '#6366F1' } as WorkflowStatus,
  { id: 'qst_default_inprogress', name: 'In Progress', category: 'in_progress', color: '#3B82F6' } as WorkflowStatus,
  { id: 'qst_default_resolved', name: 'Resolved', category: 'done', color: '#10B981' } as WorkflowStatus,
];

// Migration-queue tickets follow a standard investigation writeup. Three
// earlier attempts at this all put the section headings AND the answer
// area inside the SAME single contentEditable region as sibling nodes
// (plain paragraphs, then a bordered <div>, then the same div with
// placeholder text) -- every one of them let Backspace merge an answer
// block into the heading paragraph right before it, since that's just how
// browsers resolve "delete backward past the start of this block" for any
// two adjacent block-level siblings, regardless of tag or styling. Fixing
// the merge behavior itself (short of a bespoke keydown interceptor added
// to the shared RichTextEditor -- disproportionate for a component used
// everywhere else in the app too) isn't reliable.
//
// Structural fix: give each section its OWN independent RichTextEditor
// instance, with the heading rendered as plain React text OUTSIDE any
// contentEditable region at all. A heading that was never editable can't
// be edited or merged into by anything happening in a sibling editor --
// there's no shared DOM tree for a browser merge behavior to act on. Each
// section is the exact same rich editor the main Description uses (bold,
// headers, lists, pasted images, links -- everything), and its placeholder
// is the editor's own native one (a safe, already-proven mechanism, since
// there's nothing before a lone top-level empty editor to merge into).
// All nine are concatenated into one HTML string for the single
// `description` field on submit -- no new database columns.
const MIGRATION_SECTION_LABELS = [
  'Issue Reported',
  'Error Description',
  'Screenshots',
  'Source and Destination Comparison and Findings',
  'Metabase Results',
  'Postman Results',
  'Grafana Results',
  'Workspace Ids',
  'Server Url',
];

// Combination / Product Type / Project Manager are data-migration concepts
// (a source/destination combo, which PM owns the migration) that only make
// sense on the Migration/Dev support board — they were never meant to be
// mandatory on every space in the app. IT Administration is a plain service
// desk space with no migration concept at all, so these fields (and their
// "required" validation) don't apply there. SAT_Board (key "SB") is the same
// kind of non-migration board, so it gets the same exemption.
const NON_MIGRATION_SPACE_KEYS = new Set(['IA', 'SB']);

const WORK_TYPES = [
  { value: 'task',            label: 'Task' },
  { value: 'bug',             label: 'Bug' },
  { value: 'subtask',         label: 'Sub-task' },
  { value: 'service_request', label: 'Service Request' },
];

const COMBINATION_OPTIONS = [
  'Box - OneDrive', 'Box - SharePoint', 'Box - MyDrive', 'Box - ShareDrive',
  'Box - Dropbox', 'Box - Box', 'Box - Cirtix', 'Box - Amazon S3',
  'Dropbox - OneDrive', 'Dropbox - SharePoint', 'Dropbox - MyDrive',
  'Dropbox - ShareDrive', 'Dropbox - Azure', 'Dropbox - Box', 'Dropbox - Egnyte',
  'MyDrive - OneDrive', 'MyDrive - SharePoint', 'MyDrive - Dropbox',
  'MyDrive - Egnyte', 'MyDrive - Box', 'My Drive - My Drive', 'MyDrive - MyDrive',
  'ShareDrive - ShareDrive', 'ShareDrive - SharePoint', 'ShareDrive - Egnyte',
  'ShareDrive - OneDrive', 'ShareDrive - Amazon S3',
  'Cirtix - OneDrive', 'Cirtix - SharePoint', 'Cirtix - MyDrive',
  'Cirtix - SharedDrive', 'Cirtix - Cirtix',
  'Egnyte - OneDrive', 'Egnyte - SharePoint', 'Egnyte - MyDrive',
  'Egnyte - Shared Drive', 'Egnyte - Azure',
  'SharePoint - ShareDrive', 'SharePoint - MyDrive', 'SharePoint - SharePoint',
  'SharePoint - Amazon S3', 'SharePoint - Azure', 'SharePoint - Egnyte',
  'NFS - OneDrive', 'NFS - SharePoint', 'NFS - MyDrive', 'NFS - SharedDrive',
  'OneDrive - Amazon S3', 'OneDrive - OneDrive', 'OneDrive - MyDrive',
  'Sharefile - Amazon S3', 'Sharefile - Azure',
  'Sharedrive - Azure',
  'Amazon S3 - SharePoint',
  'Amazon Workdocs - NFS',
  'Slack - Slack', 'Slack - Teams', 'Slack - Chat',
  'Chat - Chat', 'Chat - Teams', 'Chat - Slack',
  'Teams - Teams', 'Teams - Chat', 'Teams - Slack',
  'Meta - Chat', 'Meta - Teams', 'Meta - Viva',
  'Gmail - Gmail', 'Gmail - Outlook',
  'Outlook - Outlook', 'Outlook - Gmail',
  'Other',
];

// Searchable multi-select dropdown
function MultiSelectDropdown({ value, onChange, options, placeholder }: { value: string[]; onChange: (v: string[]) => void; options: string[]; placeholder: string }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = options.filter(o =>
    o.toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (opt: string) => {
    if (value.includes(opt)) onChange(value.filter(v => v !== opt));
    else onChange([...value, opt]);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full min-h-[36px] flex items-center justify-between px-3 py-1.5 bg-white border border-gray-300 rounded text-[13px] hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
      >
        <span className="flex flex-wrap gap-1 flex-1 text-left">
          {value.length === 0
            ? <span className="text-gray-400">{placeholder}</span>
            : value.map(v => (
                <span key={v} className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 text-[11px] font-medium px-2 py-0.5 rounded-full border border-blue-200">
                  {v}
                  <button type="button" onClick={e => { e.stopPropagation(); toggle(v); }} className="hover:text-red-500">
                    <X size={10} />
                  </button>
                </span>
              ))
          }
        </span>
        <ChevronDown size={14} className={`text-gray-400 flex-shrink-0 ml-1 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-full z-[9999] bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden">
          {/* Search */}
          <div className="px-2 py-1.5 border-b border-gray-100">
            <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-50 rounded border border-gray-200">
              <Search size={12} className="text-gray-400 flex-shrink-0" />
              <input
                autoFocus
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search..."
                className="flex-1 text-[12px] bg-transparent outline-none text-gray-700 placeholder-gray-400"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600">
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          {/* Options */}
          <div className="max-h-48 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-gray-400 text-center">No options found</p>
            ) : (
              filtered.map(opt => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggle(opt)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-blue-50 transition-colors ${
                    value.includes(opt) ? 'text-blue-600 bg-blue-50 font-medium' : 'text-gray-700'
                  }`}
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${value.includes(opt) ? 'bg-blue-600 border-blue-600' : 'border-gray-300'}`}>
                    {value.includes(opt) && <Check size={10} className="text-white" />}
                  </div>
                  <span>{opt}</span>
                </button>
              ))
            )}
          </div>

          {/* Clear */}
          {value.length > 0 && (
            <div className="border-t border-gray-100 px-2 py-1.5">
              <button
                type="button"
                onClick={() => { onChange([]); setSearch(''); }}
                className="w-full text-[12px] text-gray-500 hover:text-red-500 py-1 transition-colors"
              >
                Clear all ({value.length})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CreateIssueModal({ spaceKey, statuses, members, initialDept, onClose, onCreated }: Props) {
  const { createIssue, spaces, user } = useStore(
    useShallow((s) => ({
      createIssue: s.createIssue,
      spaces: s.spaces,
      user: s.user,
    })),
  );

  const [selectedSpaceKey, setSelectedSpaceKey] = useState(spaceKey);
  const [spaceMembers, setSpaceMembers]         = useState<SpaceMember[]>(members);
  // baseStatuses = the space's own full status list (fallback when the
  // selected queue has no restricted list of its own). spaceStatuses = what
  // the Status dropdown actually shows — narrowed to the selected queue's
  // queueStatuses when it has one, same concept the issue detail page's
  // status dropdown already uses for department workflows.
  const [baseStatuses, setBaseStatuses]         = useState<WorkflowStatus[]>(statuses);
  const [spaceStatuses, setSpaceStatuses]       = useState<WorkflowStatus[]>(statuses);
  const [createIssueFields, setCreateIssueFields] = useState<any[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});
  const [spaceQueues, setSpaceQueues] = useState<{ id: string; label: string; dept?: string; queueStatuses?: WorkflowStatus[]; memberIds?: string[]; suspendedIds?: string[] }[]>([]);
  const [selectedQueueId, setSelectedQueueId] = useState('');
  const [form, setForm] = useState({
    summary: '',
    description: '',
    type: 'task', priority: 'medium',
    assigneeId: '', storyPoints: '', dueDate: '', statusId: '', combination: [] as string[], department: initialDept || '',
    productType: [] as string[], projectManager: [] as string[], productionTicket: '',
    projectPool: '',
  });
  // One independent rich-text value per Migration section (see
  // MIGRATION_SECTION_LABELS above for why these are separate editors
  // rather than one shared region). Concatenated into `description` at
  // submit time -- see handleSubmit.
  const [migrationSections, setMigrationSections] = useState<string[]>(() => MIGRATION_SECTION_LABELS.map(() => ''));
  const [migrationUploading, setMigrationUploading] = useState<boolean[]>(() => MIGRATION_SECTION_LABELS.map(() => false));
  const isMigrationDept = form.department.toLowerCase() === 'migration';
  const [summaryError, setSummaryError] = useState(false);
  const [queueError, setQueueError]                 = useState(false);
  const [combinationError, setCombinationError]     = useState(false);
  const [productTypeError, setProductTypeError]     = useState(false);
  const [projectManagerError, setProjectManagerError] = useState(false);
  const [projectPoolError, setProjectPoolError]       = useState(false);
  // Admin-configured custom fields (e.g. "Project Pool") each carry their own
  // `required` flag from Settings > Custom Fields, but nothing here ever
  // read it -- the field rendered with no asterisk and Create succeeded even
  // when it was left blank, regardless of what the admin had configured.
  // Keyed by field id since the set of custom fields is dynamic per space.
  const [customFieldErrors, setCustomFieldErrors] = useState<Record<string, boolean>>({});
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [infoBannerVisible, setInfoBannerVisible] = useState(true);
  const [requestTypeOpen, setRequestTypeOpen]     = useState(false);

  const currentSpace = spaces.find(s => s.key === selectedSpaceKey);

  // Load members & statuses when space changes
  useEffect(() => {
    if (selectedSpaceKey !== spaceKey) {
      api.getSpace(selectedSpaceKey).then((space: any) => {
        setSpaceMembers(space.members || []);
        setBaseStatuses(space.statuses || []);
      }).catch(() => {});
    } else {
      setSpaceMembers(members);
      setBaseStatuses(statuses);
    }
  }, [selectedSpaceKey]);

  // Migration board tickets must always start with the fixed, locked
  // description headings (RichTextEditor enforces that they can't be
  // removed/edited afterward) -- insert them the moment Migration becomes
  // the selected space, but only while the description is still empty so a
  // reporter's own typed content is never clobbered.
  useEffect(() => {
    if (selectedSpaceKey === 'L1BOAR') {
      setForm(f => (f.description.trim() ? f : { ...f, description: MIGRATION_DESCRIPTION_TEMPLATE_HTML }));
    }
  }, [selectedSpaceKey]);

  // Load queues for the selected space — keep each queue's own queueStatuses
  // so the Status dropdown can be narrowed to whatever that specific queue's
  // workflow allows (e.g. Dev queue vs Migration queue each having a
  // different, smaller set of valid statuses).
  useEffect(() => {
    const builtIn = [
      { id: 'all-open',      label: 'All Open' },
      { id: 'unassigned',    label: 'Unassigned' },
      { id: 'assigned',      label: 'Assigned' },
      { id: 'my-queue',      label: 'My Queue' },
      { id: 'all-requests',  label: 'All Requests' },
    ];
    api.request<any[]>(`custom-queues/${selectedSpaceKey}`).then((q) => {
      const custom = (q || []).map((cq: any) => ({
        id: cq.id, label: cq.name, dept: cq.name,
        queueStatuses: cq.queueStatuses,
        memberIds: cq.memberIds, suspendedIds: cq.suspendedIds,
      }));
      setSpaceQueues([...builtIn, ...custom]);
    }).catch(() => {
      setSpaceQueues(builtIn);
    });
  }, [selectedSpaceKey]);

  const selectedQueue = form.department
    ? spaceQueues.find(q => q.dept?.toLowerCase() === form.department.toLowerCase())
    : undefined;

  // Pre-Sales and QA tickets don't have a project manager assigned at creation time.
  // Infra tickets don't have one either, by request -- same exemption, one more dept.
  const skipsProjectManager = ['pre-sales', 'qa', 'infra'].includes(form.department.trim().toLowerCase());
  // Infra keeps Combination, Product Type, and Project Pool on the form
  // (still useful data to capture when known) but, unlike every other
  // migration-style department, never requires them to create a ticket --
  // by request.
  const skipsInfraOptionalFields = form.department.trim().toLowerCase() === 'infra';
  const showMigrationFields = !NON_MIGRATION_SPACE_KEYS.has(selectedSpaceKey.toUpperCase());

  // Narrow the Status dropdown to the selected queue's own status list, same
  // as the issue detail page's department status dropdown already does —
  // falls back to the space's full list when the queue has no restricted one.
  const hasDeptQueues = spaceQueues.some(q => !!q.dept);
  useEffect(() => {
    // Selected a queue but it has no status list of its own configured — use
    // the minimal default rather than the space's entire unscoped list. If
    // this space routes through departments at all but none is picked yet,
    // show that same minimal default too — the full unscoped list (every
    // status ever used on every board) is never a useful thing to show here,
    // and a department must be chosen before the ticket can be created
    // anyway. Only spaces with no department concept at all fall back to
    // the space's full list, since there's no queue context to narrow by.
    const nextStatuses = selectedQueue?.queueStatuses?.length
      ? selectedQueue.queueStatuses
      : selectedQueue || hasDeptQueues
      ? DEFAULT_QUEUE_STATUSES
      : baseStatuses;
    setSpaceStatuses(nextStatuses);
    // If the currently-selected status isn't valid for this queue, clear it
    // so the "Set default status" effect below picks a valid one.
    if (form.statusId && !nextStatuses.some(s => s.id === form.statusId)) {
      setForm(f => ({ ...f, statusId: '' }));
    }
  }, [selectedQueue, baseStatuses, hasDeptQueues]);

  // Assignee options — only members with access to the selected queue (its
  // memberIds, minus anyone suspended from it), not every member of the whole
  // space. Falls back to full space membership when the queue has no
  // configured member list (or no queue is selected).
  const assigneeOptions = (() => {
    const memberIds = selectedQueue?.memberIds;
    if (!memberIds?.length) return spaceMembers;
    const suspended = new Set((selectedQueue as any)?.suspendedIds || []);
    const allowed = new Set(memberIds.filter((id: string) => !suspended.has(id)));
    return spaceMembers.filter(m => allowed.has(m.id));
  })();

  // If the currently-selected assignee has no access to the newly-selected
  // queue, clear it rather than silently keeping an invalid assignment.
  useEffect(() => {
    if (form.assigneeId && !assigneeOptions.some(m => m.id === form.assigneeId)) {
      setForm(f => ({ ...f, assigneeId: '' }));
    }
  }, [selectedQueue]);

  // Load custom fields enabled for Create Issue for the selected space
  useEffect(() => {
    const space = spaces.find(s => s.key === selectedSpaceKey);
    if (!space) return;
    api.getCustomFields().then((fields: any[]) => {
      const enabled = fields.filter((f: any) => {
        if (f.isDeleted) return false;
        const createIds: string[] = Array.isArray(f.createIssueSpaceIds) ? f.createIssueSpaceIds : [];
        return createIds.includes(space.id);
      });
      setCreateIssueFields(enabled);
    }).catch(() => {});
  }, [selectedSpaceKey, spaces]);

  // Set default status
  useEffect(() => {
    if (spaceStatuses.length > 0 && !form.statusId) {
      const def = spaceStatuses.find(s => s.name.toLowerCase() === 'open')
        || spaceStatuses.find(s => s.name.toLowerCase() === 'to do')
        || spaceStatuses.find(s => s.name.toLowerCase() === 'todo')
        || spaceStatuses[0];
      setForm(f => ({ ...f, statusId: def.id }));
    }
  }, [spaceStatuses]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    const missingSummary        = !form.summary.trim();
    // Only require a queue when this space actually has queues to pick from
    const missingQueue          = queueOptions.length > 0 && !form.department;
    const missingCombination    = showMigrationFields && !skipsInfraOptionalFields && form.combination.length === 0;
    const missingProductType    = showMigrationFields && !skipsInfraOptionalFields && form.productType.length === 0;
    const missingProjectManager = showMigrationFields && form.projectManager.length === 0 && !skipsProjectManager;
    const missingProjectPool    = showMigrationFields && !skipsInfraOptionalFields && !form.projectPool.trim();
    const missingCustomFields = createIssueFields.filter((cf: any) => cf.required && !String(customFieldValues[cf.id] || '').trim());

    setSummaryError(missingSummary);
    setQueueError(missingQueue);
    setCombinationError(missingCombination);
    setProductTypeError(missingProductType);
    setProjectManagerError(missingProjectManager);
    setProjectPoolError(missingProjectPool);
    setCustomFieldErrors(Object.fromEntries(missingCustomFields.map((cf: any) => [cf.id, true])));

    if (missingSummary || missingQueue || missingCombination || missingProductType || missingProjectManager || missingProjectPool || missingCustomFields.length > 0) {
      const missingLabels = [
        missingSummary && 'Summary',
        missingQueue && 'Queue',
        missingCombination && 'Combination',
        missingProductType && 'Product Type',
        missingProjectManager && 'Project Manager',
        missingProjectPool && 'Project Pool',
        ...missingCustomFields.map((cf: any) => cf.name),
      ].filter(Boolean);
      setError(`Please fill in the required field${missingLabels.length > 1 ? 's' : ''}: ${missingLabels.join(', ')}`);
      return;
    }
    if (uploading || migrationUploading.some(Boolean)) { setError('Please wait for attachments to finish uploading before creating.'); return; }
    setError('');
    setLoading(true);
    try {
      // Each Migration section is its own isolated editor (see
      // MIGRATION_SECTION_LABELS above) -- concatenate them into the one
      // `description` field the backend actually stores. A section left
      // untouched still shows its heading with nothing under it, same as
      // any optional field someone skipped.
      const rawDescription = isMigrationDept
        ? MIGRATION_SECTION_LABELS.map((label, i) => `<p><strong>${i + 1}. ${label}</strong></p>${migrationSections[i] || ''}`).join('')
        : form.description;
      // Backstop for a URL typed as the very last thing in a field, with
      // nothing typed after it -- RichTextEditor's own live handlers
      // (space-triggered, and on blur) should already catch this, but this
      // runs as a plain string pass right before saving regardless of
      // whether either of those fired in time.
      const description = linkifyPlainUrls(rawDescription);
      const newIssue = await createIssue({
        spaceKey: selectedSpaceKey,
        summary: form.summary,
        description,
        type: form.type,
        priority: form.priority,
        assigneeId: form.assigneeId || undefined,
        dueDate: form.dueDate || undefined,
        statusId: form.statusId || undefined,
        combination: form.combination.length > 0 ? form.combination.join(', ') : undefined,
        productType: form.productType.length > 0 ? form.productType.join(', ') : undefined,
        projectManager: form.projectManager.length > 0 ? form.projectManager.join(', ') : undefined,
        productionTicket: form.productionTicket || undefined,
        projectPool: form.projectPool || undefined,
        ...(form.department ? { department: form.department } : initialDept ? { department: initialDept } : {}),
      });
      // Save custom field values
      if (newIssue?.id) {
        await Promise.all(
          Object.entries(customFieldValues)
            .filter(([, v]) => v)
            .map(([fieldId, value]) => api.setCustomFieldValue(newIssue.id, fieldId, value).catch(() => {}))
        );
      }
      onCreated(newIssue);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const update = (field: string, value: any) => {
    setForm(f => ({ ...f, [field]: value }));
    if (field === 'summary' && value.trim()) setSummaryError(false);
    if (field === 'department' && value) setQueueError(false);
    if (field === 'combination' && Array.isArray(value) && value.length > 0) setCombinationError(false);
    if (field === 'productType' && Array.isArray(value) && value.length > 0) setProductTypeError(false);
    if (field === 'projectManager' && Array.isArray(value) && value.length > 0) setProjectManagerError(false);
    if (field === 'projectPool' && value) setProjectPoolError(false);
  };

  const selectedAssignee = spaceMembers.find(m => m.id === form.assigneeId);
  const workTypeLabel = WORK_TYPES.find(t => t.value === form.type)?.label || 'Task';
  // Real department destinations only — the built-in entries (Unassigned/Assigned/My
  // Queue/All Requests) are list-filter views, not places a new ticket can be routed to.
  // Non-admins only see queues they're a member of (and not suspended from) — same
  // access rule as the Queues overview page, so this list matches what they can open.
  const isAdmin = user?.role === 'admin';
  const queueOptions = Array.from(new Set(
    spaceQueues
      .filter(q => !!q.dept)
      .filter(q => isAdmin || (
        (q.memberIds || []).includes(user?.id || '') && !(q.suspendedIds || []).includes(user?.id || '')
      ))
      .map(q => q.dept as string)
  ));

  // A user restricted to a single queue (e.g. a Migration engineer/manager who
  // only has access to the Migration queue) has nothing to actually choose —
  // opening Create from the space itself (rather than from inside that
  // queue's own "All Tickets" view, which passes initialDept from the URL)
  // otherwise leaves department blank until they manually pick it, which also
  // hides department-specific UI like the Migration description template
  // until they do. Default straight to the only option they have.
  useEffect(() => {
    if (!form.department && queueOptions.length === 1) {
      setForm(f => (f.department ? f : { ...f, department: queueOptions[0] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueOptions.join('|'), form.department]);

  const categoryOrder: Record<string, number> = { todo: 0, in_progress: 1, done: 3 };
  const sortedStatuses = [...spaceStatuses].sort((a, b) => {
    const ac = (a as any).category as string | undefined;
    const bc = (b as any).category as string | undefined;
    const ao = ac !== undefined ? (categoryOrder[ac] ?? 2) : 2;
    const bo = bc !== undefined ? (categoryOrder[bc] ?? 2) : 2;
    return ao - bo;
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-[960px] max-h-[92vh] flex flex-col shadow-2xl">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <IssueTypeIcon type={form.type || 'task'} size={18} />
              <h2 className="text-[15px] font-semibold text-gray-900">Create {workTypeLabel}</h2>
            </div>
            {currentSpace && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 rounded-full">
                <div className="w-4 h-4 rounded flex items-center justify-center bg-blue-600">
                  <SpaceIcon icon={currentSpace.icon} spaceKey={currentSpace.key} size="sm" />
                </div>
                <span className="text-[12px] text-gray-600 font-medium">{currentSpace.name}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"><X size={15} /></button>
          </div>
        </div>

        {/* ── Body: two-column layout ── */}
        <div className="flex-1 overflow-hidden flex min-h-0">

          {/* Left panel — summary + description */}
          <div className="flex-1 overflow-y-auto px-6 py-5 border-r border-gray-100">
            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-md text-sm mb-4">
                <AlertCircle size={14} className="flex-shrink-0" />
                {error}
              </div>
            )}

            {/* Summary */}
            <div className="mb-5">
              <label className="block text-[13px] font-semibold text-gray-700 mb-1.5">
                Summary <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.summary}
                onChange={e => update('summary', e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
                className={`w-full px-3 py-2.5 border rounded-lg text-[13px] focus:outline-none focus:ring-2 placeholder-gray-400 ${
                  summaryError
                    ? 'border-red-400 focus:ring-red-300 bg-red-50'
                    : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500'
                }`}
                placeholder="What needs to be done?"
                autoFocus
              />
              {summaryError && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <AlertCircle size={13} className="text-red-500 flex-shrink-0" />
                  <p className="text-[12px] text-red-600 font-medium">Summary is required</p>
                </div>
              )}
            </div>

            {/* Description */}
            <div className="mb-5">
              <label className="block text-[13px] font-semibold text-gray-700 mb-1.5">Description</label>
              {isMigrationDept ? (
                <div className="flex flex-col gap-1">
                  {MIGRATION_SECTION_LABELS.map((label, i) => (
                    <div key={label} className="border border-gray-200 rounded-lg p-2.5">
                      <p className="text-[12.5px] font-semibold text-gray-600 mb-1">{i + 1}. {label}</p>
                      <RichTextEditor
                        value={migrationSections[i]}
                        onChange={v => setMigrationSections(prev => prev.map((x, idx) => (idx === i ? v : x)))}
                        placeholder=""
                        minHeight="70px"
                        onUploadingChange={u => setMigrationUploading(prev => prev.map((x, idx) => (idx === i ? u : x)))}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <RichTextEditor
                  value={form.description}
                  onChange={v => update('description', v)}
                  placeholder="Add a description… paste or drag images, use the toolbar to format"
                  minHeight="280px"
                  onUploadingChange={setUploading}
                />
              )}
            </div>

            {showMigrationFields && (
              <>
                {/* Combination */}
                <div className="mb-4">
                  <label className="block text-[13px] font-semibold text-gray-700 mb-1.5">
                    Combination {!skipsInfraOptionalFields && <span className="text-red-500">*</span>}
                  </label>
                  <div className={combinationError ? 'rounded-lg ring-2 ring-red-300' : ''}>
                    <MultiSelectDropdown
                      value={form.combination}
                      onChange={v => update('combination', v)}
                      options={COMBINATION_OPTIONS}
                      placeholder="Select combinations..."
                    />
                  </div>
                  {combinationError && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <AlertCircle size={13} className="text-red-500 flex-shrink-0" />
                      <p className="text-[12px] text-red-600 font-medium">Combination is required</p>
                    </div>
                  )}
                </div>

                {/* Product Type */}
                <div className="mb-4">
                  <label className="block text-[13px] font-semibold text-gray-700 mb-1.5">
                    Product Type {!skipsInfraOptionalFields && <span className="text-red-500">*</span>}
                  </label>
                  <div className={productTypeError ? 'rounded-lg ring-2 ring-red-300' : ''}>
                    <MultiSelectDropdown
                      value={form.productType}
                      onChange={v => update('productType', v)}
                      options={['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others','Others']}
                      placeholder="Select product type..."
                    />
                  </div>
                  {productTypeError && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <AlertCircle size={13} className="text-red-500 flex-shrink-0" />
                      <p className="text-[12px] text-red-600 font-medium">Product Type is required</p>
                    </div>
                  )}
                </div>

                {/* Production Ticket */}
                <div className="mb-4">
                  <label className="block text-[13px] font-semibold text-gray-700 mb-1.5">Production Ticket</label>
                  <select
                    value={form.productionTicket}
                    onChange={e => update('productionTicket', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="">Select Production Ticket</option>
                    <option value="Operational Support">Operational Support</option>
                    <option value="Code Fixes">Code Fixes</option>
                  </select>
                </div>

                {/* Project Pool */}
                <div className="mb-4">
                  <label className="block text-[13px] font-semibold text-gray-700 mb-1.5">
                    Project Pool {!skipsInfraOptionalFields && <span className="text-red-500">*</span>}
                  </label>
                  <select
                    value={form.projectPool}
                    onChange={e => update('projectPool', e.target.value)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-[13px] focus:outline-none focus:ring-2 bg-white",
                      projectPoolError ? 'border-red-300 ring-2 ring-red-300 focus:ring-red-300' : 'border-gray-300 focus:ring-blue-500',
                    )}
                  >
                    <option value="">Select Project Pool</option>
                    <option value="ENT">ENT</option>
                    <option value="SMB">SMB</option>
                  </select>
                  {projectPoolError && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <AlertCircle size={13} className="text-red-500 flex-shrink-0" />
                      <p className="text-[12px] text-red-600 font-medium">Project Pool is required</p>
                    </div>
                  )}
                </div>

                {/* Project Manager */}
                <div className="mb-4">
                  <label className="block text-[13px] font-semibold text-gray-700 mb-1.5">
                    Project Manager {!skipsProjectManager && <span className="text-red-500">*</span>}
                  </label>
                  <div className={projectManagerError ? 'rounded-lg ring-2 ring-red-300' : ''}>
                    <MultiSelectDropdown
                      value={form.projectManager}
                      onChange={v => update('projectManager', v)}
                      options={['Harika','Abhishek','Ajay Singh','Abhishikth','Raghu','Lakshmi Prasanna','Sri Ram','Chandra Mouli','Sravan','Pranavi','Others']}
                      placeholder="Select project manager..."
                    />
                  </div>
                  {projectManagerError && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <AlertCircle size={13} className="text-red-500 flex-shrink-0" />
                      <p className="text-[12px] text-red-600 font-medium">Project Manager is required</p>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Dynamic custom fields */}
            {createIssueFields.length > 0 && (
              <>
                <hr className="my-4 border-gray-100" />
                {createIssueFields.map((cf: any) => {
                  const cfHasErr = Boolean(customFieldErrors[cf.id]);
                  const setCfValue = (v: string) => {
                    setCustomFieldValues(p => ({ ...p, [cf.id]: v }));
                    if (v.trim()) setCustomFieldErrors(p => { const n = { ...p }; delete n[cf.id]; return n; });
                  };
                  const cfInputClass = (base: string) => cn(base, cfHasErr ? 'border-red-400 focus:ring-red-400' : 'border-gray-300 focus:ring-blue-500');
                  return (
                  <div key={cf.id} className="mb-4">
                    <label className="block text-[13px] font-semibold text-gray-700 mb-1.5">
                      {cf.name} {cf.required && <span className="text-red-500">*</span>}
                    </label>
                    {(cf.fieldType === 'select' || cf.fieldType === 'select-multi' || cf.fieldType === 'Select List (single choice)' || cf.fieldType === 'Select List (multiple choices)') && Array.isArray(cf.options) && cf.options.length > 0 ? (
                      <div className="relative">
                        <select
                          value={customFieldValues[cf.id] || ''}
                          onChange={e => setCfValue(e.target.value)}
                          className={cfInputClass("w-full px-3 pr-8 py-2 bg-white border rounded-lg text-[13px] appearance-none focus:outline-none focus:ring-2")}
                        >
                          <option value="">Select…</option>
                          {cf.options.map((o: string) => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      </div>
                    ) : cf.fieldType === 'date' ? (
                      <input type="date" value={customFieldValues[cf.id] || ''}
                        onChange={e => setCfValue(e.target.value)}
                        className={cfInputClass("w-full px-3 py-2 border rounded-lg text-[13px] focus:outline-none focus:ring-2")} />
                    ) : cf.fieldType === 'number' ? (
                      <input type="number" value={customFieldValues[cf.id] || ''}
                        onChange={e => setCfValue(e.target.value)}
                        className={cfInputClass("w-full px-3 py-2 border rounded-lg text-[13px] focus:outline-none focus:ring-2")} />
                    ) : (cf.type === 'User' || cf.fieldType === 'user') ? (
                      <div className="relative">
                        <select
                          value={customFieldValues[cf.id] || ''}
                          onChange={e => setCfValue(e.target.value)}
                          className={cfInputClass("w-full px-3 pr-8 py-2 bg-white border rounded-lg text-[13px] appearance-none focus:outline-none focus:ring-2")}
                        >
                          <option value="">Select user…</option>
                          {spaceMembers.map(m => (
                            <option key={m.id} value={`${m.firstName} ${m.lastName}`}>{m.firstName} {m.lastName}</option>
                          ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      </div>
                    ) : (
                      <input type="text" value={customFieldValues[cf.id] || ''}
                        onChange={e => setCfValue(e.target.value)}
                        className={cfInputClass("w-full px-3 py-2 border rounded-lg text-[13px] focus:outline-none focus:ring-2")}
                        placeholder={`Enter ${cf.name.toLowerCase()}…`} />
                    )}
                    {cfHasErr && <p className="mt-1 text-[12px] text-red-600 font-medium">{cf.name} is required</p>}
                  </div>
                  );
                })}
              </>
            )}
          </div>

          {/* Right panel — metadata */}
          <div className="w-[280px] flex-shrink-0 overflow-y-auto px-5 py-5 bg-gray-50/50">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-4">Details</p>

            {/* Space */}
            <div className="mb-4">
              <label className="block text-[12px] font-semibold text-gray-500 mb-1">
                Space <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                {currentSpace && (
                  <div className="absolute left-2.5 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
                    <div className="w-4 h-4 rounded flex items-center justify-center bg-blue-600">
                      <SpaceIcon icon={currentSpace.icon} spaceKey={currentSpace.key} size="sm" />
                    </div>
                  </div>
                )}
                <select
                  value={selectedSpaceKey}
                  onChange={e => setSelectedSpaceKey(e.target.value)}
                  className="w-full pl-8 pr-7 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] appearance-none cursor-pointer hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {spaces.map(s => (
                    <option key={s.key} value={s.key}>{s.name}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>


            {/* Work type */}
            <div className="mb-4">
              <label className="block text-[12px] font-semibold text-gray-500 mb-1">
                Work type <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <div className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                  <IssueTypeIcon type={form.type || 'task'} size={13} />
                </div>
                <select
                  value={form.type}
                  onChange={e => update('type', e.target.value)}
                  className="w-full pl-8 pr-7 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] appearance-none cursor-pointer hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {WORK_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {/* Status */}
            <div className="mb-4">
              <label className="block text-[12px] font-semibold text-gray-500 mb-1">Status</label>
              <div className="relative">
                <select
                  value={form.statusId}
                  onChange={e => update('statusId', e.target.value)}
                  className="w-full px-3 pr-7 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] appearance-none cursor-pointer hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {sortedStatuses.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {/* Queue — which department/queue this ticket lands in */}
            {queueOptions.length > 0 && (
              <div className="mb-4">
                <label className="block text-[12px] font-semibold text-gray-500 mb-1">
                  Queue <span className="text-red-500">*</span>
                </label>
                <DeptDropdown
                  value={form.department}
                  onChange={v => update('department', v)}
                  options={queueOptions}
                  error={queueError}
                />
                {queueError && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <AlertCircle size={13} className="text-red-500 flex-shrink-0" />
                    <p className="text-[12px] text-red-600 font-medium">Queue is required</p>
                  </div>
                )}
              </div>
            )}

            {/* Priority */}
            <div className="mb-4">
              <label className="block text-[12px] font-semibold text-gray-500 mb-1">Priority</label>
              <PriorityDropdown value={form.priority} onChange={v => update('priority', v)} />
            </div>

            {/* Assignee */}
            <div className="mb-4">
              <label className="block text-[12px] font-semibold text-gray-500 mb-1">Assignee</label>
              <div className="relative">
                {selectedAssignee && (
                  <div className="absolute left-2.5 top-1/2 -translate-y-1/2">
                    <div className="w-4 h-4 rounded-full bg-purple-600 flex items-center justify-center text-white text-[7px] font-bold">
                      {getInitials(selectedAssignee.firstName, selectedAssignee.lastName)}
                    </div>
                  </div>
                )}
                <select
                  value={form.assigneeId}
                  onChange={e => update('assigneeId', e.target.value)}
                  className={`w-full ${selectedAssignee ? 'pl-8' : 'pl-3'} pr-7 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] appearance-none cursor-pointer hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500`}
                >
                  <option value="">Unassigned</option>
                  {user && assigneeOptions.some(m => m.id === user.id) && <option value={user.id}>Assign to me</option>}
                  {assigneeOptions.map(m => (
                    <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {/* Reporter */}
            <div className="mb-4">
              <label className="block text-[12px] font-semibold text-gray-500 mb-1">Reporter</label>
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg">
                <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white text-[8px] font-bold flex-shrink-0">
                  {getInitials(user?.firstName, user?.lastName)}
                </div>
                <span className="text-[12px] text-gray-700 truncate">{user?.firstName} {user?.lastName}</span>
              </div>
            </div>

            <hr className="my-3 border-gray-200" />

            <div className="mb-4">
              <label className="block text-[12px] font-semibold text-gray-500 mb-1">Due Date</label>
              <input
                type="date"
                value={form.dueDate}
                onChange={e => update('dueDate', e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-end px-6 py-3.5 border-t border-gray-200 bg-white rounded-b-xl">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 text-[13px] font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading || uploading}
              title={uploading ? 'Waiting for attachments to finish uploading…' : undefined}
              className="px-6 py-1.5 text-[13px] font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Creating…' : uploading ? 'Uploading…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
