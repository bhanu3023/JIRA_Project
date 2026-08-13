'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { getDeptColor } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  error?: boolean;
}

export default function DeptDropdown({ value, onChange, options, placeholder = 'Select queue...', error }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className={`relative ${error ? 'ring-2 ring-red-300 rounded-lg' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 bg-white border rounded-lg text-[12px] hover:bg-gray-50 transition-colors focus:outline-none
          ${open ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-200'}`}
      >
        {value ? (
          <>
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: getDeptColor(value) }} />
            <span className="flex-1 text-left text-gray-800">{value}</span>
          </>
        ) : (
          <span className="flex-1 text-left text-gray-400">{placeholder}</span>
        )}
        <ChevronDown size={12} className="text-gray-400 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 max-h-64 overflow-y-auto">
          {options.map(name => (
            <button
              key={name}
              type="button"
              onClick={() => { onChange(name); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-gray-50 transition-colors ${name === value ? 'text-blue-600 font-medium bg-blue-50/40' : 'text-gray-700'}`}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: getDeptColor(name) }} />
              <span className="flex-1 text-left">{name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
