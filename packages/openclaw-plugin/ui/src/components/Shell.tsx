import React from 'react';
import { NavLink } from 'react-router-dom';
import { Hexagon, BarChart3, GitBranch, FileCheck, Brain, Radio, Lock, Download, LogOut, Moon, Sun } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n/ui';
import { useAuth } from '../context/auth';
import { useTheme } from '../context/theme';

export function Shell({ children }: { children: React.ReactNode }) {
  const { logout, token } = useAuth();
  const { t } = useI18n();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">跳过导航，直接访问内容</a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <span className="logo-icon">
              <Hexagon strokeWidth={1.5} />
            </span>
          </div>
          <span className="eyebrow">{t('brand.title')}</span>
          <h1>{t('brand.title')}</h1>
          <p>{t('brand.subtitle')}</p>
        </div>
        <nav className="nav">
          <NavLink to="/overview" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <BarChart3 strokeWidth={1.75} />
            </span>
            <span>{t('nav.overview')}</span>
          </NavLink>
          <NavLink to="/evolution" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <GitBranch strokeWidth={1.75} />
            </span>
            <span>{t('nav.evolution')}</span>
          </NavLink>
          <NavLink to="/samples" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <FileCheck strokeWidth={1.75} />
            </span>
            <span>{t('nav.samples')}</span>
          </NavLink>
          <NavLink to="/thinking-models" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <Brain strokeWidth={1.75} />
            </span>
            <span>{t('nav.thinkingModels')}</span>
          </NavLink>
          <NavLink to="/feedback" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <Radio strokeWidth={1.75} />
            </span>
            <span>{t('nav.feedback')}</span>
          </NavLink>
          <NavLink to="/gate" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <Lock strokeWidth={1.75} />
            </span>
            <span>{t('nav.gateMonitor')}</span>
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <a className="export-link" href={api.exportCorrections('redacted')}>
            <span className="nav-icon">
              <Download strokeWidth={1.75} />
            </span>
            <span>{t('nav.exportSamples')}</span>
          </a>
          <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <span className="nav-icon">
              {theme === 'dark' ? <Sun strokeWidth={1.75} /> : <Moon strokeWidth={1.75} />}
            </span>
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
          <button className="logout-button" onClick={logout}>
            <span className="nav-icon">
              <LogOut strokeWidth={1.75} />
            </span>
            <span>{t('nav.logout')}</span>
          </button>
        </div>
      </aside>
      <main className="content" id="main-content">{children}</main>
    </div>
  );
}

