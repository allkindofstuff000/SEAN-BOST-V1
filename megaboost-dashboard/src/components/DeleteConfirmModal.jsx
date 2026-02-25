import { AlertTriangle, LoaderCircle, X } from "lucide-react";

export default function DeleteConfirmModal({ account, pending = false, onConfirm, onCancel }) {
  if (!account) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50">
      <div className="bg-card w-96 p-6 rounded-xl border border-red-800 shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2 text-red-400">
            <AlertTriangle size={18} />
            Confirm Delete
          </h2>

          <button onClick={onCancel} disabled={pending} className="disabled:opacity-50 disabled:cursor-not-allowed">
            <X size={18} />
          </button>
        </div>

        <p className="text-sm opacity-80 mb-6">
          Are you sure you want to delete account:
          <span className="font-semibold block mt-2">{account.email}</span>
        </p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={pending}
            className="bg-gray-600 px-4 py-2 rounded-lg text-sm hover:scale-105 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>

          <button
            onClick={() => onConfirm(account._id)}
            disabled={pending}
            className="bg-red-600 px-4 py-2 rounded-lg text-sm hover:scale-105 transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {pending ? <LoaderCircle size={14} className="animate-spin" /> : null}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
