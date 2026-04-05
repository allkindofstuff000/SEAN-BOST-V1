import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { LoaderCircle, Plus, RefreshCw } from "lucide-react";
import {
  adminCreateUser,
  adminListLicenses,
  adminListUsers,
  adminUpdateUser
} from "../lib/api";
import { useAccounts } from "../context/AccountsContext";
import { useLanguage } from "../context/LanguageContext";

function AdminTabs() {
  const { t } = useLanguage();
  const tabs = [
    { to: "/admin", label: t('admin.overview'), end: true },
    { to: "/admin/users", label: t('admin.users') },
    { to: "/admin/licenses", label: t('admin.licenses') }
  ];

  return (
    <nav className="adminTabs">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `adminTab ${isActive ? "active" : ""}`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

function UserModal({
  open,
  mode,
  form,
  submitting,
  licenses,
  onClose,
  onChange,
  onSubmit
}) {
  const { t } = useLanguage();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-xl rounded-xl themeCard p-6">
        <h3 className="mb-4 text-xl font-semibold">
          {mode === "edit" ? t('admin.editUser') : t('admin.createUser')}
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm text-white/80">{t('admin.username')}</span>
            <input
              type="text"
              value={form.username}
              onChange={(event) => onChange("username", event.target.value)}
              className="w-full rounded-lg themeField px-3 py-2 outline-none"
              disabled={mode === "edit"}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-white/80">{t('admin.email')}</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => onChange("email", event.target.value)}
              className="w-full rounded-lg themeField px-3 py-2 outline-none"
              disabled={mode === "edit"}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-white/80">
              {mode === "edit" ? t('admin.resetPassword') : t('admin.password')}
            </span>
            <input
              type="password"
              value={form.password}
              onChange={(event) => onChange("password", event.target.value)}
              className="w-full rounded-lg themeField px-3 py-2 outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-white/80">{t('admin.role')}</span>
            <select
              value={form.role}
              onChange={(event) => onChange("role", event.target.value)}
              className="w-full rounded-lg themeField px-3 py-2 outline-none"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>

          <label className="block md:col-span-2">
            <span className="mb-1 block text-sm text-white/80">{t('admin.assignLicense')}</span>
            <select
              value={form.licenseId}
              onChange={(event) => onChange("licenseId", event.target.value)}
              className="w-full rounded-lg themeField px-3 py-2 outline-none"
            >
              <option value="">{t('admin.noLicense')}</option>
              {licenses.map((license) => (
                <option key={license._id} value={license._id}>
                  {license.keyMasked || license.key} | max {license.maxAccounts} | {license.status}
                </option>
              ))}
            </select>
          </label>

          {mode === "edit" ? (
            <label className="md:col-span-2 inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(form.isActive)}
                onChange={(event) => onChange("isActive", event.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {t('admin.userIsActive')}
            </label>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-white/90 disabled:opacity-60"
          >
            {t('admin.cancel')}
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {submitting ? <LoaderCircle size={14} className="animate-spin" /> : null}
            {submitting ? t('admin.saving') : t('admin.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminUsers() {
  const { showToast } = useAccounts();
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [licenses, setLicenses] = useState([]);
  const [page, setPage] = useState(1);
  const [limit] = useState(10);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm] = useState({
    username: "",
    email: "",
    password: "",
    role: "user",
    licenseId: "",
    isActive: true
  });

  const queryParams = useMemo(() => ({ page, limit, q }), [limit, page, q]);

  const loadLicenses = useCallback(async () => {
    try {
      const payload = await adminListLicenses({ page: 1, limit: 100, status: "all" });
      setLicenses(Array.isArray(payload?.data) ? payload.data : []);
    } catch {
      setLicenses([]);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await adminListUsers(queryParams);
      setItems(Array.isArray(payload?.data) ? payload.data : []);
      setTotal(Number(payload?.total || 0));
      setPages(Number(payload?.pages || 0));
    } catch (loadError) {
      const message =
        loadError?.response?.data?.message ||
        loadError?.message ||
        "Failed to load users";
      setError(message);
      showToast?.(message, "error");
    } finally {
      setLoading(false);
    }
  }, [queryParams, showToast]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    loadLicenses();
  }, [loadLicenses]);

  const openCreateModal = () => {
    setEditTarget(null);
    setCreateOpen(true);
    setForm({
      username: "",
      email: "",
      password: "",
      role: "user",
      licenseId: "",
      isActive: true
    });
  };

  const openEditModal = (user) => {
    setCreateOpen(false);
    setEditTarget(user);
    setForm({
      username: String(user?.username || ""),
      email: String(user?.email || ""),
      password: "",
      role: String(user?.role || "user"),
      licenseId: String(user?.license?._id || ""),
      isActive: Boolean(user?.isActive)
    });
  };

  const closeModal = () => {
    setCreateOpen(false);
    setEditTarget(null);
  };

  const handleSubmit = async () => {
    if (submitting) return;

    setSubmitting(true);
    try {
      if (editTarget) {
        const payload = {
          role: form.role,
          isActive: Boolean(form.isActive),
          licenseId: form.licenseId || null
        };
        if (form.password.trim()) {
          payload.password = form.password.trim();
        }
        await adminUpdateUser(editTarget._id, payload);
        showToast?.("User updated", "success");
      } else {
        if (!form.username.trim() || !form.email.trim() || !form.password.trim()) {
          showToast?.("username, email and password are required", "error");
          setSubmitting(false);
          return;
        }

        await adminCreateUser({
          username: form.username.trim(),
          email: form.email.trim(),
          password: form.password.trim(),
          role: form.role,
          licenseId: form.licenseId || null
        });
        showToast?.("User created", "success");
      }

      closeModal();
      await loadUsers();
    } catch (submitError) {
      const message =
        submitError?.response?.data?.message ||
        submitError?.message ||
        "Failed to save user";
      showToast?.(message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (user) => {
    try {
      await adminUpdateUser(user._id, { isActive: !user.isActive });
      showToast?.(`User ${user.isActive ? "disabled" : "enabled"}`, "success");
      await loadUsers();
    } catch (toggleError) {
      showToast?.(
        toggleError?.response?.data?.message || toggleError?.message || "Failed to update user",
        "error"
      );
    }
  };

  return (
    <div className="space-y-5" style={{ maxWidth: "1400px", margin: "0 auto", width: "100%" }}>
      <AdminTabs />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">{t('admin.adminUsers')}</h1>
          <p className="mt-1 text-sm text-white/70">{t('admin.adminUsersSubtitle')}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={loadUsers}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-white/90"
          >
            <RefreshCw size={14} />
            {t('admin.refresh')}
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="themeBtnAccent inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
          >
            <Plus size={14} />
            {t('admin.createUser')}
          </button>
        </div>
      </div>

      <div className="rounded-xl themeCard p-4">
        <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <input
            value={q}
            onChange={(event) => {
              setPage(1);
              setQ(event.target.value);
            }}
            placeholder={t('admin.searchUserPlaceholder')}
            className="rounded-lg themeField px-3 py-2 text-sm outline-none"
          />
          <div className="flex items-center justify-end text-sm text-white/70">
            {t('admin.total')}: {total}
          </div>
        </div>

        {error ? (
          <div className="mb-3 rounded-lg border border-[var(--border)] bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-white/75">
                <th className="px-2 py-2 font-semibold">{t('admin.username')}</th>
                <th className="px-2 py-2 font-semibold">{t('admin.email')}</th>
                <th className="px-2 py-2 font-semibold">{t('admin.role')}</th>
                <th className="px-2 py-2 font-semibold">{t('admin.license')}</th>
                <th className="px-2 py-2 font-semibold">{t('admin.active')}</th>
                <th className="px-2 py-2 font-semibold">{t('admin.created')}</th>
                <th className="px-2 py-2 font-semibold">{t('admin.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-2 py-6 text-center text-white/65">{t('admin.loadingUsers')}</td>
                </tr>
              ) : null}

              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-6 text-center text-white/65">{t('admin.noUsersFound')}</td>
                </tr>
              ) : null}

              {!loading &&
                items.map((user) => (
                  <tr key={user._id} className="border-b border-[var(--border)]">
                    <td className="px-2 py-3">{user.username}</td>
                    <td className="px-2 py-3">{user.email}</td>
                    <td className="px-2 py-3">
                      <span className="rounded-full border border-cyan-500/30 bg-cyan-900/20 px-2 py-1 text-xs">
                        {user.role}
                      </span>
                    </td>
                    <td className="px-2 py-3">
                      {user.license?.keyMasked || t('admin.noLicense')}
                    </td>
                    <td className="px-2 py-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${
                          user.isActive
                            ? "border border-green-500/40 bg-green-900/25 text-green-200"
                            : "border border-red-500/40 bg-red-900/25 text-red-100"
                        }`}
                      >
                        {user.isActive ? "active" : "disabled"}
                      </span>
                    </td>
                    <td className="px-2 py-3">{new Date(user.createdAt).toLocaleString()}</td>
                    <td className="px-2 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => openEditModal(user)}
                          className="rounded border border-white/30 px-2 py-1 text-xs"
                        >
                          {t('admin.edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(user)}
                          className="rounded border border-red-600/70 px-2 py-1 text-xs"
                        >
                          {user.isActive ? t('admin.disable') : t('admin.enable')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="text-sm text-white/70">
            {t('logs.page')} {page} {t('logs.of')} {Math.max(1, pages)}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50"
            >
              {t('logs.prev')}
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((value) => value + 1)}
              className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50"
            >
              {t('logs.next')}
            </button>
          </div>
        </div>
      </div>

      <UserModal
        open={createOpen || Boolean(editTarget)}
        mode={editTarget ? "edit" : "create"}
        form={form}
        submitting={submitting}
        licenses={licenses}
        onClose={closeModal}
        onChange={(field, value) => setForm((prev) => ({ ...prev, [field]: value }))}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
