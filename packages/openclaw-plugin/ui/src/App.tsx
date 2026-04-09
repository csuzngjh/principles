import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/auth';
import { ThemeProvider } from './context/theme';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { SamplesPage } from './pages/SamplesPage';
import { ThinkingModelsPage } from './pages/ThinkingModelsPage';
import { EvolutionPage } from './pages/EvolutionPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { GateMonitorPage } from './pages/GateMonitorPage';

function AppRoutes() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/evolution" element={<EvolutionPage />} />
        <Route path="/samples" element={<SamplesPage />} />
        <Route path="/thinking-models" element={<ThinkingModelsPage />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="/gate" element={<GateMonitorPage />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/plugins/principles">
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/*" element={<ProtectedRoute><AppRoutes /></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
