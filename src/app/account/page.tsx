'use client';

import { useState, useRef, useEffect } from 'react';
import { useStore } from '@/store/index';
import { api } from '@/lib/api';
import { getInitials } from '@/lib/utils';
import {
  User, Mail, Lock, Camera, Check, AlertCircle, ArrowLeft,
  Eye, EyeOff, Shield, Upload, Trash2,
} from 'lucide-react';
import Link from 'next/link';

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500',
  'bg-rose-500', 'bg-teal-500', 'bg-indigo-500', 'bg-amber-500',
];
function avatarColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

type Tab = 'profile' | 'security';

export default function AccountPage() {
  const { user, loadUser } = useStore((s) => ({ user: s.user, loadUser: s.loadUser }));
  const [tab, setTab] = useState<Tab>('profile');

  // ── Profile fields ──────────────────────────────────────────────────────────
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const avatarMenuRef = useRef<HTMLDivElement>(null);

  // Close avatar menu on outside click
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target as Node)) {
        setShowAvatarMenu(false);
      }
    }
    if (showAvatarMenu) document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [showAvatarMenu]);

  // ── Security fields ─────────────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (user) {
      setFirstName(user.firstName || '');
      setLastName(user.lastName || '');
      setDisplayName((user as any).displayName || '');
      setAvatarUrl((user as any).avatarUrl || '');
    }
  }, [user]);


  const fullName = `${firstName} ${lastName}`.trim() || user?.email || '';
  const initials = getInitials(fullName);
  const colorClass = avatarColor(fullName);

  // ── Save avatar immediately ─────────────────────────────────────────────────
  async function saveAvatar(url: string | null) {
    if (!user) return;
    setAvatarSaving(true);
    try {
      await api.updateUser(user.id, { avatarUrl: url || '' });
      await loadUser();
      setAvatarUrl(url || '');
    } catch {
      setProfileMsg({ type: 'error', text: 'Failed to save photo.' });
      setTimeout(() => setProfileMsg(null), 3000);
    } finally {
      setAvatarSaving(false);
    }
  }

  // ── Handle file upload ──────────────────────────────────────────────────────
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = () => saveAvatar(reader.result as string);
    reader.readAsDataURL(file);
  }

  // ── Remove avatar ───────────────────────────────────────────────────────────
  function handleRemovePhoto() {
    saveAvatar(null);
  }

  // ── Save profile fields ─────────────────────────────────────────────────────
  async function handleSaveProfile() {
    if (!user) return;
    setSaving(true);
    setProfileMsg(null);
    try {
      await api.updateUser(user.id, {
        firstName,
        lastName,
        displayName: displayName || undefined,
        avatarUrl: avatarUrl || undefined,
      });
      await loadUser();
      setProfileMsg({ type: 'success', text: 'Profile updated successfully!' });
    } catch {
      setProfileMsg({ type: 'error', text: 'Failed to update profile. Please try again.' });
    } finally {
      setSaving(false);
      setTimeout(() => setProfileMsg(null), 4000);
    }
  }

  // ── Save password ───────────────────────────────────────────────────────────
  async function handleSavePassword() {
    if (!newPassword || newPassword !== confirmPassword) {
      setPwMsg({ type: 'error', text: 'Passwords do not match.' });
      return;
    }
    if (newPassword.length < 8) {
      setPwMsg({ type: 'error', text: 'Password must be at least 8 characters.' });
      return;
    }
    setPwSaving(true);
    setPwMsg(null);
    try {
      await api.updateUser(user!.id, { password: newPassword });
      setPwMsg({ type: 'success', text: 'Password changed successfully!' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch {
      setPwMsg({ type: 'error', text: 'Failed to change password. Please try again.' });
    } finally {
      setPwSaving(false);
      setTimeout(() => setPwMsg(null), 4000);
    }
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3">
        <Link href="/" className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-800 transition-colors">
          <ArrowLeft size={15} /> Back
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-[13px] font-semibold text-gray-800">Account Settings</span>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Header card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm mb-6">
          {/* Blue banner */}
          <div className="h-28 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-t-2xl" />
          {/* Avatar overlapping the banner */}
          <div className="px-6">
            <div className="relative -mt-12 mb-3">
              <div className="relative inline-block" ref={avatarMenuRef}>

                {/* Clickable avatar circle */}
                <button
                  onClick={() => !avatarSaving && setShowAvatarMenu(p => !p)}
                  className="relative w-24 h-24 rounded-full border-4 border-white shadow-lg focus:outline-none group"
                  title="Change photo"
                >
                  <div className={`w-full h-full rounded-full flex items-center justify-center overflow-hidden ${!avatarUrl ? colorClass : ''}`}>
                    {avatarSaving ? (
                      <div className="w-full h-full flex items-center justify-center bg-gray-200">
                        <div className="w-6 h-6 border-2 border-blue-400 border-t-blue-600 rounded-full animate-spin" />
                      </div>
                    ) : avatarUrl ? (
                      <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-white text-2xl font-bold">{initials}</span>
                    )}
                  </div>
                  {/* Hover overlay */}
                  {!avatarSaving && (
                    <div className="absolute inset-0 rounded-full bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Camera size={20} className="text-white" />
                    </div>
                  )}
                </button>

                {/* Popup menu */}
                {showAvatarMenu && (
                  <div className="absolute left-0 top-[calc(100%+8px)] z-[9999] bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden w-56">
                    <div className="px-4 py-3 border-b border-gray-100">
                      <p className="text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Profile Photo</p>
                    </div>
                    {/* Upload */}
                    <button
                      onClick={() => { setShowAvatarMenu(false); fileRef.current?.click(); }}
                      className="flex items-center gap-3 w-full px-4 py-3 text-[13px] text-gray-700 hover:bg-blue-50 transition-colors"
                    >
                      <div className="w-8 h-8 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <Upload size={14} className="text-blue-600" />
                      </div>
                      <div className="text-left">
                        <div className="font-semibold text-gray-800">Upload photo</div>
                        <div className="text-[11px] text-gray-400">JPG, PNG, GIF · max 5 MB</div>
                      </div>
                    </button>
                    {/* Remove — only if photo exists */}
                    {avatarUrl && (
                      <button
                        onClick={() => { setShowAvatarMenu(false); handleRemovePhoto(); }}
                        className="flex items-center gap-3 w-full px-4 py-3 text-[13px] text-gray-700 hover:bg-red-50 transition-colors border-t border-gray-100"
                      >
                        <div className="w-8 h-8 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
                          <Trash2 size={14} className="text-red-500" />
                        </div>
                        <div className="text-left">
                          <div className="font-semibold text-red-600">Remove photo</div>
                          <div className="text-[11px] text-gray-400">Revert to initials</div>
                        </div>
                      </button>
                    )}
                  </div>
                )}

                {/* Hidden file input */}
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
              </div>
            </div>

            {/* Name + email below avatar in white area */}
            <div className="pb-5">
              <h1 data-hj-suppress className="text-[18px] font-bold text-gray-900">{fullName || user.email}</h1>
              <p data-hj-suppress className="text-[12.5px] text-gray-500 mt-0.5">{user.email}</p>
              <span className="inline-flex items-center mt-2 px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold bg-blue-100 text-blue-700 capitalize">
                {(user as any).role || 'member'}
              </span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-white border border-gray-200 rounded-xl p-1 w-fit shadow-sm">
          {(['profile', 'security'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2 rounded-lg text-[13px] font-medium transition-colors capitalize ${
                tab === t ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              {t === 'profile'
                ? <span className="flex items-center gap-1.5"><User size={13} />Profile</span>
                : <span className="flex items-center gap-1.5"><Shield size={13} />Security</span>}
            </button>
          ))}
        </div>

        {/* ── Profile Tab ── */}
        {tab === 'profile' && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h2 className="text-[15px] font-bold text-gray-900 mb-5">Personal Information</h2>
            <div className="space-y-5">
              {/* Name row */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">First Name</label>
                  <input
                    value={firstName}
                    onChange={e => setFirstName(e.target.value)}
                    className="input-field"
                    placeholder="First name"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Last Name</label>
                  <input
                    value={lastName}
                    onChange={e => setLastName(e.target.value)}
                    className="input-field"
                    placeholder="Last name"
                  />
                </div>
              </div>

              {/* Display name */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Display Name</label>
                <input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  className="input-field"
                  placeholder="How your name appears to others (optional)"
                />
              </div>

              {/* Email (read-only) */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Email Address</label>
                <div className="relative">
                  <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    data-hj-suppress
                    value={user.email}
                    readOnly
                    className="input-field pl-8 bg-gray-50 text-gray-500 cursor-not-allowed"
                  />
                </div>
                <p className="text-[11px] text-gray-400 mt-1">Email address cannot be changed here.</p>
              </div>
            </div>

            {/* Save */}
            <div className="flex items-center gap-3 mt-6 pt-5 border-t border-gray-100">
              {profileMsg && (
                <div className={`flex items-center gap-1.5 text-[12.5px] font-medium ${profileMsg.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                  {profileMsg.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
                  {profileMsg.text}
                </div>
              )}
              <button
                onClick={handleSaveProfile}
                disabled={saving}
                className="ml-auto btn-primary flex items-center gap-2 disabled:opacity-50"
              >
                {saving ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={14} />}
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        )}

        {/* ── Security Tab ── */}
        {tab === 'security' && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h2 className="text-[15px] font-bold text-gray-900 mb-1">Change Password</h2>
            <p className="text-[12.5px] text-gray-500 mb-5">Choose a strong password with at least 8 characters.</p>

            <div className="space-y-4">
              {/* Current password */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Current Password</label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type={showCurrent ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={e => setCurrentPassword(e.target.value)}
                    className="input-field pl-8 pr-10"
                    placeholder="Enter current password"
                  />
                  <button onClick={() => setShowCurrent(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showCurrent ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {/* New password */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">New Password</label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type={showNew ? 'text' : 'password'}
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="input-field pl-8 pr-10"
                    placeholder="Min. 8 characters"
                  />
                  <button onClick={() => setShowNew(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {/* Strength bar */}
                {newPassword && (
                  <div className="mt-1.5 flex gap-1 items-center">
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${
                        newPassword.length >= i * 3
                          ? newPassword.length >= 12 ? 'bg-green-500'
                          : newPassword.length >= 8 ? 'bg-yellow-400' : 'bg-red-400'
                          : 'bg-gray-200'
                      }`} />
                    ))}
                    <span className="text-[10px] text-gray-400 ml-1 whitespace-nowrap">
                      {newPassword.length >= 12 ? 'Strong' : newPassword.length >= 8 ? 'Medium' : 'Weak'}
                    </span>
                  </div>
                )}
              </div>

              {/* Confirm password */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Confirm New Password</label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="input-field pl-8 pr-10"
                    placeholder="Re-enter new password"
                  />
                  <button onClick={() => setShowConfirm(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showConfirm ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {confirmPassword && newPassword !== confirmPassword && (
                  <p className="text-[11px] text-red-500 mt-1 flex items-center gap-1"><AlertCircle size={11} /> Passwords do not match</p>
                )}
                {confirmPassword && newPassword === confirmPassword && newPassword.length > 0 && (
                  <p className="text-[11px] text-green-600 mt-1 flex items-center gap-1"><Check size={11} /> Passwords match</p>
                )}
              </div>
            </div>

            {/* Save */}
            <div className="flex items-center gap-3 mt-6 pt-5 border-t border-gray-100">
              {pwMsg && (
                <div className={`flex items-center gap-1.5 text-[12.5px] font-medium ${pwMsg.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                  {pwMsg.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
                  {pwMsg.text}
                </div>
              )}
              <button
                onClick={handleSavePassword}
                disabled={pwSaving || !newPassword || newPassword !== confirmPassword}
                className="ml-auto btn-primary flex items-center gap-2 disabled:opacity-50"
              >
                {pwSaving ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Lock size={14} />}
                {pwSaving ? 'Updating…' : 'Update Password'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
