// claudebox-panel configuration
// Edit this file to add/remove file browser paths and health check services

const HOME = process.env.HOME || '/home/ted';

module.exports = {
  port: 3003,

  // CORS allowed origins
  allowedOrigins: ['https://panel.claudebox.me'],

  // File browser: whitelisted directories and individual files
  filePaths: [
    { label: 'prime-directive',       path: `${HOME}/repos/personal/claude-prime-directive`, type: 'dir' },
    { label: 'homelab-agent',         path: `${HOME}/repos/personal/homelab-agent`, type: 'dir' },
    { label: 'claudebox-panel',       path: `${HOME}/repos/personal/claudebox-panel`, type: 'dir' },
    { label: 'scripts',               path: `${HOME}/scripts`, type: 'dir' },
    { label: 'docker',                path: `${HOME}/docker`, type: 'dir' },
    { label: 'swag-proxy-confs',      path: '/opt/appdata/swag/nginx/proxy-confs', type: 'dir' },
    { label: 'claude-desktop-config', path: `${HOME}/.config/Claude/claude_desktop_config.json`, type: 'file' },
    { label: 'pm2-dump',              path: `${HOME}/.pm2/dump.pm2`, type: 'file' },
  ],

  // Editable file extensions (others are read-only)
  editableExtensions: [
    '.md', '.sh', '.conf', '.json', '.yaml', '.yml', '.env', '.txt', '.js', '.ts'
  ],

  // Max file size to open in editor (bytes) — 512KB
  maxEditSize: 512 * 1024,

  // Health check services
  services: [
    { label: 'LibreChat',           url: 'http://127.0.0.1:3080',  link: 'https://chat.claudebox.me' },
    { label: 'Authelia',            url: 'http://127.0.0.1:9091',  link: 'https://auth.claudebox.me' },
    { label: 'Grafana',             url: 'http://10.10.1.9:3000',  link: 'https://grafana.claudebox.me' },
    { label: 'Netdata (claudebox)', url: 'http://127.0.0.1:19999', link: 'https://netdata.claudebox.me' },
    { label: 'Netdata (atlas)',     url: 'http://10.10.1.9:19998', link: null },
    { label: 'cui',                 url: 'http://127.0.0.1:3001',  link: 'https://cui.claudebox.me' },
    { label: 'qmd',                 url: 'http://127.0.0.1:8181',  link: null },
    { label: 'NFS mount',           url: null, mountpoint: '/mnt/atlas/claudebox', link: null },
  ],

  // Health check interval (ms)
  healthCheckInterval: 30000,
};
