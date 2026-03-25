import type { OpenClawPluginApi, OpenClawPluginHttpRouteParams } from '../openclaw-sdk.js';
/**
 * Create routes for Principles Console.
 * Returns an array of routes:
 * 1. Static files route (no auth required for HTML/CSS/JS)
 * 2. API route (gateway auth required)
 */
export declare function createPrinciplesConsoleRoutes(api: OpenClawPluginApi): OpenClawPluginHttpRouteParams[];
export declare function createPrinciplesConsoleRoute(api: OpenClawPluginApi): OpenClawPluginHttpRouteParams;
