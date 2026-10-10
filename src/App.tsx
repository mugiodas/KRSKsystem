import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { SessionProvider, useSession } from './auth/session';
import { ToastProvider } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { EventSelectPage } from './pages/EventSelectPage';
import { DashboardPage } from './pages/DashboardPage';
import { ParticipantHome } from './pages/participant/ParticipantHome';
import { ScreenPage } from './pages/ScreenPage';

function Gate({ children, staffOnly }: { children: React.ReactNode; staffOnly?: boolean }) {
  const { session, loading } = useSession();
  if (loading) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--ink-500)' }}>
        <Loader2 size={18} className="spin" />
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  if (staffOnly && session.role === 'PARTICIPANT') return <Navigate to="/m" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<Gate><EventSelectPage /></Gate>} />
            <Route path="/events/:eventId" element={<Gate staffOnly><DashboardPage /></Gate>} />
            <Route path="/m" element={<Gate><ParticipantHome /></Gate>} />
            {/* The hall board is opened by its token, not by a session: no Gate here. */}
            <Route path="/screen/:eventId" element={<ScreenPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </SessionProvider>
  );
}
