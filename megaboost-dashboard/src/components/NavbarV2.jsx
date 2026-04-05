import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Settings,
  KeyRound,
  UserCircle,
  FileText,
  Menu,
  X,
  LogOut,
  Shield
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useAccounts } from "../context/AccountsContext";
import { useLanguage } from "../context/LanguageContext";
import "./NavbarV2.css";

function formatExpiry(dateValue) {
  if (!dateValue) return "No expiry";
  const date = new Date(dateValue);
  if (Number.isNaN(date.valueOf())) return "No expiry";
  return date.toLocaleDateString();
}

function getLicensePresentation(licenseInfo, isAdmin) {
  if (isAdmin) {
    return {
      label: "Admin",
      expires: "Unlimited",
      className: "licensePillNeutral"
    };
  }

  const status = String(licenseInfo?.status || "no_license").toLowerCase();

  if (status === "active") {
    return {
      label: "Active License",
      expires: formatExpiry(licenseInfo?.expiresAt),
      className: "licensePillActive"
    };
  }

  if (status === "expired") {
    return {
      label: "Expired License",
      expires: formatExpiry(licenseInfo?.expiresAt),
      className: "licensePillDanger"
    };
  }

  if (status === "revoked") {
    return {
      label: "Revoked License",
      expires: formatExpiry(licenseInfo?.expiresAt),
      className: "licensePillDanger"
    };
  }

  return {
    label: "No License",
    expires: "Assign required",
    className: "licensePillWarning"
  };
}

/* Orange pulse/waveform SVG icon */
function PulseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="pulseIcon">
      <path
        d="M2 12h3l2-6 3 12 3-8 2 4h3l2-4"
        stroke="#f5a623"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function NavbarV2() {
  const location = useLocation();
  const navigate = useNavigate();
  const wrapperRef = useRef(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const { user, isAdmin, logout } = useAuth();
  const { licenseInfo, showToast } = useAccounts();
  const { t, lang, setLang } = useLanguage();

  const license = useMemo(
    () => getLicensePresentation(licenseInfo, isAdmin),
    [isAdmin, licenseInfo]
  );

  const isActive = (path) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  const linkStyle = (path) =>
    `navLinkNeon flex items-center gap-2 transition ${isActive(path) ? "navLinkNeonActive" : ""}`;

  const closeMobileMenu = () => {
    setMobileOpen(false);
  };

  const handleLogout = async () => {
    if (loggingOut) return;

    setLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } catch (error) {
      showToast?.(error?.message || "Logout failed", "error");
    } finally {
      setLoggingOut(false);
      setMobileOpen(false);
    }
  };

  useEffect(() => {
    if (!mobileOpen) return undefined;

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
      }
    };

    const handleClickOutside = (event) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target)) {
        setMobileOpen(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [mobileOpen]);

  return (
    <header ref={wrapperRef} className="navbarNeon">
      <div className="navInner">
        <div className="navLeft">
          <Link to="/" className="brandWrap" onClick={closeMobileMenu}>
            <PulseIcon />
            <span className="brandText brandTextFull">SEANBOOST</span>
            <span className="brandText brandTextShort">MB1</span>
          </Link>

          <nav className="navDesktop text-sm font-medium items-center">
            <Link to="/" className={linkStyle("/")}>
              <LayoutDashboard size={16} />
              {t('nav.dashboard')}
            </Link>

            <Link to="/accounts/list" className={linkStyle("/accounts")}>
              <Users size={16} />
              {t('nav.accounts')}
            </Link>

            <Link to="/settings" className={linkStyle("/settings")}>
              <Settings size={16} />
              {t('nav.settings')}
            </Link>

            <Link to="/activity" className={linkStyle("/activity")}>
              <FileText size={16} />
              {t('nav.activityLogs')}
            </Link>

            {isAdmin ? (
              <Link to="/admin" className={linkStyle("/admin")}>
                <Shield size={16} />
                {t('nav.admin')}
              </Link>
            ) : null}
          </nav>
        </div>

        <div className="navRight">
          <div className="navDesktopPills flex items-center gap-4 text-sm">
            <div className="langToggle flex items-center gap-1 text-sm">
              <button type="button" onClick={() => setLang("en")} className={`langBtn ${lang === "en" ? "langActive" : ""}`}>EN</button>
              <span style={{ color: "var(--subtle)" }}>|</span>
              <button type="button" onClick={() => setLang("es")} className={`langBtn ${lang === "es" ? "langActive" : ""}`}>ES</button>
            </div>

            <div className={`licensePill ${license.className} flex items-center gap-2 px-3 py-1 rounded-full`}>
              <KeyRound size={14} />
              {license.label}
            </div>

            <span className="text-sm" style={{ color: "var(--muted)" }}>{t('dashboard.expires')}: {license.expires}</span>

            <div className="userPill flex items-center gap-2 px-3 py-1 rounded-full">
              <UserCircle size={16} />
              {user?.username || "User"}
            </div>

            <button
              type="button"
              className="logoutBtn"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              <LogOut size={14} />
              {loggingOut ? t('nav.loggingOut') : t('nav.logout')}
            </button>
          </div>

          <button
            type="button"
            className={`hamburgerBtn ${mobileOpen ? "" : "hamburgerPulse"}`}
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-menu"
            onClick={() => setMobileOpen((prev) => !prev)}
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      <div
        id="mobile-nav-menu"
        className={`mobileMenu ${mobileOpen ? "mobileMenuOpen" : ""}`}
      >
        <nav className="mobileNavList">
          <Link to="/" className={linkStyle("/")} onClick={closeMobileMenu}>
            <LayoutDashboard size={18} />
            {t('nav.dashboard')}
          </Link>

          <Link to="/accounts/list" className={linkStyle("/accounts")} onClick={closeMobileMenu}>
            <Users size={18} />
            {t('nav.accounts')}
          </Link>

          <Link to="/settings" className={linkStyle("/settings")} onClick={closeMobileMenu}>
            <Settings size={18} />
            {t('nav.settings')}
          </Link>

          <Link to="/activity" className={linkStyle("/activity")} onClick={closeMobileMenu}>
            <FileText size={18} />
            {t('nav.activityLogs')}
          </Link>

          {isAdmin ? (
            <Link to="/admin" className={linkStyle("/admin")} onClick={closeMobileMenu}>
              <Shield size={18} />
              {t('nav.admin')}
            </Link>
          ) : null}
        </nav>

        <div className="mobileMeta">
          <div className="langToggle flex items-center gap-1 text-sm">
            <button type="button" onClick={() => setLang("en")} className={`langBtn ${lang === "en" ? "langActive" : ""}`}>EN</button>
            <span style={{ color: "var(--subtle)" }}>|</span>
            <button type="button" onClick={() => setLang("es")} className={`langBtn ${lang === "es" ? "langActive" : ""}`}>ES</button>
          </div>

          <div className={`licensePill ${license.className} flex items-center gap-2 px-3 py-2 rounded-full w-fit`}>
            <KeyRound size={16} />
            {license.label}
          </div>

          <div className="text-sm" style={{ color: "var(--muted)" }}>{t('dashboard.expires')}: {license.expires}</div>

          <div className="userPill flex items-center gap-2 px-3 py-2 rounded-full w-fit">
            <UserCircle size={18} />
            {user?.username || "User"}
          </div>

          <button
            type="button"
            className="logoutBtn w-fit"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            <LogOut size={15} />
            {loggingOut ? t('nav.loggingOut') : t('nav.logout')}
          </button>
        </div>
      </div>
    </header>
  );
}
