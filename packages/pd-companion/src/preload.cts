import { contextBridge, ipcRenderer } from 'electron';

interface ConsoleTokenConfigurationResult {
  persisted: boolean;
  restartRequested: boolean;
  reason?: string;
  nextAction?: string;
}

interface ConsoleTokenStatus {
  available: boolean;
  token?: string;
}

interface ConsoleTokenClearResult {
  cleared: boolean;
  restartRequested: boolean;
  reason?: string;
  nextAction?: string;
}

contextBridge.exposeInMainWorld('pdCompanion', {
  configureConsoleToken: (token: string): Promise<ConsoleTokenConfigurationResult> => ipcRenderer.invoke('pd-companion:configure-console-token', token),
  getConsoleToken: (): Promise<ConsoleTokenStatus> => ipcRenderer.invoke('pd-companion:get-console-token'),
  clearConsoleToken: (): Promise<ConsoleTokenClearResult> => ipcRenderer.invoke('pd-companion:clear-console-token'),
});
