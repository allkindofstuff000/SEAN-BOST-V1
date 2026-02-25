import { useEffect } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import Navbar from "./components/NavbarV2";
import SystemStatusBar from "./components/SystemStatusBar";
import ProtectedRoute from "./components/ProtectedRoute";
import AdminRoute from "./components/AdminRoute";
import { AccountsProvider } from "./context/AccountsContext";

import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import Settings from "./pages/Settings";
import AccountList from "./pages/AccountLIst";
import AddAccount from "./pages/AddAccount";
import EditAccount from "./pages/EditAccount";
import BumpingSettings from "./pages/BumpingSettings";
import AccountDetails from "./pages/AccountDetails";
import ActivityLogs from "./pages/ActivityLogs";
import AdminOverview from "./pages/AdminOverview";
import AdminLicenses from "./pages/AdminLicenses";
import AdminUsers from "./pages/AdminUsers";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";

const BUILD_MARKER_TIME = new Date().toISOString();

function AppShell() {
  useEffect(() => {
    console.log("MEGABOOSTV1 build", BUILD_MARKER_TIME);
  }, []);

  return (
    <div className="w-full min-h-screen flex flex-col">
      <Navbar />
      <SystemStatusBar />

      <main className="w-full flex-1">
        <div className="mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6">
          <Outlet />
        </div>
      </main>

      <footer className="w-full px-4 pb-4 text-center text-[11px] opacity-60">
        MEGABOOSTV1 build {BUILD_MARKER_TIME}
      </footer>
    </div>
  );
}

function ProtectedApp() {
  return (
    <AccountsProvider>
      <AppShell />
    </AccountsProvider>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<ProtectedApp />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/add" element={<Navigate to="/accounts/add" replace />} />

          <Route path="/accounts" element={<Accounts />}>
            <Route index element={<Navigate to="list" replace />} />
            <Route path="list" element={<AccountList />} />
            <Route path="add" element={<AddAccount />} />
            <Route path=":id/edit" element={<EditAccount />} />
            <Route path="details/:id" element={<AccountDetails />} />
            <Route path="bumping" element={<BumpingSettings />} />
          </Route>

          <Route path="/dashboard/accounts/:id/edit" element={<EditAccount />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/activity" element={<ActivityLogs />} />

          <Route element={<AdminRoute />}>
            <Route path="/admin" element={<AdminOverview />} />
            <Route path="/admin/licenses" element={<AdminLicenses />} />
            <Route path="/admin/users" element={<AdminUsers />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default App;
