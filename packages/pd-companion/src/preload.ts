import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pdCompanion', {
  configureConsoleToken: (token: string): Promise<boolean> => ipcRenderer.invoke('pd-companion:configure-console-token', token),
});
