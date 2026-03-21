// claudebox-panel configuration
// Edit this file to add/remove file browser paths and health check services

const os = require('os');
const path = require('path');
const HOME = process.env.HOME || '/home/ted';

module.exports = {
  port: 3003,

  // Base directory for agent project and session files
  agentsDir: `${HOME}/.claude/projects`,


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
    '.md', '.sh', '.conf', '.json', '.yaml', '.yml', '.txt', '.js', '.ts'
  ],

  // Max file size to open in editor (bytes) — 512KB
  maxEditSize: 512 * 1024,

  // Health check services
  services: [
    { label: 'LibreChat',           url: 'https://chat.claudebox.me',  link: 'https://chat.claudebox.me' },
    { label: 'Authelia',            url: 'http://127.0.0.1:9091',  link: 'https://auth.claudebox.me' },
    { label: 'Grafana',             url: 'http://10.10.1.9:3000',  link: 'https://grafana.claudebox.me' },
    { label: 'Netdata (claudebox)', url: 'http://127.0.0.1:19999', link: 'https://netdata.claudebox.me' },
    { label: 'Netdata (atlas)',     url: 'http://10.10.1.9:19998', link: null },
    { label: 'cui',                 url: 'http://127.0.0.1:3001',  link: 'https://cui.claudebox.me' },
    { label: 'CloudCLI',            url: 'http://127.0.0.1:3004',  link: 'https://cloudcli.claudebox.me' },
    { label: 'qmd',                 url: 'http://127.0.0.1:8181',  link: null },
    { label: 'NFS mount',           url: null, mountpoint: '/mnt/atlas/claudebox', link: null },
  ],

  // Health check interval (ms)
  healthCheckInterval: 30000,

  // Diagnostics system
  diagnostics: {
    // Expected Docker containers (must be running)
    expectedContainers: [
      'swag', 'authelia', 'librechat', 'librechat-mongodb', 'librechat-meilisearch',
      'librechat-backrest-mcp', 'librechat-exporter', 'librechat-grafana-mcp',
      'dockhand', 'open-notebook', 'open-notebook-surrealdb',
      'reranker', 'firecrawl-api', 'firecrawl-worker', 'firecrawl-puppeteer', 'firecrawl-redis',
      'searxng', 'searxng-valkey',
      'jobsearch-mcp', 'jobsearch-postgres', 'jobsearch-qdrant',
    ],

    // Expected always-on PM2 processes
    expectedPM2: ['qmd', 'cui', 'cloudcli', 'homelab-ops-mcp', 'agent-panel'],

    // NFS mounts to verify
    nfsMounts: [
      '/mnt/atlas/claudebox',
      '/mnt/atlas/dockhand/stacks',
      '/mnt/atlas/appdata/swag',
    ],

    // Ports that should be listening
    expectedPorts: [
      { port: 443,   label: 'swag' },
      { port: 3001,  label: 'cui' },
      { port: 3003,  label: 'agent-panel' },
      { port: 3004,  label: 'cloudcli' },
      { port: 8181,  label: 'qmd' },
      { port: 8282,  label: 'homelab-ops-mcp' },
      { port: 9091,  label: 'authelia' },
      { port: 9898,  label: 'backrest' },
      { port: 19999, label: 'netdata' },
    ],

    // TLS cert path (SWAG fullchain)
    tlsCertPath: '/opt/appdata/swag/etc/letsencrypt/live/claudebox.me/fullchain.pem',

    // Deep check endpoints (thorough only)
    deepChecks: [
      { label: 'LibreChat', url: 'https://chat.claudebox.me/', expectStatus: 200 },
      { label: 'Authelia', url: 'http://127.0.0.1:9091/', expectStatus: 200 },
      { label: 'qmd', url: 'http://127.0.0.1:8181/health', expectStatus: 200 },
      { label: 'Reranker', url: 'http://127.0.0.1:8787/health', expectStatus: 200 },
    ],

    // Git repos to check for dirty state
    gitRepos: [
      { label: 'prime-directive', path: `${HOME}/repos/personal/claude-prime-directive` },
      { label: 'homelab-agent', path: `${HOME}/repos/personal/homelab-agent` },
      { label: 'claudebox-panel', path: `${HOME}/repos/personal/claudebox-panel` },
      { label: 'claudebox-deploy', path: `${HOME}/repos/personal/claudebox-deploy` },
    ],

    // Cross-host connectivity targets
    pingHosts: [
      { label: 'atlas', host: '10.10.1.9' },
      { label: 'unraid', host: '10.10.1.6' },
    ],

    // DNS domains to resolve
    dnsChecks: ['claudebox.me', 'glitch42.com', 'google.com'],

    // ntfy endpoint for failure alerts — set NTFY_URL in .env
    ntfyUrl: process.env.NTFY_URL || null,
  },

  // Dependency updates section
  depUpdates: {
    jsonPath: path.join(os.homedir(), '.local/share/logs/dep-updates-latest.json'),
    auditLogPath: path.join(os.homedir(), '.local/share/logs/update-audit.jsonl'),
    checkScript: path.join(os.homedir(), 'scripts/check-dep-updates.sh'),
    cloudcliBaseUrl: 'http://127.0.0.1:3004',
    depUpdatesProject: path.join(os.homedir(), '.claude/projects/dep-updates'),

    // Only these packages can be updated via one-click safe update.
    // Do NOT add @tobilu/qmd here — it requires a post-install mcp.js patch and PM2
    // restart that one-click can't handle. It delegates to the CloudCLI agent instead.
    safeUpdateCommands: {
      'memsearch':                  'pip install "memsearch[local]" --upgrade --break-system-packages',
      'cui-server':                 'npm install -g cui-server',
      '@anthropic-ai/claude-code':  'claude update',
      'pm2':                        'npm install -g pm2 --prefix /usr/local',
    },

    // Pinned dependencies — never one-click updated
    pinned: {
      'authelia/authelia': { version: '4.38', reason: 'Breaking config changes in 4.39+' },
      'nodejs':            { version: '22.x', reason: 'System Node managed via nvm/apt, not auto-updated' },
    },
  },
};
