import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hexagon } from 'lucide-react';
import { useI18n } from '../i18n/ui';
import { useAuth } from '../context/auth';

export function LoginPage() {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError(t('auth.errorEmpty'));
      return;
    }
    setLoading(true);
    setError('');
    const success = await login(token.trim());
    setLoading(false);
    if (success) {
      navigate('/overview');
    } else {
      setError(t('auth.errorInvalid'));
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <div className="login-logo">
            <span className="logo-icon">
              <Hexagon strokeWidth={1.5} />
            </span>
            <h1>{t('brand.title')}</h1>
          </div>
          <p className="login-subtitle">{t('auth.loginSubtitle')}</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="token">Gateway Token</label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('auth.tokenPlaceholder')}
              autoComplete="off"
            />
            <span className="form-hint">
              {t('auth.tokenHint')}
            </span>
          </div>

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="login-button" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner-small"></span>
                {t('auth.validatingButton')}
              </>
            ) : (
              t('auth.loginButton')
            )}
          </button>
        </form>

        <div className="login-footer">
          <h4>{t('auth.howToGetToken')}</h4>
          <ol>
            <li>{t('auth.step1')}</li>
            <li>{t('auth.step2')}</li>
            <li>{t('auth.step3')}</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

// Protected Route
