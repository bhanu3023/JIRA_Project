'use client';

export const TYPE_META: Record<string, { color: string; bg: string; label: string }> = {
  epic:                 { color: '#6554C0', bg: '#6554C0', label: 'Epic'                 },
  story:                { color: '#36B37E', bg: '#36B37E', label: 'Story'                },
  task:                 { color: '#36B37E', bg: '#36B37E', label: 'Task'                 },
  bug:                  { color: '#FF5630', bg: '#FF5630', label: 'Bug'                  },
  subtask:              { color: '#0065FF', bg: '#0065FF', label: 'Sub-task'             },
  service_request:      { color: '#00B8D9', bg: '#00B8D9', label: 'Service Request'      },
  incident:             { color: '#FF7452', bg: '#FF7452', label: 'Incident'             },
  // Pre-Sales-Team's own work types -- each used to fall through to the
  // generic blue-checkmark icon (TypeSVG's default case), so all five
  // looked identical in the type dropdown with no way to tell them apart
  // at a glance.
  demo:                 { color: '#00A3BF', bg: '#00A3BF', label: 'Demo'                 },
  poc:                  { color: '#8777D9', bg: '#8777D9', label: 'POC'                  },
  technical_discussion: { color: '#2684FF', bg: '#2684FF', label: 'Technical Discussion' },
  security_assessment:  { color: '#DE350B', bg: '#DE350B', label: 'Security assessment'  },
  technical_assistance: { color: '#57D9A3', bg: '#57D9A3', label: 'Technical assistance' },
};

/** Jira-style SVG icon — returns the inner <path/><circle/> etc. elements */
function TypeSVG({ type, size }: { type: string; size: number }) {
  const s = size;
  const t = type?.toLowerCase();

  if (t === 'epic') {
    // Lightning bolt
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#6554C0"/>
        <path d="M9.5 2.5L4.5 9H7.5L6.5 13.5L11.5 7H8.5L9.5 2.5Z" fill="white"/>
      </svg>
    );
  }

  if (t === 'story') {
    // Bookmark shape
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#36B37E"/>
        <path d="M4 3.5H12V13L8 10.5L4 13V3.5Z" fill="white"/>
      </svg>
    );
  }

  if (t === 'task') {
    // Checkmark in circle — green
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#36B37E"/>
        <circle cx="8" cy="8" r="4.5" stroke="white" strokeWidth="1.4" fill="none"/>
        <path d="M5.5 8L7 9.5L10.5 6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }

  if (t === 'bug') {
    // Bug / circle with legs
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#FF5630"/>
        <circle cx="8" cy="8.5" r="3" fill="white"/>
        <path d="M6.5 5.5C6.5 4.67 7.17 4 8 4C8.83 4 9.5 4.67 9.5 5.5" stroke="white" strokeWidth="1.3" fill="none" strokeLinecap="round"/>
        <line x1="5" y1="7.5" x2="3.5" y2="6.5" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="11" y1="7.5" x2="12.5" y2="6.5" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="5" y1="9" x2="3.5" y2="9" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="11" y1="9" x2="12.5" y2="9" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="5" y1="10.5" x2="3.5" y2="11.5" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="11" y1="10.5" x2="12.5" y2="11.5" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    );
  }

  if (t === 'service_request') {
    // Jira-style headset icon
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#00B8D9"/>
        {/* Headband arc */}
        <path d="M4 8.5C4 5.74 5.79 4 8 4C10.21 4 12 5.74 12 8.5" stroke="white" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
        {/* Left ear cup */}
        <rect x="3" y="8.5" width="2" height="3" rx="1" fill="white"/>
        {/* Right ear cup */}
        <rect x="11" y="8.5" width="2" height="3" rx="1" fill="white"/>
        {/* Chin/cord */}
        <path d="M13 10.5C13 12 11.5 13 10 13H9" stroke="white" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
      </svg>
    );
  }

  if (t === 'incident') {
    // Warning triangle
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#FF7452"/>
        <path d="M8 3.5L13.5 12.5H2.5L8 3.5Z" stroke="white" strokeWidth="1.4" fill="none" strokeLinejoin="round"/>
        <line x1="8" y1="7" x2="8" y2="10" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="8" cy="11.5" r="0.7" fill="white"/>
      </svg>
    );
  }

  if (t === 'subtask' || t === 'sub-task' || t === 'sub_task') {
    // Small checkmark — same as task but smaller/lighter bg
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#0065FF" fillOpacity="0.75"/>
        <path d="M4.5 8.5L6.5 10.5L11.5 5.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }

  if (t === 'demo') {
    // Monitor with a play triangle
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#00A3BF"/>
        <rect x="3" y="3.5" width="10" height="7" rx="1" stroke="white" strokeWidth="1.3" fill="none"/>
        <path d="M6.5 11.5H9.5" stroke="white" strokeWidth="1.3" strokeLinecap="round"/>
        <path d="M7 5.3L9.5 7L7 8.7V5.3Z" fill="white"/>
      </svg>
    );
  }

  if (t === 'poc') {
    // Flask (proof of concept / experiment)
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#8777D9"/>
        <path d="M6.7 3.5V7L4 11.5C3.6 12.2 4.1 13 4.9 13H11.1C11.9 13 12.4 12.2 12 11.5L9.3 7V3.5" stroke="white" strokeWidth="1.3" fill="none" strokeLinejoin="round"/>
        <path d="M6 3.5H10" stroke="white" strokeWidth="1.3" strokeLinecap="round"/>
        <path d="M5.3 9.8H10.7" stroke="white" strokeWidth="1.1" strokeLinecap="round"/>
      </svg>
    );
  }

  if (t === 'technical_discussion') {
    // Two overlapping chat bubbles
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#2684FF"/>
        <path d="M3 5.5C3 4.67 3.67 4 4.5 4H9.5C10.33 4 11 4.67 11 5.5V7.5C11 8.33 10.33 9 9.5 9H6L4 10.5V9H4.5C3.67 9 3 8.33 3 7.5V5.5Z" fill="white"/>
        <circle cx="12" cy="10.5" r="2" fill="#2684FF" stroke="white" strokeWidth="1.1"/>
      </svg>
    );
  }

  if (t === 'security_assessment') {
    // Shield with a checkmark
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#DE350B"/>
        <path d="M8 3.3L12.3 4.8V8C12.3 10.5 10.5 12.4 8 13C5.5 12.4 3.7 10.5 3.7 8V4.8L8 3.3Z" stroke="white" strokeWidth="1.3" fill="none" strokeLinejoin="round"/>
        <path d="M6 8L7.5 9.5L10.2 6.5" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }

  if (t === 'technical_assistance') {
    // Wrench (support / assistance)
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="3" fill="#57D9A3"/>
        <path d="M11.8 5.9C12.1 5.2 12.1 4.4 11.8 3.7L10.3 5.2C9.9 5.6 9.3 5.6 8.9 5.2C8.5 4.8 8.5 4.2 8.9 3.8L10.4 2.3C9.7 2 8.9 2 8.2 2.3C7.1 2.8 6.5 4 6.8 5.2L3.4 8.6C3 9 3 9.6 3.4 10C3.8 10.4 4.4 10.4 4.8 10L8.2 6.6C9.4 6.9 10.6 6.3 11.1 5.2L11.8 5.9Z" fill="white"/>
      </svg>
    );
  }

  // Fallback — generic task
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect width="16" height="16" rx="3" fill="#0065FF"/>
      <path d="M4.5 8.5L6.5 10.5L11.5 5.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export default function IssueTypeIcon({
  type,
  size = 16,
}: {
  type: string;
  size?: number;
}) {
  return (
    <span
      title={TYPE_META[type?.toLowerCase()]?.label ?? type}
      className="inline-flex flex-shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <TypeSVG type={type} size={size} />
    </span>
  );
}
