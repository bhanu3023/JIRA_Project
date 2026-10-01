'use client';

const PRIORITIES = [
  { value: 'highest', label: 'Highest', color: '#111827', bg: '#F9FAFB' },
  { value: 'high',    label: 'High',    color: '#111827', bg: '#F9FAFB' },
  { value: 'medium',  label: 'Medium',  color: '#111827', bg: '#F9FAFB' },
  { value: 'low',     label: 'Low',     color: '#111827', bg: '#F9FAFB' },
  { value: 'lowest',  label: 'Lowest',  color: '#111827', bg: '#F9FAFB' },
];

export function getPriorityMeta(value: string) {
  return PRIORITIES.find(p => p.value === value) || PRIORITIES[2];
}

// PRIORITIES itself stays the full fixed 5 -- every existing ticket that
// already has a since-disabled priority still needs to render its icon/
// label/color (badges, Filters, the ticket detail sidebar). This is only
// for the PICKERS (Create ticket, change Priority, subtask creation) that
// let someone choose a NEW value -- those should offer only what's
// currently enabled, per the global disabled-priorities setting.
export function getSelectablePriorities(disabled: string[] | undefined | null) {
  if (!disabled || !disabled.length) return PRIORITIES;
  return PRIORITIES.filter(p => !disabled.includes(p.value));
}

// Icon fill colors — kept visually distinct but NOT used for text/badge color
const ICON_COLORS: Record<string, string> = {
  highest: '#E11D48',
  high:    '#D97706',
  medium:  '#7C3AED',
  low:     '#0891B2',
  lowest:  '#64748B',
};

export function PriorityIcon({ priority, size = 16 }: { priority: string; size?: number }) {
  const s = size;
  const c = ICON_COLORS[priority] ?? '#64748B';

  // Highest — two solid filled upward arrows
  if (priority === 'highest') {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <path d="M8 2L13 7H3L8 2Z" fill={c} />
        <path d="M8 8L13 13H3L8 8Z" fill={c} fillOpacity="0.45" />
      </svg>
    );
  }

  // High — one solid filled upward arrow
  if (priority === 'high') {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <path d="M8 2L14 10H2L8 2Z" fill={c} />
      </svg>
    );
  }

  // Medium — two horizontal solid bars (equal)
  if (priority === 'medium') {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect x="2" y="4.5" width="12" height="2.5" rx="1.2" fill={c} />
        <rect x="2" y="9"   width="12" height="2.5" rx="1.2" fill={c} />
      </svg>
    );
  }

  // Low — one solid filled downward arrow
  if (priority === 'low') {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <path d="M8 14L2 6H14L8 14Z" fill={c} />
      </svg>
    );
  }

  // Lowest — two solid filled downward arrows
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M8 8L13 3H3L8 8Z"   fill={c} fillOpacity="0.45" />
      <path d="M8 14L13 9H3L8 14Z" fill={c} />
    </svg>
  );
}

export { PRIORITIES };
