import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { KeyRound, LogIn } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated, loading } = useAuth();
  const { t } = useLanguage();
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
      <div className="themeCard mx-auto mt-16 w-full max-w-md p-6">
        <div className="mb-6 flex items-center gap-2">
          <KeyRound size={20} className="text-[var(--accent)]" />
          <h1 className="text-xl font-semibold">{t('login.title')}</h1>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm opacity-80">{t('login.emailOrUsername')}</label>
            <input
              type="text"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              className="themeField w-full rounded-lg px-3 py-2 outline-none"
              autoComplete="username"
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm opacity-80">{t('login.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="themeField w-full rounded-lg px-3 py-2 outline-none"
              autoComplete="current-password"
              required
            />
          </div>

          {error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="themeBtnAccent inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
          >
            <LogIn size={16} />
            {submitting ? t('login.signingIn') : t('login.login')}
          </button>
        </form>
      </div>
    </div>
  );
}
