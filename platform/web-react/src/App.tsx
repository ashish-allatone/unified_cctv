import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { I18nProvider } from "./lib/i18n";
import { WsProvider } from "./lib/ws";
import { Toasts } from "./lib/toast";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import LegacyView from "./pages/LegacyView";
import Notifications from "./pages/Notifications";
import AdminLayout from "./pages/admin/AdminLayout";
import Permissions from "./pages/admin/Permissions";
import Users from "./pages/admin/Users";
import Roles from "./pages/admin/Roles";
import Archival from "./pages/admin/Archival";
import Dpdp from "./pages/admin/Dpdp";
import NotifyAdmin from "./pages/admin/NotifyAdmin";
import ApiKeysAdmin from "./pages/admin/ApiKeysAdmin";
import AdminLegacy from "./pages/admin/AdminLegacy";

function Shell() {
  const { session } = useAuth();
  if (!session) return <Login />;
  return (
    <WsProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="permissions" replace />} />
            <Route path="permissions" element={<Permissions />} />
            <Route path="users" element={<Users />} />
            <Route path="roles" element={<Roles />} />
            <Route path="archival" element={<Archival />} />
            <Route path="dpdp" element={<Dpdp />} />
            <Route path="notify" element={<NotifyAdmin />} />
            <Route path="keys" element={<ApiKeysAdmin />} />
            <Route path=":section" element={<AdminLegacy />} />
          </Route>
          <Route path=":view" element={<LegacyView />} />
        </Route>
      </Routes>
    </WsProvider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <Shell />
        <Toasts />
      </AuthProvider>
    </I18nProvider>
  );
}
