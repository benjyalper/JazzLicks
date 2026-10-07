// Sync licks between devices through a private GitHub gist.
//
// Each device keeps its own copy in localStorage. When sync is on, the app
// pulls the gist, merges it with the local copy (newest version of each lick
// wins, deletions are remembered) and pushes the result back.

const CONFIG_KEY = 'jazzlicks.sync';
const FILE_NAME = 'jazzlicks.json';
const API = 'https://api.github.com';
const POLL_MS = 30000;

let config = readConfig();
let hooks = null;
let status = config ? 'idle' : 'off';
let detail = '';
let pushTimer = null;
let pollTimer = null;
let running = null;
let again = false;

function readConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY));
    return c && c.token ? c : null;
  } catch (e) {
    return null;
  }
}

function writeConfig(c) {
  config = c;
  try {
    if (c) localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CONFIG_KEY);
  } catch (e) { /* ignore */ }
}

function setStatus(s, d = '') {
  status = s;
  detail = d;
  hooks && hooks.onStatus(s, d);
}

async function gh(path, opts = {}, token = config && config.token) {
  const res = await fetch(API + path, {
    ...opts,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw Object.assign(new Error('The GitHub key was refused. It may have expired or been deleted.'), { auth: true });
  if (res.status === 403 || res.status === 404) {
    throw Object.assign(new Error('The GitHub key can\'t access gists. Make sure the "gist" box was ticked.'), { auth: true });
  }
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- merging

export function mergeData(local, remote) {
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, t] of Object.entries(local.deleted || {})) deleted[id] = Math.max(t, deleted[id] || 0);

  const byId = new Map();
  for (const p of [...(remote.phrases || []), ...(local.phrases || [])]) {
    const cur = byId.get(p.id);
    if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(p.id, p);
  }
  for (const [id, p] of byId) if (deleted[id] && deleted[id] >= (p.updatedAt || 0)) byId.delete(id);

  // Use the most recently changed order; licks only the other side knows about go first.
  const localNewer = (local.orderUpdatedAt || 0) >= (remote.orderUpdatedAt || 0);
  const primary = (localNewer ? local : remote).phrases || [];
  const secondary = (localNewer ? remote : local).phrases || [];
  const primaryIds = new Set(primary.map((p) => p.id));
  const ids = [...secondary.filter((p) => !primaryIds.has(p.id)).map((p) => p.id), ...primary.map((p) => p.id)];
  const seen = new Set();
  const phrases = [];
  for (const id of ids) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    phrases.push(byId.get(id));
  }

  // Forget deletions after 180 days.
  const cutoff = Date.now() - 180 * 864e5;
  for (const [id, t] of Object.entries(deleted)) if (t < cutoff) delete deleted[id];

  return {
    version: 2,
    phrases,
    deleted,
    orderUpdatedAt: Math.max(local.orderUpdatedAt || 0, remote.orderUpdatedAt || 0),
  };
}

const sameData = (a, b) => JSON.stringify(a.phrases) === JSON.stringify(b.phrases)
  && JSON.stringify(a.deleted || {}) === JSON.stringify(b.deleted || {});

// ---------------------------------------------------------------- gist

async function findOrCreateGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, {}, token);
    const found = list.find((g) => g.files && g.files[FILE_NAME]);
    if (found) return found.id;
    if (list.length < 100) break;
  }
  const created = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: 'JazzLicks – my licks (synced by the JazzLicks app)',
      public: false,
      files: { [FILE_NAME]: { content: JSON.stringify({ version: 2, phrases: [], deleted: {}, orderUpdatedAt: 0 }) } },
    }),
  }, token);
  return created.id;
}

async function readGist() {
  const g = await gh(`/gists/${config.gistId}`);
  const file = g.files && g.files[FILE_NAME];
  if (!file) return { phrases: [], deleted: {}, orderUpdatedAt: 0 };
  let text = file.content;
  if (file.truncated) text = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
  try {
    const data = JSON.parse(text);
    return { phrases: data.phrases || [], deleted: data.deleted || {}, orderUpdatedAt: data.orderUpdatedAt || 0 };
  } catch (e) {
    return { phrases: [], deleted: {}, orderUpdatedAt: 0 };
  }
}

async function writeGist(data) {
  await gh(`/gists/${config.gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [FILE_NAME]: { content: JSON.stringify(data) } } }),
  });
}

// One pull → merge → push round. Concurrent requests are folded together.
export function syncNow() {
  if (!config) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    setStatus('syncing');
    try {
      const remote = await readGist();
      const local = hooks.getData();
      const merged = mergeData(local, remote);
      if (!sameData(merged, local) || merged.orderUpdatedAt !== (local.orderUpdatedAt || 0)) hooks.applyData(merged);
      if (!sameData(merged, remote)) await writeGist(merged);
      config.lastSync = Date.now();
      writeConfig(config);
      setStatus('ok');
    } catch (e) {
      if (e.auth) setStatus('error', e.message);
      else setStatus(navigator.onLine === false ? 'offline' : 'error', navigator.onLine === false ? '' : e.message);
    } finally {
      running = null;
      if (again) {
        again = false;
        syncNow();
      }
    }
  })();
  return running;
}

// ---------------------------------------------------------------- public API

export function initSync(h) {
  hooks = h;
  // A link from another device: …/#sync=<token>
  const m = location.hash.match(/sync=([\w-]+)/);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    connect(m[1]).then(
      () => hooks.onMessage('Sync is on. Your licks will now stay the same on all your devices.'),
      (e) => hooks.onMessage(e.message),
    );
  } else if (config) {
    syncNow();
  }
  setStatus(status);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && config) syncNow();
  });
  window.addEventListener('online', () => config && syncNow());
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (config && document.visibilityState === 'visible') syncNow();
  }, POLL_MS);
}

// Call after every local change.
export function notifyChange() {
  if (!config) return;
  setStatus('pending');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, 1500);
}

export async function connect(token) {
  token = token.trim();
  if (!/^[\w-]{20,}$/.test(token)) throw new Error('That doesn\'t look like a GitHub key.');
  setStatus('syncing');
  try {
    const user = await gh('/user', {}, token);
    const gistId = await findOrCreateGist(token);
    writeConfig({ token, gistId, login: user.login });
  } catch (e) {
    setStatus(config ? 'error' : 'off', e.message);
    throw e;
  }
  await syncNow();
}

export function disconnect() {
  writeConfig(null);
  setStatus('off');
}

export function syncInfo() {
  return {
    on: !!config,
    login: config && config.login,
    gistId: config && config.gistId,
    lastSync: config && config.lastSync,
    status,
    detail,
    link: config ? `${location.origin}${location.pathname}#sync=${config.token}` : null,
  };
}
