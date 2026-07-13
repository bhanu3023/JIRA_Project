'use client';

import { useEffect, useState, Suspense, useCallback } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import {
  Plus, Users, FileText, ChevronRight, Check, X,
  Code2, Headphones, UserCircle2, Layers, Kanban,
  GitBranch, ArrowLeft, Search, Zap, TrendingUp
} from 'lucide-react';
import SpaceIcon from '@/components/ui/SpaceIcon';

const TEMPLATES = [
  {
    category: 'software', label: 'Software', icon: Code2,
    gradient: 'from-blue-500 to-indigo-600', bg: 'bg-blue-50', border: 'border-blue-200', textColor: 'text-blue-700',
    desc: 'Plan, track, and release software projects.',
    types: [
      { id: 'scrum', label: 'Scrum', icon: GitBranch, desc: 'Iterative sprints for agile teams.', features: ['Sprint planning', 'Backlog', 'Burndown charts', 'Story points'] },
      { id: 'kanban', label: 'Kanban', icon: Kanban, desc: 'Continuous delivery with WIP limits.', features: ['Kanban board', 'WIP limits', 'Cycle time', 'No sprints'] },
    ],
  },
  {
    category: 'service_management', label: 'Service Management', icon: Headphones,
    gradient: 'from-emerald-500 to-teal-600', bg: 'bg-emerald-50', border: 'border-emerald-200', textColor: 'text-emerald-700',
    desc: 'High-velocity ITSM for service teams.',
    types: [
      { id: 'service_desk', label: 'Service Desk', icon: Headphones, desc: 'Resolve customer requests faster.', features: ['Queues', 'SLAs', 'Customer portal', 'Automation'] },
      { id: 'dept_queue', label: 'Department Queue Board', icon: Layers, desc: 'Route tickets across departments with custom queues, SLAs and Sent/Watching view.', features: ['Dept routing', 'Custom queues', 'SLAs', 'Sent / Watching'] },
    ],
  },
  {
    category: 'hr', label: 'HR', icon: UserCircle2,
    gradient: 'from-violet-500 to-purple-600', bg: 'bg-violet-50', border: 'border-violet-200', textColor: 'text-violet-700',
    desc: 'Streamline HR operations and requests.',
    types: [
      { id: 'hr', label: 'HR Board', icon: UserCircle2, desc: 'Manage employee requests and onboarding.', features: ['Employee requests', 'Onboarding', 'Leave management', 'HR workflows'] },
    ],
  },
];

const toBackendType = (t: string) => t === 'hr' ? 'kanban' : t;

function CreateSpaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const createSpace = useStore((s) => s.createSpace);
  const [step, setStep] = useState<'category' | 'details'>('category');
  const [category, setCategory] = useState<typeof TEMPLATES[0] | null>(null);
  const [selectedType, setSelectedType] = useState('');
  const [form, setForm] = useState({ name: '', key: '', description: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCategorySelect = (cat: typeof TEMPLATES[0], typeId: string) => {
    setCategory(cat);
    setSelectedType(typeId);
    setStep('details');
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.key.trim()) return;
    setError(''); setLoading(true);
    try {
      await createSpace({ name: form.name, key: form.key, description: form.description, type: toBackendType(selectedType) });
      onCreated();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const selectedTypeDef = category?.types.find(t => t.id === selectedType);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden flex flex-col max-h-[88vh]">
        <div className="flex items-center justify-between px-7 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            {step === 'details' && (
              <button onClick={() => setStep('category')} className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600">
                <ArrowLeft size={15} />
              </button>
            )}
            <div>
              <h2 className="text-[15px] font-bold text-gray-900">Create a new space</h2>
              <p className="text-[11px] text-gray-400 mt-0.5">{step === 'category' ? 'Choose a template' : `${category?.label} — ${selectedTypeDef?.label}`}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-400">
            <X size={15} />
          </button>
        </div>

        {step === 'category' && (
          <div className="flex-1 overflow-y-auto p-7 space-y-3">
            {TEMPLATES.map(cat => {
              const Icon = cat.icon;
              return (
                <div key={cat.category} className={`rounded-2xl border ${cat.border} overflow-hidden`}>
                  <div className={`${cat.bg} px-5 py-3 flex items-center gap-3`}>
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${cat.gradient} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                      <Icon size={18} className="text-white" />
                    </div>
                    <div>
                      <p className="text-[13px] font-bold text-gray-800">{cat.label}</p>
                      <p className="text-[11px] text-gray-500">{cat.desc}</p>
                    </div>
                  </div>
                  <div className="bg-white divide-y divide-gray-50">
                    {cat.types.map(type => {
                      const TIcon = type.icon;
                      return (
                        <button key={type.id} onClick={() => handleCategorySelect(cat, type.id)}
                          className="w-full flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors text-left group">
                          <div className={`w-9 h-9 rounded-xl ${cat.bg} flex items-center justify-center flex-shrink-0`}>
                            <TIcon size={15} className="text-gray-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-bold text-gray-800">{type.label}</p>
                            <p className="text-[11px] text-gray-500 mt-0.5">{type.desc}</p>
                            <div className="flex flex-wrap gap-1 mt-2">
                              {type.features.map(f => (
                                <span key={f} className="inline-flex items-center gap-1 text-[10px] font-medium bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                                  <Check size={8} strokeWidth={3} className="text-emerald-500" /> {f}
                                </span>
                              ))}
                            </div>
                          </div>
                          <ChevronRight size={15} className="text-gray-300 group-hover:text-violet-500 flex-shrink-0 transition-colors" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {step === 'details' && category && selectedTypeDef && (
          <div className="flex flex-1 overflow-hidden">
            <div className={`w-52 flex-shrink-0 ${category.bg} border-r border-gray-100 p-6 space-y-4`}>
              <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${category.gradient} flex items-center justify-center shadow-md`}>
                <category.icon size={22} className="text-white" />
              </div>
              <div>
                <p className="text-[13px] font-bold text-gray-800">{selectedTypeDef.label}</p>
                <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">{selectedTypeDef.desc}</p>
              </div>
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Includes</p>
                {selectedTypeDef.features.map(f => (
                  <div key={f} className="flex items-center gap-1.5 text-[11px] text-gray-600">
                    <Check size={10} className="text-emerald-500 flex-shrink-0" strokeWidth={2.5} /> {f}
                  </div>
                ))}
              </div>
            </div>

            <form onSubmit={handleCreate} className="flex-1 p-7 space-y-5 overflow-y-auto">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-[13px]">{error}</div>}

              <div>
                <label className="block text-[12px] font-bold text-gray-700 mb-2 uppercase tracking-wider">Space name <span className="text-red-500">*</span></label>
                <input type="text" value={form.name} autoFocus required
                  onChange={e => setForm(f => ({ ...f, name: e.target.value, key: e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6) }))}
                  className="input-field" placeholder="e.g. Engineering, Support Team" />
              </div>

              <div>
                <label className="block text-[12px] font-bold text-gray-700 mb-2 uppercase tracking-wider">Key <span className="text-red-500">*</span></label>
                <input type="text" value={form.key} maxLength={10} required
                  onChange={e => setForm(f => ({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))}
                  className="input-field w-36 font-mono uppercase" placeholder="ENG" />
                <p className="text-[11px] text-gray-400 mt-1.5">Used as prefix, e.g. {form.key || 'ENG'}-1</p>
              </div>

              <div>
                <label className="block text-[12px] font-bold text-gray-700 mb-2 uppercase tracking-wider">Description <span className="text-gray-400 font-normal normal-case">(optional)</span></label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className="input-field" rows={3} placeholder="What is this space for?" />
              </div>

              {category.types.length > 1 && (
                <div>
                  <label className="block text-[12px] font-bold text-gray-700 mb-2 uppercase tracking-wider">Board type</label>
                  <div className="flex gap-2">
                    {category.types.map(t => {
                      const TIcon = t.icon;
                      return (
                        <button key={t.id} type="button" onClick={() => setSelectedType(t.id)}
                          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border text-[12px] font-semibold transition-all
                            ${selectedType === t.id ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                          <TIcon size={13} /> {t.label}
                          {selectedType === t.id && <Check size={11} className="text-violet-600" strokeWidth={3} />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                <button type="submit" disabled={loading || !form.name.trim() || !form.key.trim()} className="btn-primary flex items-center gap-2">
                  {loading ? 'Creating…' : <><Plus size={13} /> Create space</>}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function SpacesInner() {
  const { spaces, loadSpaces, user } = useStore(
    useShallow((s) => ({
      spaces: s.spaces,
      loadSpaces: s.loadSpaces,
      user: s.user,
    })),
  );
  const searchParams = useSearchParams();
  const [showCreate, setShowCreate] = useState(searchParams.get('create') === 'true');
  const [search, setSearch] = useState('');
  const [openCounts, setOpenCounts] = useState<Record<string, number>>({});

  useEffect(() => { loadSpaces(); }, [loadSpaces]);

  // Load open issue counts per space
  useEffect(() => {
    if (!spaces.length) return;
    spaces.forEach(sp => {
      api.getIssues({ spaceKey: sp.key, limit: '1', page: '1' } as any).then((data: any) => {
        setOpenCounts(prev => ({ ...prev, [sp.key]: data.total ?? 0 }));
      }).catch(() => {});
    });
  }, [spaces]);

  // Keys that are purely QA/Test boards (show as Scrum / Software group)
  const QA_KEYS = ['TESTBOARD'];

  const typeConfig = (type: string, spaceKey: string) => {
    if (QA_KEYS.includes(spaceKey?.toUpperCase())) {
      return { label: 'Scrum', color: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' };
    }
    // All other boards → Service Management
    return { label: 'Service Management', color: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' };
  };

  const filtered = spaces.filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.key.toLowerCase().includes(search.toLowerCase())
  );

  const grouped = {
    service: filtered.filter(s => !QA_KEYS.includes(s.key?.toUpperCase())),
    software: filtered.filter(s => QA_KEYS.includes(s.key?.toUpperCase())),
    other: [] as typeof filtered,
  };

  return (
    <div className="max-w-[1120px] mx-auto space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">All Spaces</h1>
          <p className="text-[13px] text-gray-500 mt-0.5">
            {spaces.length} space{spaces.length !== 1 ? 's' : ''}
            {Object.values(openCounts).length > 0 && (
              <> · <strong className="text-gray-700">{Object.values(openCounts).reduce((a,b)=>a+b,0).toLocaleString()}</strong> total issues</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search spaces..."
              className="pl-9 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-[13px] text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500 w-52 shadow-sm" />
          </div>
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
            <Plus size={14} /> New Space
          </button>
        </div>
      </div>

      {showCreate && <CreateSpaceModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); loadSpaces(); }} />}

      {filtered.length === 0 && spaces.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-violet-100 flex items-center justify-center mx-auto mb-5">
            <Layers size={28} className="text-violet-500" />
          </div>
          <h3 className="text-[15px] font-bold text-gray-900 mb-1">No spaces yet</h3>
          <p className="text-[13px] text-gray-400 mb-5">Create your first workspace to start tracking work.</p>
          <button onClick={() => setShowCreate(true)} className="btn-primary inline-flex items-center gap-2">
            <Plus size={14} /> Create Space
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries({ 'Service Management': grouped.service, 'Software': grouped.software, 'Other': grouped.other })
            .filter(([, list]) => list.length > 0)
            .map(([groupName, list]) => (
              <div key={groupName}>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">{groupName}</h2>
                  <span className="text-[11px] text-gray-400">({list.length})</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {list.map(space => {
                    const tc = typeConfig(space.type, space.key);
                    return (
                      <Link key={space.id} href={`/spaces/${space.key}`}
                        className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:border-violet-200 transition-all group p-5 flex flex-col">
                        <div className="flex items-start gap-3 mb-3">
                          <SpaceIcon icon={space.icon} spaceKey={space.key} spaceName={space.name} size="lg" />
                          <div className="flex-1 min-w-0">
                            <h3 className="text-[14px] font-bold text-gray-900 group-hover:text-violet-700 transition-colors truncate">{space.name}</h3>
                            <p className="text-[11px] text-gray-400 mt-0.5 font-mono">{space.key}</p>
                          </div>
                          <span className={`${tc.color} badge flex-shrink-0 text-[10px]`}>{tc.label}</span>
                        </div>

                        {space.description && (
                          <p className="text-[12px] text-gray-500 line-clamp-1 mb-3">{space.description}</p>
                        )}

                        <div className="mt-auto flex items-center justify-between pt-3 border-t border-gray-100">
                          <div className="flex items-center gap-4 text-[11px] text-gray-500">
                            <span className="flex items-center gap-1.5">
                              <FileText size={11} className="text-blue-400" />
                              <span><strong className="text-gray-800">{openCounts[space.key] ?? space.issueCount ?? 0}</strong> issues</span>
                            </span>
                            <span className="flex items-center gap-1.5">
                              <Users size={11} className="text-violet-400" />
                              <span><strong className="text-gray-800">{space.memberCount ?? 0}</strong> members</span>
                            </span>
                          </div>
                          <ChevronRight size={14} className="text-gray-300 group-hover:text-violet-400 transition-colors" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default function SpacesPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-[3px] border-violet-200 border-t-violet-600 rounded-full" />
      </div>
    }>
      <SpacesInner />
    </Suspense>
  );
}
