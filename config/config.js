// claudebox-panel configuration
// Edit this file to add/remove file browser paths and health check services

const os = require('os');
const path = require('path');
const HOME = process.env.HOME || os.homedir();

const PANEL_ALLOWED_ORIGIN = process.env.PANEL_ALLOWED_ORIGIN || 'https://panel.yourdomain';
const CHAT_URL             = process.env.CHAT_URL             || 'https://chat.yourdomain';
const AUTH_LINK            = process.env.AUTH_LINK            || 'https://auth.yourdomain';
const GRAFANA_URL          = process.env.GRAFANA_URL          || 'http://10.10.x.x:3000';
const GRAFANA_LINK         = process.env.GRAFANA_LINK         || 'https://grafana.yourdomain';
const NETDATA_LINK         = process.env.NETDATA_LINK         || 'https://netdata.yourdomain';
const ATLAS_NETDATA_URL    = process.env.ATLAS_NETDATA_URL    || 'http://10.10.x.x:19998';
const CLOUDCLI_LINK        = process.env.CLOUDCLI_LINK        || 'https://cloudcli.yourdomain';
const ATLAS_IP             = process.env.ATLAS_IP             || '10.10.x.x';
const UNRAID_IP            = process.env.UNRAID_IP            || '10.10.x.x';
const TLS_CERT_PATH        = process.env.TLS_CERT_PATH        || '/opt/appdata/swag/etc/letsencrypt/live/yourdomain/fullchain.pem';
const DNS_CHECK_DOMAINS    = (process.env.DNS_CHECK_DOMAINS   || 'yourdomain,google.com').split(',').map(d => d.trim());

module.exports = {
  port: 3003,

  // Base directory for agent project and session files
  agentsDir: `${HOME}/.claude/projects`,


  // CORS allowed origins
  allowedOrigins: [PANEL_ALLOWED_ORIGIN],

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
    { label: 'LibreChat',           url: CHAT_URL,              link: CHAT_URL },
    { label: 'Authelia',            url: 'http://127.0.0.1:9091',  link: AUTH_LINK },
    { label: 'Grafana',             url: GRAFANA_URL,           link: GRAFANA_LINK },
    { label: 'Netdata (claudebox)', url: 'http://127.0.0.1:19999', link: NETDATA_LINK },
    { label: 'Netdata (atlas)',     url: ATLAS_NETDATA_URL,     link: null },
    { label: 'CloudCLI',            url: 'http://127.0.0.1:3004',  link: CLOUDCLI_LINK },
    { label: 'qmd',                 url: 'http://localhost:8181',  link: null },
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
      'dockhand',
      'reranker', 'firecrawl-api', 'firecrawl-worker', 'firecrawl-puppeteer', 'firecrawl-redis',
      'searxng', 'searxng-valkey',
      'jobsearch-mcp', 'jobsearch-postgres', 'jobsearch-qdrant',
    ],

    // Expected always-on PM2 processes
    expectedPM2: ['qmd', 'cloudcli', 'homelab-ops-mcp', 'agent-panel'],

    // NFS mounts to verify
    nfsMounts: [
      '/mnt/atlas/claudebox',
      '/mnt/atlas/dockhand/stacks',
      '/mnt/atlas/appdata/swag',
    ],

    // Ports that should be listening
    expectedPorts: [
      { port: 443,   label: 'swag' },
      { port: 3003,  label: 'agent-panel' },
      { port: 3004,  label: 'cloudcli' },
      { port: 8181,  label: 'qmd', host: 'localhost' },
      { port: 8282,  label: 'homelab-ops-mcp' },
      { port: 9091,  label: 'authelia' },
      { port: 9898,  label: 'backrest' },
      { port: 19999, label: 'netdata' },
    ],

    // TLS cert path (SWAG fullchain)
    tlsCertPath: TLS_CERT_PATH,

    // Deep check endpoints (thorough only)
    deepChecks: [
      { label: 'LibreChat', url: `${CHAT_URL}/`, expectStatus: 200 },
      { label: 'Authelia', url: 'http://127.0.0.1:9091/', expectStatus: 200 },
      { label: 'qmd', url: 'http://localhost:8181/mcp', expectStatus: 200 },
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
      { label: 'atlas', host: ATLAS_IP },
      { label: 'unraid', host: UNRAID_IP },
    ],

    // DNS domains to resolve
    dnsChecks: DNS_CHECK_DOMAINS,

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
    // Do NOT add @siteboon/claude-code-ui (CloudCLI) here — installed root-owned via
    // sudo npm install -g, panel cannot update without sudo.
    // Update manually: sudo npm install -g @siteboon/claude-code-ui@latest && pm2 restart cloudcli
    // Do NOT add pm2 here — installed root-owned in /usr/local, panel cannot update without sudo.
    // Update manually: sudo npm install -g pm2 --prefix /usr/local && pm2 update
    safeUpdateCommands: {
      'memsearch':                  'pip install memsearch[local] --upgrade --break-system-packages',
      '@anthropic-ai/claude-code':  'claude update',
    },

    // Pinned dependencies — never one-click updated
    pinned: {
      'authelia/authelia': { version: '4.38', reason: 'Breaking config changes in 4.39+' },
      'nodejs':            { version: '22.x', reason: 'System Node managed via nvm/apt, not auto-updated' },
    },
  },
};
