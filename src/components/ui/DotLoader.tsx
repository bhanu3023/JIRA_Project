/**
 * DotLoader — thin spinning-ring loading indicator (kept the original name
 * since it's imported across 9 files; only the visual changed, not the API).
 * Replaced the old three-large-bouncing-dots animation, which read as
 * playful/informal for an enterprise ticketing tool, with the same subtle
 * spinner convention used by most professional web apps (GitHub, Linear,
 * Jira itself).
 */
export default function DotLoader({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div
        className="h-6 w-6 rounded-full border-[2.5px] border-gray-200 border-t-blue-600 animate-spin"
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}
