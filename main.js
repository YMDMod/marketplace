'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fileURLToPath } = require('url');

const MOD_RELEASE_URL = 'https://api.github.com/repos/ymdmod/ymdmod/releases/latest';

let api = null;

function parseVersion(text) {
  const parts = String(text).split('.').map(Number);
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
}

function isNewer(candidate, installed) {
  const a = parseVersion(candidate);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

const catalog = () => api.addons.loadCatalog(api.settings.get('catalogUrl'));

function installPlan(id, entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const installed = new Map(api.addons.list().map((a) => [a.id, a]));
  const plan = [];
  const seen = new Set();
  const visit = (entryId, range, isRoot) => {
    if (seen.has(entryId)) return;
    seen.add(entryId);
    const local = installed.get(entryId);
    if (!isRoot && local && api.addons.satisfies(local.version, range)) return;
    const entry = byId.get(entryId);
    if (!entry) throw new Error(`Нужен аддон «${entryId}» ${range}, а в каталоге его нет.`);
    if (!isRoot && !api.addons.satisfies(entry.version, range)) throw new Error(`Нужен «${entry.name}» ${range}, а в каталоге только ${entry.version}.`);
    const check = api.addons.check(entry);
    if (!check.ok) throw new Error(`«${entry.name}»: ${check.reason}`);
    for (const [depId, depRange] of Object.entries(entry.dependencies || {})) visit(depId, depRange, false);
    plan.push(entry);
  };
  visit(id, '*', true);
  return plan;
}

function describeNeeds(entry, entries, installed) {
  return Object.entries(entry.dependencies || {}).map(([id, range]) => {
    const local = installed.get(id);
    const available = entries.find((e) => e.id === id);
    const name = (local && local.name) || (available && available.name) || id;
    if (local && api.addons.satisfies(local.version, range)) return { name, range, state: 'installed' };
    if (available && api.addons.satisfies(available.version, range)) return { name, range, state: 'will-install' };
    return { name, range, state: 'missing' };
  });
}

async function listCatalog() {
  const { url, entries } = await catalog();
  const installed = new Map(api.addons.list().map((a) => [a.id, a]));
  return {
    url,
    addons: entries.map((entry) => {
      const local = installed.get(entry.id);
      const check = api.addons.check(entry);
      return {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        description: entry.description || '',
        author: entry.author || '',
        needs: describeNeeds(entry, entries, installed),
        installedVersion: local ? local.version : null,
        update: Boolean(local && isNewer(entry.version, local.version)),
        compatible: check.ok,
        reason: check.reason,
        warning: check.warning,
      };
    }),
  };
}

async function dependenciesToInstall(id) {
  const { entries } = await catalog();
  return installPlan(id, entries).filter((entry) => entry.id !== id).map((entry) => entry.name);
}

async function install(id) {
  const { entries, rawBase } = await catalog();
  const plan = installPlan(id, entries);
  for (const entry of plan) {
    await api.addons.install(entry, rawBase);
    api.log('installed', entry.id, entry.version, 'from', `${entry.repo}@${entry.commit}`);
  }
  return { installed: plan.map((entry) => entry.name) };
}

async function modRelease() {
  const url = String(api.settings.get('modReleaseUrl') || MOD_RELEASE_URL);
  let text;
  if (url.startsWith('file:')) {
    text = fs.readFileSync(fileURLToPath(url), 'utf8');
  } else {
    const response = await api.electron.net.fetch(url, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    text = await response.text();
  }
  const release = JSON.parse(text);
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!parseVersion(version)) return null;
  return { version, url: release.html_url, newer: isNewer(version, api.modVersion) };
}

function updateCommandLine() {
  const manager = path.join(path.dirname(api.addons.dir), 'ymdmod.ps1');
  if (!fs.existsSync(manager)) throw new Error('Менеджер ymdmod не найден. Обновите мод вручную: ymdmod install.');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', manager, 'install', '-WaitForClient',
    '-InstallDir', path.dirname(process.execPath), '-UserDataDir', api.electron.app.getPath('userData')];
  const releaseUrl = api.settings.get('modReleaseUrl');
  if (releaseUrl) args.push('-ReleaseUrl', String(releaseUrl).startsWith('file:') ? fileURLToPath(releaseUrl) : String(releaseUrl));
  const catalogUrl = api.settings.get('catalogUrl');
  if (catalogUrl) args.push('-CatalogUrl', String(catalogUrl));
  return ['powershell.exe', ...args].map((arg) => (/^[\w.:\\/-]+$/.test(arg) ? arg : `"${arg}"`)).join(' ');
}

function startOutsideClient(commandLine) {
  const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }; exit $r.ReturnValue`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Не удалось запустить обновление (код ${code}).`))));
  });
}

async function updateMod() {
  await startOutsideClient(updateCommandLine());
  setTimeout(() => api.electron.app.quit(), 1500);
  return true;
}

function openRelease({ url }) {
  if (!/^https:\/\/github\.com\//.test(String(url))) throw new Error('Можно открыть только ссылку на GitHub.');
  api.electron.shell.openExternal(String(url));
  return true;
}

const operations = {
  catalog: () => listCatalog(),
  dependencies: (args) => dependenciesToInstall(String(args.id)),
  install: (args) => install(String(args.id)),
  modRelease: () => modRelease(),
  updateMod: () => updateMod(),
  openRelease: (args) => openRelease(args),
};

module.exports = {
  activate(addonApi) {
    api = addonApi;
    if (!api.addons) throw new Error('Ядро не выдало разрешение "addons".');
    api.on('marketplace:request', (message) => {
      if (!message || typeof message.rid !== 'string' || !operations[message.op]) return;
      Promise.resolve()
        .then(() => operations[message.op](message.args || {}))
        .then((result) => api.emit('marketplace:response', { rid: message.rid, ok: true, result }))
        .catch((error) => {
          api.log(message.op, 'failed', (error && error.stack) || error);
          api.emit('marketplace:response', { rid: message.rid, ok: false, error: (error && error.message) || String(error) });
        });
    });
  },
};
