import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";

export default function NotFound() {

  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center h-[70vh] text-center">

      <AlertTriangle size={60} className="text-red-500 mb-6" />

      <h1 className="text-4xl font-bold mb-4">
        404 - Page Not Found
      </h1>

      <p className="opacity-70 mb-6">
        The page you are looking for does not exist.
      </p>

      <button
        onClick={() => navigate("/")}
        className="bg-accent px-6 py-3 rounded-lg font-medium hover:scale-105 transition"
      >
        Go Back to Dashboard
      </button>

    </div>
  );
}
