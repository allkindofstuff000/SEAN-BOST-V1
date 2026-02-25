import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, Plus, RefreshCw } from "lucide-react";
import {
  adminCreateUser,
  adminListLicenses,
  adminListUsers,
  adminUpdateUser
} from "../lib/api";
import { useAccounts } from "../context/AccountsContext";

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
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-xl rounded-xl border border-red-800 bg-card p-6 shadow-[0_0_25px_rgba(255,59,59,0.2)]">
        <h3 className="mb-4 text-xl font-semibold">
          {mode === "edit" ? "Edit User" : "Create User"}
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm text-white/80">Username</span>
            <input
              type="text"
              value={form.username}
              onChange={(event) => onChange("username", event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
              disabled={mode === "edit"}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-white/80">Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => onChange("email", event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
              disabled={mode === "edit"}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-white/80">
              {mode === "edit" ? "Reset Password (optional)" : "Password"}
            </span>
            <input
              type="password"
              value={form.password}
              onChange={(event) => onChange("password", event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-white/80">Role</span>
            <select
              value={form.role}
              onChange={(event) => onChange("role", event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>

          <label className="block md:col-span-2">
            <span className="mb-1 block text-sm text-white/80">Assign License</span>
            <select
              value={form.licenseId}
              onChange={(event) => onChange("licenseId", event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
            >
              <option value="">No license</option>
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
                className="h-4 w-4 accent-red-500"
              />
              User is active
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
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {submitting ? <LoaderCircle size={14} className="animate-spin" /> : null}
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminUsers() {
  const { showToast } = useAccounts();
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">Admin Users</h1>
          <p className="mt-1 text-sm text-white/70">Create users, assign licenses, and manage access.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={loadUsers}
            className="inline-flex items-center gap-2 rounded-lg border border-red-700 px-3 py-2 text-sm text-white/90"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            <Plus size={14} />
            Create User
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-red-800 bg-card p-4">
        <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <input
            value={q}
            onChange={(event) => {
              setPage(1);
              setQ(event.target.value);
            }}
            placeholder="Search username or email"
            className="rounded-lg border border-red-800 bg-red-950 px-3 py-2 text-sm outline-none focus:border-red-500"
          />
          <div className="flex items-center justify-end text-sm text-white/70">
            Total: {total}
          </div>
        </div>

        {error ? (
          <div className="mb-3 rounded-lg border border-red-700 bg-red-950/70 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-red-900/70 text-white/75">
                <th className="px-2 py-2 font-semibold">Username</th>
                <th className="px-2 py-2 font-semibold">Email</th>
                <th className="px-2 py-2 font-semibold">Role</th>
                <th className="px-2 py-2 font-semibold">License</th>
                <th className="px-2 py-2 font-semibold">Active</th>
                <th className="px-2 py-2 font-semibold">Created</th>
                <th className="px-2 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-2 py-6 text-center text-white/65">Loading users...</td>
                </tr>
              ) : null}

              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-6 text-center text-white/65">No users found.</td>
                </tr>
              ) : null}

              {!loading &&
                items.map((user) => (
                  <tr key={user._id} className="border-b border-red-900/40">
                    <td className="px-2 py-3">{user.username}</td>
                    <td className="px-2 py-3">{user.email}</td>
                    <td className="px-2 py-3">
                      <span className="rounded-full border border-cyan-500/30 bg-cyan-900/20 px-2 py-1 text-xs">
                        {user.role}
                      </span>
                    </td>
                    <td className="px-2 py-3">
                      {user.license?.keyMasked || "No license"}
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
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(user)}
                          className="rounded border border-red-600/70 px-2 py-1 text-xs"
                        >
                          {user.isActive ? "Disable" : "Enable"}
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
            Page {page} of {Math.max(1, pages)}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className="rounded border border-red-700 px-3 py-1 text-sm disabled:opacity-50"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((value) => value + 1)}
              className="rounded border border-red-700 px-3 py-1 text-sm disabled:opacity-50"
            >
              Next
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
