'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderPlus, Plus, Search, X, Trash2, Pencil, FileText, Lock } from 'lucide-react';
import { api, TestRepoFolder, TestCase, TestCaseSummary, TestStep, TestCaseAttachment } from '@/lib/api';
import { useStore } from '@/store';

// Deleting a test/folder/attachment is restricted to admins + Bhuvana Mosra
// specifically -- by explicit request, every other QA queue member can use
// Test Repository (the page itself is already gated to that queue + admins
// via the sidebar link and the backend's own 403) but not delete from it.
// The backend re-enforces this on every DELETE route regardless of what
// this hides -- see test-repo-api.ts's own canDeleteTestRepoContent.
const TEST_REPO_DELETE_ALLOWED_USER_ID = 'pg_0p2l8gvjod';
function useCanDeleteTestRepo(): boolean {
  const user = useStore((s) => s.user);
  return user?.role === 'admin' || user?.id === TEST_REPO_DELETE_ALLOWED_USER_ID;
}

type TreeNode = TestRepoFolder & { children: TreeNode[] };

function buildTree(folders: TestRepoFolder[]): TreeNode {
  const byPath = new Map<string, TreeNode>();
  for (const f of folders) byPath.set(f.path, { ...f, children: [] });
  const root = byPath.get('/')!;
  for (const f of folders) {
    if (f.path === '/') continue;
    const node = byPath.get(f.path)!;
    const parent = byPath.get(f.parentPath) || root;
    parent.children.push(node);
  }
  const sortRec = (n: TreeNode) => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sortRec); };
  sortRec(root);
  return root;
}

function FolderRow({ node, depth, index, selectedPath, onSelect, onDelete }: {
  node: TreeNode; depth: number; index: number; selectedPath: string; onSelect: (p: string) => void; onDelete: (n: TreeNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const active = node.path === selectedPath;
  const canDelete = useCanDeleteTestRepo();
  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] cursor-pointer ${active ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => onSelect(node.path)}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          className={`flex h-4 w-4 flex-shrink-0 items-center justify-center text-gray-400 ${hasChildren ? '' : 'invisible'}`}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <Folder size={14} className="flex-shrink-0 text-gray-400" />
        {node.path !== '/' && <span className="flex-shrink-0 text-[11px] text-gray-400">{index}.</span>}
        <span className="flex-1 truncate">{node.name}</span>
        <span className="text-[11px] text-gray-400">({node.testsCount})</span>
        {node.path !== '/' && canDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(node); }}
            className="hidden group-hover:flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500"
            title="Delete folder"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((c, i) => (
            <FolderRow key={c.path} node={c} depth={depth + 1} index={i + 1} selectedPath={selectedPath} onSelect={onSelect} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

function statusBadgeColor(status: string) {
  const s = status.toLowerCase();
  if (s.includes('done') || s.includes('pass')) return 'bg-emerald-100 text-emerald-700';
  if (s.includes('progress') || s.includes('fail')) return 'bg-amber-100 text-amber-700';
  return 'bg-gray-100 text-gray-600';
}

function emptyStep(n: number): TestStep { return { stepNumber: n, action: '', expectedResult: '' }; }

// Shared between the Edit modal's per-step card and the view-only Steps
// table -- same upload/delete/paste controls either place. Always shows a
// count (including "0 files") instead of a step with attachments looking
// identical to one with none, and an image attachment renders as an actual
// thumbnail instead of just a filename link -- a non-image (PDF/Excel/etc.)
// still gets a filename link with a generic file icon in its place.
function StepAttachments({
  attachments, stepNumber, uploading, canUpload, showUploadControls = true, disabledReason, onUpload, onDelete,
}: {
  attachments: TestCaseAttachment[];
  stepNumber: number;
  uploading: boolean;
  canUpload: boolean;
  // The view-only Test Details screen shows attachments but never lets you
  // add one there -- uploading only happens from the Edit modal, by
  // explicit request. false hides the whole Add file/Add folder/paste
  // section (not just disables it); the attachments themselves and the
  // count still render either way.
  showUploadControls?: boolean;
  disabledReason?: string;
  onUpload: (stepNumber: number, files: FileList | null) => void;
  onDelete: (attachmentId: string) => void;
}) {
  // Anyone with Test Repository access can still ADD an attachment --
  // deleting one is the part restricted to admins + Bhuvana, same as
  // deleting a whole test or folder (see this file's own comment on
  // useCanDeleteTestRepo).
  const canDelete = useCanDeleteTestRepo();
  // Lets someone who just copied a screenshot (e.g. Win+Shift+S / a browser
  // screenshot tool) click this box and Ctrl+V it straight in, instead of
  // having to save it to disk first just to use "+ Add file".
  const handlePasteImage = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items || !items.length) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const file = items[i].kind === 'file' ? items[i].getAsFile() : null;
      if (file) files.push(file);
    }
    if (!files.length) return;
    e.preventDefault();
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    onUpload(stepNumber, dt.files);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10.5px] font-semibold text-gray-400">
        {attachments.length} {attachments.length === 1 ? 'file' : 'files'}
      </span>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) => {
            const isImage = (a.mimeType || '').startsWith('image/');
            return (
              <div key={a.id} className="relative w-[76px] rounded-md border border-gray-200 bg-gray-50 p-1.5">
                {canDelete && (
                  <button
                    onClick={() => onDelete(a.id)}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-400 hover:border-red-300 hover:text-red-500"
                    title="Remove attachment"
                  >
                    <X size={9} />
                  </button>
                )}
                <a href={a.url} target="_blank" rel="noreferrer" className="block">
                  {isImage ? (
                    <img src={a.url} alt={a.filename} className="h-14 w-14 rounded border border-gray-200 bg-white object-cover" />
                  ) : (
                    <span className="flex h-14 w-14 items-center justify-center rounded border border-gray-200 bg-white text-gray-400">
                      <FileText size={20} />
                    </span>
                  )}
                </a>
                <a href={a.url} target="_blank" rel="noreferrer" title={a.filename} className="mt-1 block truncate text-[10px] leading-tight text-blue-600 hover:underline">
                  {a.filename}
                </a>
              </div>
            );
          })}
        </div>
      )}
      {showUploadControls && (canUpload ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer whitespace-nowrap text-[11.5px] font-medium text-blue-600 hover:underline">
            {uploading ? 'Uploading…' : '+ Add file'}
            <input type="file" multiple className="hidden" disabled={uploading} onChange={(e) => onUpload(stepNumber, e.target.files)} />
          </label>
          <label className="cursor-pointer whitespace-nowrap text-[11.5px] font-medium text-blue-600 hover:underline">
            + Add folder
            <input
              type="file"
              multiple
              className="hidden"
              disabled={uploading}
              onChange={(e) => onUpload(stepNumber, e.target.files)}
              {...({ webkitdirectory: '' } as any)}
            />
          </label>
          <div
            tabIndex={0}
            onPaste={handlePasteImage}
            title="Click here, then press Ctrl+V to paste a copied image"
            className="cursor-text whitespace-nowrap rounded border border-dashed border-gray-300 px-2 py-0.5 text-[10.5px] text-gray-400 outline-none focus:border-blue-400 focus:text-blue-600"
          >
            Click + paste image
          </div>
        </div>
      ) : (
        <p className="text-[11px] italic text-gray-400">{disabledReason || 'Save the test first to attach files.'}</p>
      ))}
    </div>
  );
}

function TestEditor({ spaceKey, folderPath, test, onClose, onSaved }: {
  spaceKey: string; folderPath: string; test: TestCase | null; onClose: () => void; onSaved: () => void;
}) {
  const [summary, setSummary] = useState(test?.summary || '');
  const [description, setDescription] = useState(test?.description || '');
  const [testType, setTestType] = useState<'Manual' | 'Automated'>(test?.testType || 'Manual');
  const [status, setStatus] = useState(test?.status || 'To Do');
  const [steps, setSteps] = useState<TestStep[]>(test?.steps?.length ? test.steps : [emptyStep(1)]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Attachments can only be uploaded against a step of a test that already
  // exists (the upload endpoint needs a real testCaseId) -- so this stays
  // empty, with upload disabled, for a brand-new unsaved test.
  const [attachments, setAttachments] = useState<TestCaseAttachment[]>(test?.attachments || []);
  const [uploadingStep, setUploadingStep] = useState<number | null>(null);
  const refreshAttachments = () => {
    if (!test) return;
    api.getTestCase(test.id).then((t) => setAttachments(t.attachments || [])).catch(() => {});
  };
  const uploadFiles = async (stepNumber: number, files: FileList | null) => {
    if (!test || !files || !files.length) return;
    setUploadingStep(stepNumber);
    try {
      for (const file of Array.from(files)) {
        await api.uploadTestStepAttachment(test.id, stepNumber, file);
      }
      refreshAttachments();
    } catch (e: any) {
      alert(e?.message || 'Upload failed');
    } finally {
      setUploadingStep(null);
    }
  };
  const deleteAttachment = async (attachmentId: string) => {
    await api.deleteTestCaseAttachment(attachmentId);
    refreshAttachments();
  };

  const updateStep = (i: number, patch: Partial<TestStep>) => {
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  };
  const addStep = () => setSteps((s) => [...s, emptyStep(s.length + 1)]);
  const removeStep = (i: number) => setSteps((s) => s.filter((_, idx) => idx !== i).map((st, idx) => ({ ...st, stepNumber: idx + 1 })));

  const save = async () => {
    if (!summary.trim()) { setError('Summary is required'); return; }
    setSaving(true);
    setError(null);
    try {
      if (test) {
        await api.updateTestCase(test.id, { summary, description, testType, status, steps });
      } else {
        await api.createTestCase({ spaceKey, summary, folderPath, testType, status, description, steps });
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 className="text-[15px] font-semibold text-gray-800">{test ? 'Edit Test' : 'New Test'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</div>}
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-gray-500">Summary *</label>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What is this test verifying?"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-gray-500">Type</label>
              <select value={testType} onChange={(e) => setTestType(e.target.value as any)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px]">
                <option value="Manual">Manual</option>
                <option value="Automated">Automated</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-gray-500">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px]">
                <option>To Do</option>
                <option>Pass</option>
                <option>Fail</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-gray-500">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-[12px] font-semibold text-gray-500">Steps</label>
              <button onClick={addStep} className="text-[12px] font-medium text-blue-600 hover:text-blue-700">+ Add step</button>
            </div>
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={i} className="rounded-lg border border-gray-200 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-gray-400">STEP {i + 1}</span>
                    {steps.length > 1 && (
                      <button onClick={() => removeStep(i)} className="text-gray-300 hover:text-red-500"><Trash2 size={12} /></button>
                    )}
                  </div>
                  <label className="mb-0.5 block text-[10.5px] font-semibold text-gray-400">Action</label>
                  <textarea
                    value={s.action || ''}
                    onChange={(e) => updateStep(i, { action: e.target.value })}
                    placeholder="Action"
                    rows={2}
                    className="mb-1.5 w-full rounded border border-gray-200 px-2 py-1 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <label className="mb-0.5 block text-[10.5px] font-semibold text-gray-400">Data</label>
                  <textarea
                    value={s.data || ''}
                    onChange={(e) => updateStep(i, { data: e.target.value })}
                    placeholder="Data"
                    rows={2}
                    className="mb-1.5 w-full rounded border border-gray-200 px-2 py-1 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <label className="mb-0.5 block text-[10.5px] font-semibold text-gray-400">Test steps</label>
                  <textarea
                    value={s.testSteps || ''}
                    onChange={(e) => updateStep(i, { testSteps: e.target.value })}
                    placeholder="Test steps"
                    rows={3}
                    className="mb-1.5 w-full rounded border border-gray-200 px-2 py-1 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <label className="mb-0.5 block text-[10.5px] font-semibold text-gray-400">Expected result</label>
                  <textarea
                    value={s.expectedResult || s.result || ''}
                    onChange={(e) => updateStep(i, { expectedResult: e.target.value })}
                    placeholder="Expected result"
                    rows={2}
                    className="mb-1.5 w-full rounded border border-gray-200 px-2 py-1 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <label className="mb-0.5 block text-[10.5px] font-semibold text-gray-400">Comment</label>
                  <textarea
                    value={s.comment || ''}
                    onChange={(e) => updateStep(i, { comment: e.target.value })}
                    placeholder="Comment (optional)"
                    rows={1}
                    className="mb-1.5 w-full rounded border border-gray-200 px-2 py-1 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <label className="mb-0.5 block text-[10.5px] font-semibold text-gray-400">Attachments</label>
                  <StepAttachments
                    attachments={attachments.filter((a) => a.stepNumber === (s.stepNumber ?? i + 1))}
                    stepNumber={s.stepNumber ?? i + 1}
                    uploading={uploadingStep === (s.stepNumber ?? i + 1)}
                    canUpload={!!test}
                    onUpload={uploadFiles}
                    onDelete={deleteAttachment}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3.5 py-1.5 text-[13px] font-medium text-gray-600 hover:bg-gray-100">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// "/BACS data dump/Workdocs to NFS" -> ["Test Repository", "BACS data dump", "Workdocs to NFS"]
function breadcrumbFor(folderPath: string): string[] {
  const parts = (folderPath || '/').split('/').filter(Boolean);
  return ['Test Repository', ...parts];
}

function TestDetail({ testId, onClose, onEdit, onDeleted }: { testId: string; onClose: () => void; onEdit: (t: TestCase) => void; onDeleted: () => void }) {
  const [test, setTest] = useState<TestCase | null>(null);
  const [loading, setLoading] = useState(true);
  const canDelete = useCanDeleteTestRepo();

  useEffect(() => {
    let stale = false;
    api.getTestCase(testId).then((t) => { if (!stale) { setTest(t); setLoading(false); } }).catch(() => setLoading(false));
    return () => { stale = true; };
  }, [testId]);

  const [uploadingStep, setUploadingStep] = useState<number | null>(null);

  const del = async () => {
    if (!confirm('Delete this test case? This cannot be undone.')) return;
    await api.deleteTestCase(testId);
    onDeleted();
  };

  const refresh = () => { api.getTestCase(testId).then(setTest).catch(() => {}); };

  const uploadFiles = async (stepNumber: number, files: FileList | null) => {
    if (!files || !files.length) return;
    setUploadingStep(stepNumber);
    try {
      for (const file of Array.from(files)) {
        await api.uploadTestStepAttachment(testId, stepNumber, file);
      }
      refresh();
    } catch (e: any) {
      alert(e?.message || 'Upload failed');
    } finally {
      setUploadingStep(null);
    }
  };

  const deleteAttachment = async (attachmentId: string) => {
    await api.deleteTestCaseAttachment(attachmentId);
    refresh();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-semibold text-gray-800">{test?.summary || 'Test Details'}</h2>
            {test && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10.5px] font-semibold text-indigo-700">{test.testType}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${statusBadgeColor(test.status)}`}>{test.status}</span>
              </div>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            {test && (
              <>
                <button onClick={() => onEdit(test)} className="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-100"><Pencil size={14} /></button>
                {canDelete && (
                  <button onClick={del} className="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-red-50 hover:text-red-500"><Trash2 size={14} /></button>
                )}
              </>
            )}
            <button onClick={onClose} className="ml-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">
          {loading ? (
            <div className="py-10 text-center text-[13px] text-gray-400">Loading…</div>
          ) : !test ? (
            <div className="py-10 text-center text-[13px] text-gray-400">Not found</div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-1 text-[12px] text-gray-400">
                {breadcrumbFor(test.folderPath).map((crumb, i, arr) => (
                  <span key={i} className="flex items-center gap-1">
                    <span className={i === arr.length - 1 ? 'font-medium text-gray-600' : ''}>{crumb}</span>
                    {i < arr.length - 1 && <ChevronRight size={11} />}
                  </span>
                ))}
              </div>
              {test.description && <p className="text-[13px] text-gray-600 whitespace-pre-wrap">{test.description}</p>}
              {test.steps?.length > 0 && (
                <div>
                  <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-gray-500">Test Details — Steps</p>
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full text-left text-[12.5px]">
                      <thead className="bg-gray-50 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        <tr>
                          <th className="px-3 py-2 w-10">#</th>
                          <th className="px-3 py-2">Action</th>
                          <th className="px-3 py-2">Data</th>
                          <th className="px-3 py-2">Test steps</th>
                          <th className="px-3 py-2">Expected result</th>
                          <th className="px-3 py-2">Comments</th>
                          <th className="px-3 py-2 min-w-[200px]">Attachments</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {test.steps.map((s, i) => {
                          const stepNum = s.stepNumber ?? i + 1;
                          const stepAttachments = (test.attachments || []).filter((a) => a.stepNumber === stepNum);
                          return (
                            <tr key={i} className="align-top">
                              <td className="px-3 py-2.5 text-gray-400">{stepNum}</td>
                              <td className="px-3 py-2.5 whitespace-pre-wrap text-gray-700">{s.action || '—'}</td>
                              <td className="px-3 py-2.5 whitespace-pre-wrap text-gray-700">{s.data || '—'}</td>
                              <td className="px-3 py-2.5 whitespace-pre-wrap text-gray-700">{s.testSteps || '—'}</td>
                              <td className="px-3 py-2.5 whitespace-pre-wrap text-gray-700">{s.expectedResult || s.result || '—'}</td>
                              <td className="px-3 py-2.5 whitespace-pre-wrap text-gray-700">{s.comment || <span className="text-gray-300">None</span>}</td>
                              <td className="px-3 py-2.5">
                                <StepAttachments
                                  attachments={stepAttachments}
                                  stepNumber={stepNum}
                                  uploading={uploadingStep === stepNum}
                                  canUpload
                                  showUploadControls={false}
                                  onUpload={uploadFiles}
                                  onDelete={deleteAttachment}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TestRepositoryPage() {
  const user = useStore((s) => s.user);
  // Backend-enforced (every test-repository/* route 403s a non-member) --
  // this is just so a non-QA/non-admin user who navigates here directly
  // sees a clear message instead of an empty/broken page full of silently
  // failed requests.
  const canAccessTestRepo = user?.role === 'admin' || !!(user as any)?.canAccessTestRepo;
  const [spaces, setSpaces] = useState<{ id: string; key: string; name: string }[]>([]);
  const [spaceKey, setSpaceKey] = useState('TESTIN');
  const [folders, setFolders] = useState<TestRepoFolder[]>([]);
  const [selectedPath, setSelectedPath] = useState('/');
  const [tests, setTests] = useState<TestCaseSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [loadingTests, setLoadingTests] = useState(true);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTest, setEditingTest] = useState<TestCase | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const limit = 50;

  useEffect(() => { api.getSpaces().then(setSpaces).catch(() => setSpaces([])); }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const reloadFolders = () => { api.getTestRepoFolders(spaceKey).then(setFolders).catch(() => setFolders([])); };
  useEffect(() => { reloadFolders(); }, [spaceKey]);

  const reloadTests = () => {
    setLoadingTests(true);
    // Search respects whichever folder is selected (and its subfolders, same
    // as the plain folder view) -- searching no longer ignores the selected
    // folder and hit the whole repository regardless. Root ('/') already
    // means "no folder filter" server-side, so searching from the top level
    // still searches everything, which is the one case that should.
    api.listTestCases(spaceKey, { folderPath: selectedPath, q: debounced || undefined, page, limit })
      .then((r) => { setTests(r.tests); setTotal(r.total); })
      .catch(() => { setTests([]); setTotal(0); })
      .finally(() => setLoadingTests(false));
  };
  useEffect(() => { reloadTests(); }, [spaceKey, selectedPath, debounced, page]);
  useEffect(() => { setPage(1); }, [selectedPath, debounced]);

  const tree = useMemo(() => buildTree(folders.length ? folders : [{ id: 'root', name: 'Test Repository', path: '/', parentPath: '', testsCount: 0 }]), [folders]);
  const currentFolder = folders.find((f) => f.path === selectedPath);

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    await api.createTestRepoFolder({ spaceKey, name, parentPath: selectedPath });
    setNewFolderName('');
    setNewFolderOpen(false);
    reloadFolders();
  };

  const deleteFolder = async (node: TreeNode) => {
    if (!confirm(`Delete folder "${node.name}"? It must be empty.`)) return;
    try {
      await api.deleteTestRepoFolder(node.id);
      if (selectedPath === node.path) setSelectedPath(node.parentPath || '/');
      reloadFolders();
    } catch (e: any) {
      alert(e?.message || 'Failed to delete folder');
    }
  };

  if (!canAccessTestRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white px-8 text-center">
        <Lock size={28} className="text-gray-300" />
        <p className="text-[14px] font-medium text-gray-700">Test Repository is only available to the QA queue and admins.</p>
        <p className="text-[12.5px] text-gray-400">Ask an admin if you believe you should have access.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-8 py-4">
        <div>
          <h1 className="text-[20px] font-semibold text-gray-800">Test Repository</h1>
          <p className="text-[13px] text-gray-500">Manual and automated test cases, organized by folder.</p>
        </div>
        <select
          value={spaceKey}
          onChange={(e) => { setSpaceKey(e.target.value); setSelectedPath('/'); }}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-[13px]"
        >
          {spaces.length ? spaces.map((s) => <option key={s.key} value={s.key}>{s.name}</option>) : <option value={spaceKey}>{spaceKey}</option>}
        </select>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Folder tree */}
        <div className="flex w-72 flex-shrink-0 flex-col border-r border-gray-200 bg-gray-50/50">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Folders</span>
            <button onClick={() => setNewFolderOpen(true)} className="flex items-center gap-1 text-[11.5px] font-medium text-blue-600 hover:text-blue-700">
              <FolderPlus size={13} /> New
            </button>
          </div>
          {newFolderOpen && (
            <div className="mx-2 mb-2 flex items-center gap-1 rounded-lg border border-blue-200 bg-white p-1.5">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setNewFolderOpen(false); }}
                placeholder="Folder name"
                className="flex-1 border-none px-1 text-[12.5px] focus:outline-none"
              />
              <button onClick={createFolder} className="text-[11.5px] font-medium text-blue-600">Add</button>
            </div>
          )}
          <div className="flex-1 overflow-y-auto px-2 pb-3">
            <FolderRow node={tree} depth={0} index={1} selectedPath={selectedPath} onSelect={setSelectedPath} onDelete={deleteFolder} />
          </div>
        </div>

        {/* Test list */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-shrink-0 items-center gap-3 border-b border-gray-200 px-6 py-3">
            <div className="relative flex-1 max-w-sm">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search tests in ${currentFolder?.name || 'this folder'}...`}
                className="w-full rounded-lg border border-gray-300 py-1.5 pl-8 pr-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <span className="text-[12.5px] text-gray-400">
              Total Tests: {total}{selectedPath !== '/' && !debounced && ' (includes subfolders)'}
            </span>
            <button
              onClick={() => { setEditingTest(null); setEditorOpen(true); }}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700"
            >
              <Plus size={15} /> New Test
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {loadingTests ? (
              <div className="flex h-40 items-center justify-center"><div className="h-7 w-7 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>
            ) : tests.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 py-16 text-center">
                <FileText size={28} className="mb-2 text-gray-300" />
                <p className="text-[14px] font-medium text-gray-700">No tests here yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {tests.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setDetailId(t.id)}
                    className="w-full rounded-xl border border-gray-200 px-4 py-3 text-left transition-shadow hover:border-blue-300 hover:shadow-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10.5px] font-semibold text-indigo-700">{t.testType}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${statusBadgeColor(t.status)}`}>{t.status}</span>
                      {t.jiraKey && <span className="text-[11px] text-gray-400">{t.jiraKey}</span>}
                    </div>
                    <p className="mt-1.5 text-[13.5px] font-medium text-gray-800">{t.summary}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {total > limit && (
            <div className="flex flex-shrink-0 items-center justify-center gap-3 border-t border-gray-200 px-6 py-2.5">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="text-[12.5px] font-medium text-blue-600 disabled:text-gray-300">Previous</button>
              <span className="text-[12px] text-gray-400">Page {page} of {Math.ceil(total / limit)}</span>
              <button disabled={page * limit >= total} onClick={() => setPage((p) => p + 1)} className="text-[12.5px] font-medium text-blue-600 disabled:text-gray-300">Next</button>
            </div>
          )}
        </div>
      </div>

      {editorOpen && (
        <TestEditor
          spaceKey={spaceKey}
          folderPath={selectedPath}
          test={editingTest}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); reloadTests(); reloadFolders(); }}
        />
      )}
      {detailId && (
        <TestDetail
          testId={detailId}
          onClose={() => setDetailId(null)}
          onEdit={(t) => { setDetailId(null); setEditingTest(t); setEditorOpen(true); }}
          onDeleted={() => { setDetailId(null); reloadTests(); reloadFolders(); }}
        />
      )}
    </div>
  );
}
