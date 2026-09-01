import { contextBridge, ipcRenderer } from 'electron';

interface ConsoleTokenConfigurationResult {
  persisted: boolean;
  restartRequested: boolean;
  reason?: string;
  nextAction?: string;
}

contextBridge.exposeInMainWorld('pdCompanion', {
  configureConsoleToken: (token: string): Promise<ConsoleTokenConfigurationResult> => ipcRenderer.invoke('pd-companion:configure-console-token', token),
});
