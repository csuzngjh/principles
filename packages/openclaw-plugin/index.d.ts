import type { OpenClawPluginApi } from './openclaw-sdk.js';
declare const plugin: {
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
};
export default plugin;
