/**
 * Sandboxed renderer preload.
 *
 * The Console no longer has a credential, so there is nothing to expose to the
 * renderer: the former `window.pdCompanion.configureConsoleToken /
 * getConsoleToken / clearConsoleToken` bridge is gone. The file is kept because
 * the packaged-app verification requires the compiled preload artifact to
 * exist; it intentionally exposes no API.
 */
export {};
