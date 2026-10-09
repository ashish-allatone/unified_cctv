import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { I18nProvider } from "./lib/i18n";
import { WsProvider } from "./lib/ws";
import { Toasts } from "./lib/toast";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import LegacyView from "./pages/LegacyView";
import Notifications from "./pages/Notifications";
import Alerts from "./pages/Alerts";
import AuditLog from "./pages/AuditLog";
import Sources from "./pages/Sources";
import UploadRecognise from "./pages/UploadRecognise";
import Watchlist from "./pages/Watchlist";
import Violations from "./pages/Violations";
import Cases from "./pages/Cases";
import Playback from "./pages/Playback";
import Multicam from "./pages/Multicam";
import Movement from "./pages/Movement";
import Search from "./pages/Search";
import Counts from "./pages/Counts";
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
          <Route path="alerts" element={<Alerts />} />
          <Route path="alerts/:section" element={<Alerts />} />
          <Route path="counts" element={<Counts />} />
          <Route path="counts/:section" element={<Counts />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="sources" element={<Sources />} />
          <Route path="sources/:section" element={<Sources />} />
          <Route path="upload" element={<UploadRecognise />} />
          <Route path="upload/:section" element={<UploadRecognise />} />
          <Route path="watchlist" element={<Watchlist />} />
          <Route path="watchlist/:section" element={<Watchlist />} />
          <Route path="violations" element={<Violations />} />
          <Route path="violations/:section" element={<Violations />} />
          <Route path="cases" element={<Cases />} />
          <Route path="cases/:section" element={<Cases />} />
          <Route path="playback" element={<Playback />} />
          <Route path="playback/:section" element={<Playback />} />
          <Route path="multicam" element={<Multicam />} />
          <Route path="multicam/:section" element={<Multicam />} />
          <Route path="movement" element={<Movement />} />
          <Route path="movement/:section" element={<Movement />} />
          <Route path="search" element={<Search />} />
          <Route path="search/:section" element={<Search />} />
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
