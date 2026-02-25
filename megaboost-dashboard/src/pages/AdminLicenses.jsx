import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Eye, EyeOff, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import {
  adminCreateLicense,
  adminListLicenses,
  adminUpdateLicense
} from "../lib/api";
import { useAccounts } from "../context/AccountsContext";

function toDateTimeLocalValue(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(date.valueOf())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

function maskKey(key) {
  const value = String(key || "").trim().toUpperCase();
  const match = value.match(/^([A-Z0-9]+)-([A-F0-9]{4})-([A-F0-9]{4})-([A-F0-9]{4})$/);
  if (!match) return value;
  return `${match[1]}-${match[2]}-****-${match[4]}`;
}

async function copyToClipboard(value) {
  const text = String(value || "");
  if (!text) return false;

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  return copied;
}

function LicenseModal({
  open,
  mode,
  form,
  submitting,
  onClose,
  onChange,
  onSubmit
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-xl border border-red-800 bg-card p-6 shadow-[0_0_25px_rgba(255,59,59,0.2)]">
        <h3 className="mb-4 text-xl font-semibold">
          {mode === "edit" ? "Edit License" : "Create License"}
        </h3>

        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm text-white/80">Max Accounts</span>
            <input
              type="number"
              min="1"
              value={form.maxAccounts}
              onChange={(event) => onChange("maxAccounts", event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-white/80">Expires At</span>
            <input
              type="datetime-local"
              value={form.expiresAt}
              onChange={(event) => onChange("expiresAt", event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
            />
          </label>

          {mode === "edit" ? (
            <label className="block">
              <span className="mb-1 block text-sm text-white/80">Status</span>
              <select
                value={form.status}
                onChange={(event) => onChange("status", event.target.value)}
                className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
              >
                <option value="active">active</option>
                <option value="revoked">revoked</option>
              </select>
            </label>
          ) : null}

          <label className="block">
            <span className="mb-1 block text-sm text-white/80">Notes</span>
            <textarea
              value={form.notes}
              onChange={(event) => onChange("notes", event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
            />
          </label>
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

export default function AdminLicenses() {
  const { showToast } = useAccounts();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [limit] = useState(10);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [revealById, setRevealById] = useState({});
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm] = useState({
    maxAccounts: "5",
    expiresAt: toDateTimeLocalValue(null),
    status: "active",
    notes: ""
  });

  const queryParams = useMemo(
    () => ({ page, limit, q, status }),
    [limit, page, q, status]
  );

  const loadLicenses = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await adminListLicenses(queryParams);
      setItems(Array.isArray(payload?.data) ? payload.data : []);
      setTotal(Number(payload?.total || 0));
      setPages(Number(payload?.pages || 0));
    } catch (loadError) {
      const message =
        loadError?.response?.data?.message ||
        loadError?.message ||
        "Failed to load licenses";
      setError(message);
      showToast?.(message, "error");
    } finally {
      setLoading(false);
    }
  }, [queryParams, showToast]);

  useEffect(() => {
    loadLicenses();
  }, [loadLicenses]);

  const openCreateModal = () => {
    setCreateOpen(true);
    setEditTarget(null);
    setForm({
      maxAccounts: "5",
      expiresAt: toDateTimeLocalValue(null),
      status: "active",
      notes: ""
    });
  };

  const openEditModal = (license) => {
    setEditTarget(license);
    setCreateOpen(false);
    setForm({
      maxAccounts: String(license?.maxAccounts || 1),
      expiresAt: toDateTimeLocalValue(license?.expiresAt),
      status: String(license?.rawStatus || license?.status || "active"),
      notes: String(license?.notes || "")
    });
  };

  const closeModal = () => {
    setCreateOpen(false);
    setEditTarget(null);
  };

  const handleSubmit = async () => {
    if (submitting) return;

    const payload = {
      maxAccounts: Number(form.maxAccounts),
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : "",
      notes: form.notes
    };

    if (!editTarget) {
      if (!payload.maxAccounts || payload.maxAccounts < 1) {
        showToast?.("maxAccounts must be at least 1", "error");
        return;
      }
      if (!payload.expiresAt) {
        showToast?.("expiresAt is required", "error");
        return;
      }
    }

    if (editTarget) {
      payload.status = form.status;
    }

    setSubmitting(true);
    try {
      if (editTarget) {
        await adminUpdateLicense(editTarget._id, payload);
        showToast?.("License updated", "success");
      } else {
        await adminCreateLicense(payload);
        showToast?.("License created", "success");
      }
      closeModal();
      await loadLicenses();
    } catch (submitError) {
      const message =
        submitError?.response?.data?.message ||
        submitError?.message ||
        "Failed to save license";
      showToast?.(message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStatus = async (license) => {
    try {
      const nextStatus = String(license?.rawStatus || license?.status) === "revoked"
        ? "active"
        : "revoked";
      await adminUpdateLicense(license._id, { status: nextStatus });
      showToast?.(`License ${nextStatus === "active" ? "activated" : "revoked"}`, "success");
      await loadLicenses();
    } catch (toggleError) {
      showToast?.(
        toggleError?.response?.data?.message || toggleError?.message || "Failed to update license",
        "error"
      );
    }
  };

  const handleCopy = async (license) => {
    const revealed = Boolean(revealById[license._id]);
    if (!revealed) {
      showToast?.("Reveal key first to copy", "error");
      return;
    }

    try {
      const copied = await copyToClipboard(license?.key || "");
      if (!copied) throw new Error("Copy command failed");
      showToast?.("License key copied", "success");
    } catch {
      showToast?.("Failed to copy license key", "error");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">Admin Licenses</h1>
          <p className="mt-1 text-sm text-white/70">Create, revoke, and edit account limits/expiry.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={loadLicenses}
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
            Create License
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-red-800 bg-card p-4">
        <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <input
            value={q}
            onChange={(event) => {
              setPage(1);
              setQ(event.target.value);
            }}
            placeholder="Search key or notes"
            className="rounded-lg border border-red-800 bg-red-950 px-3 py-2 text-sm outline-none focus:border-red-500"
          />
          <select
            value={status}
            onChange={(event) => {
              setPage(1);
              setStatus(event.target.value);
            }}
            className="rounded-lg border border-red-800 bg-red-950 px-3 py-2 text-sm outline-none focus:border-red-500"
          >
            <option value="all">all</option>
            <option value="active">active</option>
            <option value="expired">expired</option>
            <option value="revoked">revoked</option>
          </select>
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
                <th className="px-2 py-2 font-semibold">Key</th>
                <th className="px-2 py-2 font-semibold">Max</th>
                <th className="px-2 py-2 font-semibold">Expires At</th>
                <th className="px-2 py-2 font-semibold">Status</th>
                <th className="px-2 py-2 font-semibold">Created</th>
                <th className="px-2 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-white/65">Loading licenses...</td>
                </tr>
              ) : null}

              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-white/65">No licenses found.</td>
                </tr>
              ) : null}

              {!loading &&
                items.map((license) => {
                  const revealed = Boolean(revealById[license._id]);
                  const displayKey = revealed
                    ? String(license.key || "")
                    : String(license.keyMasked || maskKey(license.key));
                  const isRevoked = String(license.rawStatus || license.status) === "revoked";

                  return (
                    <tr key={license._id} className="border-b border-red-900/40">
                      <td className="px-2 py-3 font-mono text-xs">
                        <div className="flex items-center gap-2">
                          <span>{displayKey}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setRevealById((prev) => ({ ...prev, [license._id]: !revealed }))
                            }
                            className="rounded border border-red-700/80 px-2 py-1 text-[11px]"
                          >
                            {revealed ? (
                              <span className="inline-flex items-center gap-1">
                                <EyeOff size={12} />
                                Hide
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1">
                                <Eye size={12} />
                                Reveal
                              </span>
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="px-2 py-3">{license.maxAccounts}</td>
                      <td className="px-2 py-3">{new Date(license.expiresAt).toLocaleString()}</td>
                      <td className="px-2 py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            license.status === "active"
                              ? "border border-green-500/40 bg-green-900/25 text-green-200"
                              : license.status === "expired"
                                ? "border border-yellow-500/40 bg-yellow-900/20 text-yellow-100"
                                : "border border-red-500/40 bg-red-900/25 text-red-100"
                          }`}
                        >
                          {license.status}
                        </span>
                      </td>
                      <td className="px-2 py-3">{new Date(license.createdAt).toLocaleString()}</td>
                      <td className="px-2 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            title="Copy key"
                            onClick={() => handleCopy(license)}
                            disabled={!revealed}
                            className="inline-flex items-center gap-1 rounded border border-cyan-500/40 px-2 py-1 text-xs text-cyan-100 disabled:opacity-50"
                          >
                            <Copy size={12} />
                            Copy
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(license)}
                            className="rounded border border-red-600/70 px-2 py-1 text-xs"
                          >
                            {isRevoked ? "Activate" : "Revoke"}
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditModal(license)}
                            className="rounded border border-white/30 px-2 py-1 text-xs"
                          >
                            Edit
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
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

      <LicenseModal
        open={createOpen || Boolean(editTarget)}
        mode={editTarget ? "edit" : "create"}
        form={form}
        submitting={submitting}
        onClose={closeModal}
        onChange={(field, value) => setForm((prev) => ({ ...prev, [field]: value }))}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
