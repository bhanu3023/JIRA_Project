'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { PriorityIcon, getPriorityMeta, getSelectablePriorities } from './PriorityIcon';
import { useStore } from '@/store';

interface Props {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
}

export default function PriorityDropdown({ value, onChange, label, required }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const meta = getPriorityMeta(value);
  const disabledPriorities = useStore((s) => s.disabledPriorities);
  const selectable = getSelectablePriorities(disabledPriorities);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      {label && (
        <label className="block text-[13px] font-medium text-[#44546f] mb-1.5">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
      )}

      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 bg-white border rounded text-[14px] hover:bg-[#f7f8f9] transition-colors focus:outline-none
          ${open ? 'border-blue-500 ring-1 ring-blue-500' : 'border-[#dfe1e6] hover:border-[#c1c7d0]'}`}
      >
        <PriorityIcon priority={value} size={16} />
        <span className="flex-1 text-left text-[#172B4D] font-normal">{meta.label}</span>
        <ChevronDown size={14} className="text-[#44546f] flex-shrink-0" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-white rounded-md shadow-lg border border-[#dfe1e6] py-1 z-50 overflow-hidden">
          {selectable.filter(p => p.value !== value).map(p => (
            <button
              key={p.value}
              type="button"
              onClick={() => { onChange(p.value); setOpen(false); }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-[14px] text-[#172B4D] hover:bg-[#f7f8f9] transition-colors"
            >
              <PriorityIcon priority={p.value} size={16} />
              <span className="font-normal">{p.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
