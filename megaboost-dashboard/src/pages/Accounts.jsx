import { NavLink, Outlet } from "react-router-dom";

export default function Accounts() {
  const tabs = [
    { to: "list", label: "Account List" },
    { to: "bumping", label: "Bumping Settings" },
    { to: "add", label: "Add Account" }
  ];

  return (
    <div className="pageShell">
      <nav className="themeTabBar" aria-label="Accounts tabs">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) => `themeTab ${isActive ? "is-active" : ""}`}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <div className="pageInner">
        <Outlet />
      </div>
    </div>
  );
}
