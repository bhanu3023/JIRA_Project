'use client';

import { useState, useRef, useEffect } from 'react';

// Same default quick-reaction set Jira's own comment reaction picker offers.
const QUICK_EMOJIS = ['👍', '👏', '🔥', '❤️', '😯', '🤔'];

export default function CommentReactions({
  reactions, currentUserId, onToggle, className = '',
}: {
  reactions: Record<string, string[]> | null | undefined;
  currentUserId?: string | null;
  onToggle: (emoji: string) => void;
  className?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setPickerOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [pickerOpen]);

  const entries = Object.entries(reactions || {}).filter(([, users]) => Array.isArray(users) && users.length > 0);

  return (
    <div ref={ref} className={`relative flex items-center gap-1 flex-wrap ${className}`}>
      {entries.map(([emoji, users]) => {
        const mine = !!currentUserId && users.includes(currentUserId);
        return (
          <button
            key={emoji}
            onClick={(e) => { e.stopPropagation(); onToggle(emoji); }}
            title={mine ? 'Remove your reaction' : 'React'}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[13px] border transition-colors ${
              mine ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
            }`}
          >
            <span className="text-[15px] leading-none">{emoji}</span>
            <span className="font-medium">{users.length}</span>
          </button>
        );
      })}
      {/* "+😊" hover trigger, matching Jira's own comment action row */}
      <button
        onClick={(e) => { e.stopPropagation(); setPickerOpen((v) => !v); }}
        title="Add reaction"
        className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-[18px] leading-none text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors ${entries.length === 0 ? 'opacity-0 group-hover/comment:opacity-100' : ''}`}
      >
        {entries.length === 0 ? '☺' : '+'}
      </button>
      {pickerOpen && (
        <div className="absolute bottom-full left-0 mb-1 z-20 flex items-center gap-1 bg-white border border-gray-200 rounded-full shadow-lg px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              onClick={(e) => { e.stopPropagation(); onToggle(emoji); setPickerOpen(false); }}
              className="text-[20px] hover:scale-125 transition-transform"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
