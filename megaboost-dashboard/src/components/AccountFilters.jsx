import { Search, Filter, X } from "lucide-react";
import { useState } from "react";

export default function AccountFilters() {
  const [status, setStatus] = useState("all");

  return (
    <div className="bg-card p-6 rounded-xl border border-red-800 mb-6">
      
      <div className="grid grid-cols-3 gap-6 items-end">

        {/* Search */}
        <div>
          <label className="block text-sm mb-2 opacity-70">
            Search Accounts
          </label>
          <div className="flex items-center bg-red-950 rounded-lg px-3 py-2">
            <Search size={16} className="opacity-50 mr-2" />
            <input
              type="text"
              placeholder="Search by email..."
              className="bg-transparent outline-none w-full text-sm"
            />
          </div>
        </div>

        {/* Filter */}
        <div>
          <label className="block text-sm mb-2 opacity-70">
            Filter by Status
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full bg-red-950 px-3 py-2 rounded-lg text-sm outline-none"
          >
            <option value="all">All Statuses</option>
            <option value="running">Running</option>
            <option value="stopped">Stopped</option>
            <option value="paused">Paused</option>
            <option value="crashed">Crashed</option>
            <option value="needs2fa">Awaiting 2FA</option>
          </select>
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <button className="flex items-center gap-2 bg-accent px-4 py-2 rounded-lg text-sm hover:scale-105 transition">
            <Filter size={16} />
            Filter
          </button>

          <button className="flex items-center gap-2 bg-gray-600 px-4 py-2 rounded-lg text-sm hover:scale-105 transition">
            <X size={16} />
            Clear
          </button>
        </div>

      </div>
    </div>
  );
}
