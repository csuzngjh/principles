import type { OpenClawPluginApi } from './openclaw-sdk.js';
declare const plugin: {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
};
export default plugin;
