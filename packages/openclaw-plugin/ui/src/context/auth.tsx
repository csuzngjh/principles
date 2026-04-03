import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getGatewayToken, setGatewayToken, clearGatewayToken } from '../api';
import { api } from '../api';

interface AuthContextType {
  isAuthenticated: boolean;
  token: string | null;
  login: (token: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getGatewayToken());
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const savedToken = getGatewayToken();
      if (savedToken) {
        try {
          await api.getOverview();
          setIsAuthenticated(true);
        } catch {
          setIsAuthenticated(false);
        }
      }
      setIsChecking(false);
    };
    checkAuth();
  }, []);

  const login = useCallback(async (newToken: string): Promise<boolean> => {
    setGatewayToken(newToken);
    setTokenState(newToken);
    try {
      await api.getOverview();
      setIsAuthenticated(true);
      return true;
    } catch {
      clearGatewayToken();
      setTokenState(null);
      setIsAuthenticated(false);
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    clearGatewayToken();
    setTokenState(null);
    setIsAuthenticated(false);
  }, []);

  if (isChecking) {
    return (
      <div className="auth-checking">
        <div className="auth-checking-content">
          <div className="spinner"></div>
          <span>Checking authentication...</span>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
