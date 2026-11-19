'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

const STEPS = [
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
      </svg>
    ),
    title: 'Capture Every Request',
    desc: 'Emails, portal, and agent tickets — all auto-routed instantly.',
    color: '#3B82F6',
    gradient: 'linear-gradient(135deg, #3B82F6, #6366F1)',
    bg: 'rgba(59,130,246,0.12)',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    ),
    title: 'Smart Assignment',
    desc: 'AI-powered priority and routing to the right expert every time.',
    color: '#8B5CF6',
    gradient: 'linear-gradient(135deg, #8B5CF6, #EC4899)',
    bg: 'rgba(139,92,246,0.12)',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18"/>
        <path d="m19 9-5 5-4-4-3 3"/>
      </svg>
    ),
    title: 'Full Visibility',
    desc: 'Real-time status, SLA tracking, and complete audit history.',
    color: '#0EA5E9',
    gradient: 'linear-gradient(135deg, #0EA5E9, #06B6D4)',
    bg: 'rgba(14,165,233,0.12)',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5"/>
      </svg>
    ),
    title: 'Fast Resolution',
    desc: 'Close tickets, notify stakeholders, and stay compliant.',
    color: '#10B981',
    gradient: 'linear-gradient(135deg, #10B981, #059669)',
    bg: 'rgba(16,185,129,0.12)',
  },
];

function LoginContent() {
  const [loading, setLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const searchParams = useSearchParams();

  useEffect(() => {
    const err = searchParams.get('oauth_error');
    if (err) setOauthError(decodeURIComponent(err));
  }, [searchParams]);

  // Auto-cycle through steps
  useEffect(() => {
    const t = setInterval(() => setActiveStep(s => (s + 1) % STEPS.length), 2800);
    return () => clearInterval(t);
  }, []);

  const handleMicrosoft = () => {
    setLoading(true);
    // ?next= (e.g. the Claude connector's /api/oauth/authorize step) brings
    // the person back where they started after signing in. Same-site paths
    // only -- never an absolute URL, so this can't become an open redirect.
    const next = searchParams.get('next') || '';
    const returnUrl = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/dashboard';
    window.location.href = `/api/auth/oauth/microsoft?mode=login&returnUrl=${encodeURIComponent(returnUrl)}`;
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">

      {/* ── Top Bar ── */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-gray-100 bg-white z-10">
        <div className="flex items-center gap-2.5">
          <img src="/neutara-logo.png" alt="Neutara" className="h-8 w-8 rounded-md object-contain" />
          <span className="text-[15px] font-bold text-gray-800 tracking-tight">Neutara Technologies Ticketing</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[12px] text-gray-400 font-medium">Secured by Microsoft</span>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT PANEL ── */}
        <div
          className="hidden lg:flex flex-col flex-shrink-0 relative overflow-hidden"
          style={{ width: '55%', background: 'linear-gradient(145deg, #0129AC 0%, #0a3dd4 60%, #1a52e8 100%)' }}
        >
          {/* Animated background circles */}
          <div className="absolute top-[-80px] right-[-80px] w-80 h-80 rounded-full opacity-10"
            style={{ background: 'radial-gradient(circle, #ffffff 0%, transparent 70%)' }} />
          <div className="absolute bottom-[-60px] left-[-60px] w-64 h-64 rounded-full opacity-10"
            style={{ background: 'radial-gradient(circle, #5BB8FF 0%, transparent 70%)' }} />

          {/* Grid overlay */}
          <div className="absolute inset-0 pointer-events-none opacity-[0.04]"
            style={{
              backgroundImage: 'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
              backgroundSize: '40px 40px',
            }} />

          <div className="relative z-10 flex flex-col h-full px-10 py-10">

            {/* Badge */}
            <div className="inline-flex self-start items-center gap-2 mb-8 px-4 py-1.5 rounded-full"
              style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
              <span className="text-[10.5px] font-bold text-white uppercase tracking-[0.2em]">Unified Support Platform</span>
            </div>

            {/* Headline */}
            <h2 className="font-extrabold text-white mb-4 whitespace-nowrap"
              style={{ fontSize: '28px', letterSpacing: '-0.5px', lineHeight: '1.15' }}>
              One Platform to Manage Every <span style={{ color: '#5BB8FF' }}>Support</span> Request
            </h2>

            <p className="text-blue-100/70 text-[13px] leading-relaxed mb-8 max-w-[400px]">
              Empower your L1, QA, and Infrastructure teams with a single intelligent platform.
            </p>

            {/* Steps — interactive with auto-cycle */}
            <div className="flex-1 flex flex-col gap-3">
              {STEPS.map((step, i) => (
                <button
                  key={i}
                  onClick={() => setActiveStep(i)}
                  className="flex items-center gap-4 rounded-2xl px-4 py-3.5 text-left w-full transition-all duration-300"
                  style={{
                    background: activeStep === i ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)',
                    border: activeStep === i ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
                    transform: activeStep === i ? 'translateX(4px)' : 'translateX(0)',
                  }}
                >
                  {/* Gradient icon box */}
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-300 text-white"
                    style={{
                      background: activeStep === i ? step.gradient : 'rgba(255,255,255,0.10)',
                      boxShadow: activeStep === i ? `0 4px 14px ${step.color}55` : 'none',
                    }}>
                    {step.icon}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-white font-bold text-[13px]">{step.title}</p>
                    <p className={`text-[11.5px] mt-0.5 leading-relaxed transition-all duration-300 ${activeStep === i ? 'text-blue-100/80' : 'text-blue-100/40'}`}>
                      {step.desc}
                    </p>
                  </div>

                  {/* Active indicator dot */}
                  <div className="flex-shrink-0 w-2 h-2 rounded-full transition-all duration-300"
                    style={{ background: activeStep === i ? step.color : 'transparent' }} />
                </button>
              ))}
            </div>

            {/* Progress dots */}
            <div className="flex items-center gap-2 mt-6">
              {STEPS.map((_, i) => (
                <button key={i} onClick={() => setActiveStep(i)}
                  className="rounded-full transition-all duration-300"
                  style={{
                    width: activeStep === i ? '20px' : '6px',
                    height: '6px',
                    background: activeStep === i ? '#5BB8FF' : 'rgba(255,255,255,0.3)',
                  }} />
              ))}
            </div>

            {/* Footer */}
            <div className="mt-5 pt-4 flex items-center justify-between"
              style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <p className="text-white/30 text-[10.5px]">© {new Date().getFullYear()} Neutara Technologies Ticketing</p>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-white/35 text-[10.5px]">All systems running smoothly</span>
              </div>
            </div>

          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="flex-1 flex items-center justify-center px-6 py-10 bg-white">
          <div className="w-full max-w-[400px]">

            {/* Mobile-only branding */}
            <div className="lg:hidden flex flex-col items-center mb-8">
              <div className="inline-flex items-center gap-2 mb-4 px-4 py-1.5 rounded-full bg-blue-50 border border-blue-100">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-[11px] font-bold text-blue-600 uppercase tracking-[0.18em]">Unified Support Platform</span>
              </div>
              <h2 className="text-[24px] font-extrabold text-gray-900 text-center leading-tight">
                One Platform for Every<br /><span className="text-blue-600">Support Request</span>
              </h2>
            </div>

            {/* Greeting */}
            <div className="mb-8 text-center lg:text-left">
              <h1 className="text-[28px] font-bold text-gray-900 tracking-tight flex items-center gap-2 justify-center lg:justify-start">
                <span>Welcome Back</span>
                <span className="text-3xl">👋</span>
              </h1>
              <p className="text-[13.5px] text-gray-500 mt-1">
                Sign in with your Microsoft account to continue
              </p>
            </div>

            {/* OAuth Error */}
            {oauthError && (
              <div className="mb-5 px-4 py-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-3">
                <span className="text-red-500 text-lg flex-shrink-0">⚠️</span>
                <p className="text-red-700 text-[13px]">
                  {oauthError.includes('account_not_found') || oauthError.includes('No account')
                    ? 'No account found for this email. Please contact your administrator.'
                    : oauthError.includes('token_exchange')
                    ? 'Microsoft sign-in failed. Please try again.'
                    : `Sign-in error: ${oauthError}`}
                </p>
              </div>
            )}

            {/* Sign In Card */}
            <div className="rounded-2xl border border-gray-100 p-6 shadow-sm bg-white mb-5">
              <button
                type="button"
                onClick={handleMicrosoft}
                disabled={loading}
                className="w-full py-4 border-2 border-gray-200 hover:border-blue-400 hover:bg-blue-50 text-[14.5px] font-semibold text-gray-700 rounded-xl transition-all duration-200 flex items-center justify-center gap-3 shadow-sm hover:shadow-md disabled:opacity-60 disabled:cursor-not-allowed group"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    <span className="text-blue-600">Redirecting to Microsoft…</span>
                  </>
                ) : (
                  <>
                    <svg width="20" height="20" viewBox="0 0 21 21" fill="none" className="flex-shrink-0">
                      <rect x="1"  y="1"  width="9" height="9" fill="#F25022" />
                      <rect x="11" y="1"  width="9" height="9" fill="#7FBA00" />
                      <rect x="1"  y="11" width="9" height="9" fill="#00A4EF" />
                      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                    </svg>
                    <span className="group-hover:text-blue-700 transition-colors">Sign in with Microsoft</span>
                  </>
                )}
              </button>

              <p className="text-center text-[11.5px] text-gray-400 mt-4 leading-relaxed">
                Use your organization Microsoft account to sign in
              </p>
            </div>

            {/* Mobile Steps (show only on small screens) */}
            <div className="lg:hidden grid grid-cols-2 gap-3">
              {STEPS.map((step, i) => (
                <div key={i}
                  className="flex flex-col items-center gap-2 rounded-xl p-3 border border-gray-100 text-center"
                  style={{ background: step.bg }}>
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white"
                    style={{ background: step.gradient }}>
                    {step.icon}
                  </div>
                  <p className="text-[11px] font-semibold text-gray-700 leading-tight">{step.title}</p>
                </div>
              ))}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600" />
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
