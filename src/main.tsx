import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { AdminShell } from './components/AdminShell';
import { Header } from './components/Layout';
import AdminDashboard from './pages/AdminDashboard';
import AdminLogin from './pages/AdminLogin';
import SubmitTicket from './pages/SubmitTicket';
import TicketDetail from './pages/TicketDetail';
import './index.css';

function NotFound() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <Link to="/" className="btn-secondary mt-6">
          Go to the support portal
        </Link>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SubmitTicket />} />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminShell><AdminDashboard /></AdminShell>} />
        <Route path="/admin/tickets/:id" element={<AdminShell><TicketDetail /></AdminShell>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
