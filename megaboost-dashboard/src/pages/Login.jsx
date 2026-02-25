import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { KeyRound, LogIn } from "lucide-react";
import { useAuth } from "../context/AuthContext";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated, loading } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!loading && isAuthenticated) {
    const redirectTo = location.state?.from?.pathname || "/";
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError("");

    try {
      await login({ identifier, password });
      const redirectTo = location.state?.from?.pathname || "/";
      navigate(redirectTo, { replace: true });
    } catch (loginError) {
      const message =
        loginError?.response?.data?.message ||
        loginError?.message ||
        "Login failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full px-4 py-8">
      <div className="mx-auto mt-16 w-full max-w-md rounded-2xl border border-red-800 bg-card p-6 shadow-[0_0_26px_rgba(255,59,59,0.14)]">
        <div className="mb-6 flex items-center gap-2">
          <KeyRound size={20} className="text-red-300" />
          <h1 className="text-xl font-semibold">MEGABOOSTV1 Login</h1>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm opacity-80">Email or Username</label>
            <input
              type="text"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
              autoComplete="username"
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm opacity-80">Password</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none focus:border-red-500"
              autoComplete="current-password"
              required
            />
          </div>

          {error ? (
            <div className="rounded-lg border border-red-700 bg-red-950/80 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold disabled:opacity-60"
          >
            <LogIn size={16} />
            {submitting ? "Signing in..." : "Login"}
          </button>
        </form>
      </div>
    </div>
  );
}
