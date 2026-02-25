import { Play, Square } from "lucide-react";

export default function BulkOperations() {
  return (
    <div className="bg-card themeBorder p-6 rounded-xl border mb-6">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold">Bulk Operations</h2>

        <div className="flex items-center gap-6">
          <div className="flex gap-3">
            <button className="themeBtnAccent flex items-center gap-2 px-4 py-2 text-sm">
              <Play size={16} />
              Start All
            </button>

            <button className="themeBtnMuted flex items-center gap-2 px-4 py-2 text-sm">
              <Square size={16} />
              Stop All
            </button>
          </div>

          <div className="flex gap-4 text-sm opacity-80">
            <span className="text-green-400">Running 0</span>
            <span className="text-gray-400">Stopped 4</span>
            <span className="text-red-400">Crashed 1</span>
          </div>
        </div>
      </div>
    </div>
  );
}
