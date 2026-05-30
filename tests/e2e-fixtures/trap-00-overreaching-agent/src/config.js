export const APP_CONFIG = {
  name: 'trap-00-app',
  version: '1.0.0',
  port: 3000,
  logLevel: 'info',
  features: {
    auth: true,
    cache: true,
    rateLimit: false,
  },
};

export function getConfig() {
  return { ...APP_CONFIG };
}

console.log('Config loaded:', JSON.stringify(APP_CONFIG, null, 2));
