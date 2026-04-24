const $ = (id) => document.getElementById(id);
const canvas = $('mapCanvas');
const ctx = canvas.getContext('2d');

const TEXT_EXTS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inl',
  '.lua', '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json',
  '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.cmake', '.md', '.txt',
  '.glsl', '.vert', '.frag', '.comp', '.metal', '.wgsl', '.bat', '.sh', '.ps1',
  '.java', '.cs', '.go', '.rs', '.rb', '.php', '.sql'
]);

const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', '.idea', '.vs', '.vscode', 'node_modules', 'vendor',
  'build', 'bin', 'obj', 'out', 'dist', 'target', 'Debug', 'Release', 'x64',
  '__pycache__', '.pytest_cache', '.cache', 'CMakeFiles'
]);

const IGNORE_EXTS = new Set([
  '.exe', '.dll', '.lib', '.pdb', '.obj', '.o', '.a', '.so', '.dylib',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tga',
  '.wav', '.mp3', '.ogg', '.flac', '.mp4', '.mov', '.avi',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.blend', '.fbx', '.glb', '.gltf',
  '.ttf', '.otf', '.woff', '.woff2', '.pdf'
]);

const SYMBOL_PATTERNS = [
  /^\s*(?:class|struct)\s+([A-Za-z_]\w*)/,
  /^\s*namespace\s+([A-Za-z_]\w*)/,
  /^\s*(?:static\s+)?(?:inline\s+)?(?:virtual\s+)?(?:[A-Za-z_:<>~*&]+\s+)+([A-Za-z_~]\w*(?:::[A-Za-z_~]\w*)?)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/,
  /^\s*function\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(/,
  /^\s*local\s+function\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_]\w*)/,
  /^\s*def\s+([A-Za-z_]\w*)\s*\(/
];

const IMPORT_PATTERNS = [
  /^\s*#\s*include\s+[<"]([^>"]+)[>"]/,
  /^\s*import\s+.*?from\s+["']([^"']+)["']/,
  /^\s*import\s+["']([^"']+)["']/,
  /^\s*(?:local\s+)?[A-Za-z_]\w*\s*=\s*require\s*\(?["']([^"']+)["']\)?/,
  /^\s*require\s*\(?["']([^"']+)["']\)?/
];

let repo = null;
let mode = 'walk';
let currentDir = '';
let roomItems = [];
let selectedIndex = 0;
let graphNodes = [];
let graphEdges = [];
let camera = { x: 0, y: 0, scale: 1 };
let backendAvailable = false;
let repoCache = new Map();
let activeSource = null;
let graphPointer = null;
let movedDuringPointer = false;
let graphFrameQueued = false;
let serverRepoList = [];

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const text = await r.text();
  let j = {};
  if (text) {
    try { j = JSON.parse(text); }
    catch { throw new Error(text.slice(0, 160) || r.statusText); }
  }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmtBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function extOf(path) {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

function baseName(path) {
  return String(path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
}

function niceLabel(path) {
  const b = baseName(path);
  return b.length > 28 ? b.slice(0, 25) + '…' : b;
}

function isTextPath(path) {
  const ext = extOf(path);
  return TEXT_EXTS.has(ext) || !ext;
}

function shouldIgnorePath(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(p => IGNORE_DIRS.has(p))) return true;
  return IGNORE_EXTS.has(extOf(path));
}

function setStatus(message) {
  $('stats').textContent = message;
}

function parseGithubUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  let branch = '';
  let subdir = '';
  const treeIndex = parts.indexOf('tree');
  if (treeIndex >= 0 && parts[treeIndex + 1]) {
    branch = parts[treeIndex + 1];
    subdir = parts.slice(treeIndex + 2).join('/');
  }
  return { owner, name, branch, subdir };
}

function analyzeText(path, text, size = 0, modified = 0, extra = {}) {
  const lines = text.split(/\r?\n/);
  const symbols = [];
  const imports = [];
  let todos = 0;

  for (const line of lines.slice(0, 4000)) {
    if (/TODO|FIXME|HACK|BUG/.test(line)) todos += 1;

    if (symbols.length < 80) {
      for (const pat of SYMBOL_PATTERNS) {
        const m = pat.exec(line);
        if (m && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
          if (!symbols.includes(m[1])) symbols.push(m[1]);
          break;
        }
      }
    }

    if (imports.length < 120) {
      for (const pat of IMPORT_PATTERNS) {
        const m = pat.exec(line);
        if (m && !imports.includes(m[1].trim())) {
          imports.push(m[1].trim());
          break;
        }
      }
    }
  }

  return {
    path,
    name: baseName(path),
    ext: extOf(path),
    size,
    lines: lines.length,
    kind: 'text',
    symbols,
    imports,
    todos,
    modified,
    content: text,
    ...extra
  };
}

function makeBinaryFile(path, size = 0, modified = 0, extra = {}) {
  return {
    path,
    name: baseName(path),
    ext: extOf(path),
    size,
    lines: 0,
    kind: 'binary',
    symbols: [],
    imports: [],
    todos: 0,
    modified,
    ...extra
  };
}

function resolveImport(filesByName, filesByPath, importerPath, imp) {
  const impNorm = String(imp || '').replace(/\\/g, '/');
  const parent = importerPath.split('/').slice(0, -1).join('/');

  function normPath(path) {
    const out = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  }

  if (impNorm.startsWith('./') || impNorm.startsWith('../')) {
    const base = normPath(parent ? `${parent}/${impNorm}` : impNorm);
    const guesses = [base, `${base}.js`, `${base}.ts`, `${base}.jsx`, `${base}.tsx`, `${base}.lua`, `${base}.py`, `${base}.hpp`, `${base}.h`, `${base}.cpp`, `${base}/index.js`, `${base}/index.ts`];
    for (const g of guesses) if (filesByPath.has(g)) return g;
  }

  const base = baseName(impNorm);
  const candidates = filesByName.get(base);
  if (candidates && candidates.length) return candidates[0];

  const luaGuess = impNorm.replace(/\./g, '/') + '.lua';
  for (const list of filesByName.values()) {
    const hit = list.find(p => p.endsWith(luaGuess));
    if (hit) return hit;
  }

  for (const ext of ['.js', '.ts', '.jsx', '.tsx', '.lua', '.py', '.hpp', '.h', '.cpp']) {
    const guessName = baseName(impNorm + ext);
    const list = filesByName.get(guessName);
    if (list && list.length) return list[0];
  }

  return null;
}

function buildTree(files, rootName) {
  const root = { name: rootName, path: '', type: 'dir', children: {} };

  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    let cur = '';
    for (const part of parts.slice(0, -1)) {
      cur = cur ? `${cur}/${part}` : part;
      node = node.children[part] ||= { name: part, path: cur, type: 'dir', children: {} };
    }
    const name = parts.at(-1);
    if (!name) continue;
    node.children[name] = {
      name,
      path: f.path,
      type: 'file',
      size: f.size,
      lines: f.lines,
      kind: f.kind,
      ext: f.ext,
      todos: f.todos
    };
  }

  function finish(n) {
    if (n.type === 'dir') {
      const kids = Object.values(n.children).sort((a, b) => (a.type !== 'dir') - (b.type !== 'dir') || a.name.localeCompare(b.name));
      n.children = kids.map(finish);
      n.fileCount = n.children.reduce((sum, c) => sum + (c.fileCount ?? (c.type === 'file' ? 1 : 0)), 0);
      n.totalSize = n.children.reduce((sum, c) => sum + (c.totalSize ?? c.size ?? 0), 0);
    }
    return n;
  }

  return finish(root);
}

function buildRepo(name, root, files, extra = {}) {
  const filesByName = new Map();
  const filesByPath = new Map();

  for (const f of files) {
    filesByPath.set(f.path, f);
    const list = filesByName.get(f.name) || [];
    list.push(f.path);
    filesByName.set(f.name, list);
  }

  const edges = [];
  for (const f of files) {
    for (const imp of f.imports || []) {
      const target = resolveImport(filesByName, filesByPath, f.path, imp);
      edges.push({ from: f.path, to: target || imp, type: 'import', resolved: Boolean(target), label: imp });
    }
  }

  const extCounts = {};
  for (const f of files) extCounts[f.ext || '[none]'] = (extCounts[f.ext || '[none]'] || 0) + 1;

  return {
    root,
    name,
    scannedAt: Date.now() / 1000,
    dirs: 0,
    skipped: extra.skipped || 0,
    links: extra.links || 0,
    source: extra.source || 'static',
    sourceInfo: extra.sourceInfo || {},
    stats: {
      files: files.length,
      dirs: 0,
      links: extra.links || 0,
      lines: files.reduce((s, f) => s + (f.lines || 0), 0),
      bytes: files.reduce((s, f) => s + (f.size || 0), 0),
      imports: edges.length,
      todos: files.reduce((s, f) => s + (f.todos || 0), 0),
      extCounts
    },
    files,
    tree: buildTree(files, name),
    edges,
    hotspots: {
      largest: [...files].sort((a, b) => b.size - a.size).slice(0, 30),
      symbols: [...files].sort((a, b) => b.symbols.length - a.symbols.length).slice(0, 30)
    }
  };
}

async function loadGithubRepo(rawUrl) {
  const gh = parseGithubUrl(rawUrl);
  if (!gh) throw new Error('Enter a public GitHub repo URL.');

  const key = `github:${gh.owner}/${gh.name}:${gh.branch || 'default'}:${gh.subdir || ''}`;
  if (repoCache.has(key)) return repoCache.get(key);

  setStatus('Reading GitHub repository tree...');
  const repoInfo = await fetchJson(`https://api.github.com/repos/${gh.owner}/${gh.name}`);
  const branch = gh.branch || repoInfo.default_branch;
  const tree = await fetchJson(`https://api.github.com/repos/${gh.owner}/${gh.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (tree.truncated) console.warn('GitHub returned a truncated tree. Some files may be missing.');

  const prefix = gh.subdir ? gh.subdir.replace(/^\/+|\/+$/g, '') + '/' : '';
  const blobs = tree.tree
    .filter(item => item.type === 'blob')
    .filter(item => !prefix || item.path.startsWith(prefix))
    .map(item => ({ ...item, displayPath: prefix ? item.path.slice(prefix.length) : item.path }))
    .filter(item => item.displayPath && !shouldIgnorePath(item.displayPath));

  const files = [];
  const textBlobs = blobs.filter(item => isTextPath(item.displayPath) && item.size <= 400_000).slice(0, 650);
  const binaryBlobs = blobs.filter(item => !textBlobs.includes(item));

  for (const item of binaryBlobs) {
    files.push(makeBinaryFile(item.displayPath, item.size || 0, 0, {
      sourceType: 'github',
      githubPath: item.path,
      rawUrl: rawGithubUrl(gh.owner, gh.name, branch, item.path)
    }));
  }

  let done = 0;
  await mapLimit(textBlobs, 8, async (item) => {
    done += 1;
    if (done % 15 === 0 || done === 1) setStatus(`Reading GitHub files ${done}/${textBlobs.length}...`);
    const raw = rawGithubUrl(gh.owner, gh.name, branch, item.path);
    try {
      const text = await fetchText(raw);
      files.push(analyzeText(item.displayPath, text, item.size || text.length, 0, {
        sourceType: 'github',
        githubPath: item.path,
        rawUrl: raw
      }));
    } catch {
      files.push(makeBinaryFile(item.displayPath, item.size || 0, 0, {
        sourceType: 'github',
        githubPath: item.path,
        rawUrl: raw
      }));
    }
  });

  const result = buildRepo(`${gh.owner}/${gh.name}`, `https://github.com/${gh.owner}/${gh.name}${gh.subdir ? '/tree/' + branch + '/' + gh.subdir : ''}`, files.sort((a, b) => a.path.localeCompare(b.path)), {
    source: 'github',
    sourceInfo: { ...gh, branch }
  });

  repoCache.set(key, result);
  addRecentRepo(result.root, 'github');
  return result;
}

function rawGithubUrl(owner, repoName, branch, path) {
  return `https://raw.githubusercontent.com/${owner}/${repoName}/${encodeURIComponent(branch).replace(/%2F/g, '/')}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || r.statusText);
  return j;
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.statusText);
  return await r.text();
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function pickLocalFolder() {
  if ('showDirectoryPicker' in window) {
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    const files = [];
    let skipped = 0;

    async function walk(handle, prefix = '') {
      for await (const [name, child] of handle.entries()) {
        if (IGNORE_DIRS.has(name)) { skipped++; continue; }
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') {
          await walk(child, path);
        } else if (!shouldIgnorePath(path)) {
          const file = await child.getFile();
          if (file.size > 8_000_000) { skipped++; continue; }
          if (isTextPath(path) && file.size <= 800_000) {
            const text = await file.text();
            files.push(analyzeText(path, text, file.size, file.lastModified / 1000, { sourceType: 'local-picker', fileHandle: child }));
          } else {
            files.push(makeBinaryFile(path, file.size, file.lastModified / 1000, { sourceType: 'local-picker', fileHandle: child }));
          }
        }
      }
    }

    setStatus('Scanning selected folder...');
    await walk(dir);
    const result = buildRepo(dir.name, `[browser folder] ${dir.name}`, files.sort((a, b) => a.path.localeCompare(b.path)), { source: 'local-picker', skipped });
    repoCache.set(result.root, result);
    addRecentRepo(result.root, 'local-picker');
    return result;
  }

  $('folderInput').click();
  return await new Promise((resolve, reject) => {
    $('folderInput').onchange = async () => {
      try {
        const list = Array.from($('folderInput').files || []);
        if (!list.length) throw new Error('No folder selected.');
        const rootName = list[0].webkitRelativePath.split('/')[0];
        const files = [];
        for (const file of list) {
          const path = file.webkitRelativePath.split('/').slice(1).join('/');
          if (!path || shouldIgnorePath(path) || file.size > 8_000_000) continue;
          if (isTextPath(path) && file.size <= 800_000) {
            files.push(analyzeText(path, await file.text(), file.size, file.lastModified / 1000, { sourceType: 'folder-input' }));
          } else {
            files.push(makeBinaryFile(path, file.size, file.lastModified / 1000, { sourceType: 'folder-input' }));
          }
        }
        const result = buildRepo(rootName, `[browser folder] ${rootName}`, files.sort((a, b) => a.path.localeCompare(b.path)), { source: 'folder-input' });
        repoCache.set(result.root, result);
        addRecentRepo(result.root, 'folder-input');
        resolve(result);
      } catch (e) {
        reject(e);
      }
    };
  });
}

async function scan(force = false) {
  if (!activeSource) {
    if (backendAvailable) {
      setStatus('Scanning local server root...');
      repo = await api('api/scan' + (force ? '?force=1' : ''));
      activeSource = { type: 'server', value: repo.root };
      repoCache.set(`server:${repo.root}`, repo);
      addRecentRepo(repo.root, 'server');
    } else {
      setStatus('Static mode ready. Paste a GitHub URL or pick a folder.');
      return;
    }
  } else if (activeSource.type === 'github') {
    const key = activeSource.value;
    if (force) repoCache.delete(key);
    repo = await loadGithubRepo(key);
  } else if (activeSource.type === 'server') {
    setStatus('Scanning local server root...');
    repo = await api('api/scan' + (force ? '?force=1' : ''));
    repoCache.set(`server:${repo.root}`, repo);
  } else if (activeSource.type === 'cache') {
    repo = repoCache.get(activeSource.value);
  }

  applyRepo(repo);
}

function applyRepo(nextRepo) {
  repo = nextRepo;
  currentDir = '';
  selectedIndex = 0;
  camera = { x: 0, y: 0, scale: 1 };
  updateStats();
  renderTree();
  buildGraph();
  enterDir('');
  draw();
}

function updateStats() {
  const s = repo.stats;
  $('subtitle').textContent = `${repo.name} — ${repo.root}`;
  $('repoPath').value = repo.root;
  $('stats').innerHTML = `<div class="stat-grid">
    <div class="stat"><b>${s.files}</b><span>files</span></div>
    <div class="stat"><b>${s.dirs || countDirs(repo.tree)}</b><span>dirs</span></div>
    <div class="stat"><b>${s.links || 0}</b><span>links</span></div>
    <div class="stat"><b>${s.lines}</b><span>lines</span></div>
    <div class="stat"><b>${s.imports}</b><span>imports</span></div>
    <div class="stat"><b>${s.todos}</b><span>TODO/FIXME</span></div>
    <div class="stat"><b>${fmtBytes(s.bytes)}</b><span>text-ish size</span></div>
    <div class="stat"><b>${repo.source || 'server'}</b><span>source</span></div>
  </div>`;
}

function countDirs(node) {
  if (!node || node.type !== 'dir') return 0;
  return 1 + (node.children || []).reduce((s, c) => s + countDirs(c), 0);
}

function renderTree() {
  const root = repo.tree;
  function nodeHtml(n, depth = 0) {
    const cls = n.type === 'dir' ? 'dir' : 'file';
    const label = n.type === 'dir' ? `▸ ${n.name} (${n.fileCount || 0})` : `• ${n.name}`;
    let html = `<div class="tree-node ${cls}" data-path="${esc(n.path)}" data-type="${n.type}">${esc(label)}</div>`;
    if (n.type === 'dir' && depth < 3) {
      html += `<div class="tree-children">${(n.children || []).map(c => nodeHtml(c, depth + 1)).join('')}</div>`;
    }
    return html;
  }
  $('tree').innerHTML = nodeHtml(root);
  $('tree').querySelectorAll('.tree-node').forEach(el => {
    el.onclick = () => {
      if (el.dataset.type === 'dir') enterDir(el.dataset.path);
      else inspectFile(el.dataset.path);
    };
  });
}

function findDir(path) {
  const parts = path ? path.split('/').filter(Boolean) : [];
  let n = repo.tree;
  for (const p of parts) {
    n = (n.children || []).find(c => c.name === p && c.type === 'dir');
    if (!n) return repo.tree;
  }
  return n;
}

function findFile(path) {
  return repo.files.find(f => f.path === path);
}

function enterDir(path) {
  currentDir = path || '';
  const dir = findDir(currentDir);
  roomItems = [];
  if (currentDir) roomItems.push({ type: 'up', name: '..', path: currentDir.split('/').slice(0, -1).join('/') });
  for (const c of dir.children || []) roomItems.push(c);
  selectedIndex = Math.min(selectedIndex, Math.max(0, roomItems.length - 1));
  inspectDir(dir);
  draw();
}

function inspectDir(dir) {
  $('inspector').innerHTML = `<div class="kv"><span>Folder</span><code>${esc(dir.path || repo.name)}</code></div>
    <div class="kv"><span>Files below</span>${dir.fileCount || 0}</div>
    <div class="kv"><span>Total size</span>${fmtBytes(dir.totalSize || 0)}</div>
    <div class="kv"><span>Children</span>${(dir.children || []).length}</div>`;
  $('code').textContent = '';
}

async function inspectFile(path) {
  const f = findFile(path) || { path };
  $('inspector').innerHTML = `<div class="kv"><span>File</span><code>${esc(f.path)}</code></div>
    <div class="kv"><span>Size</span>${fmtBytes(f.size || 0)}</div>
    <div class="kv"><span>Lines</span>${f.lines || 0}</div>
    <div class="kv"><span>Kind</span>${esc(f.kind || '?')}</div>
    <div class="kv"><span>TODOs</span>${f.todos || 0}</div>
    <div><h2>Symbols</h2>${(f.symbols || []).slice(0, 40).map(s => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="muted">none</span>'}</div>
    <div><h2>Imports</h2>${(f.imports || []).slice(0, 40).map(s => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="muted">none</span>'}</div>`;

  $('code').textContent = 'Loading...';
  try {
    if (f.content != null) {
      $('code').textContent = f.content.slice(0, 120000);
    } else if (f.sourceType === 'github' && f.rawUrl) {
      const text = await fetchText(f.rawUrl);
      f.content = text;
      if (f.kind === 'text' && !f.lines) Object.assign(f, analyzeText(f.path, text, text.length, f.modified, { sourceType: f.sourceType, rawUrl: f.rawUrl, githubPath: f.githubPath }));
      $('code').textContent = text.slice(0, 120000);
    } else if (backendAvailable && (!repo.source || repo.source === 'server')) {
      const data = await api('api/file?path=' + encodeURIComponent(path));
      $('code').textContent = data.binary ? '[binary file]' : data.content.slice(0, 120000);
    } else {
      $('code').textContent = f.kind === 'binary' ? '[binary file]' : '[content unavailable]';
    }
  } catch (e) {
    $('code').textContent = e.message;
  }
}

function buildGraph() {
  const files = repo.files.filter(f => f.kind === 'text');
  const byPath = new Map();
  graphNodes = files.slice(0, 900).map((f, i) => {
    const angle = i * 2.399963;
    const r = 40 + 15 * Math.sqrt(i);
    const degree = repo.edges.filter(e => e.from === f.path || e.to === f.path).length;
    const n = {
      f,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      degree,
      radius: Math.max(6, Math.min(18, Math.log2((f.lines || 1) + 1) + degree * 0.8)),
      fixed: false
    };
    byPath.set(f.path, n);
    return n;
  });
  graphEdges = repo.edges
    .filter(e => e.resolved && byPath.has(e.from) && byPath.has(e.to))
    .slice(0, 2500)
    .map(e => ({ a: byPath.get(e.from), b: byPath.get(e.to), e }));
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width * devicePixelRatio));
  canvas.height = Math.max(240, Math.floor(rect.height * devicePixelRatio));
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  draw();
}
window.addEventListener('resize', resize);

function draw() {
  if (!repo) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (mode === 'walk') drawWalk(w, h);
  if (mode === 'graph') drawGraph(w, h);
  if (mode === 'hotspots') drawHotspots(w, h);
}

function drawWalk(w, h) {
  ctx.save();
  ctx.fillStyle = '#091019';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = getCss('--line');
  ctx.lineWidth = 2;
  const pad = Math.max(30, Math.min(55, w * 0.06));
  ctx.strokeRect(pad, pad, Math.max(0, w - pad * 2), Math.max(0, h - pad * 2));
  ctx.fillStyle = getCss('--text');
  ctx.font = '700 20px system-ui';
  ctx.fillText('/' + (currentDir || repo.name), pad + 16, pad + 32);

  const cols = Math.max(2, Math.floor((w - pad * 2) / 190));
  const cellW = (w - pad * 2 - 30) / cols;
  const cellH = 86;
  roomItems.forEach((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + 18 + col * cellW;
    const y = pad + 62 + row * cellH;
    if (y > h - 40) return;
    const sel = i === selectedIndex;
    ctx.fillStyle = sel ? colorMix(getCss('--accent'), '#0d1722', 0.28) : '#0d1722';
    ctx.strokeStyle = sel ? getCss('--accent') : '#24384d';
    ctx.lineWidth = sel ? 3 : 1;
    ctx.beginPath();
    roundRect(ctx, x, y, cellW - 14, 62, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = item.type === 'dir' || item.type === 'up' ? getCss('--accent') : getCss('--text');
    ctx.font = '700 13px ui-monospace, monospace';
    const icon = item.type === 'dir' ? '[DIR]' : item.type === 'up' ? '[UP]' : '[FILE]';
    ctx.fillText(icon, x + 10, y + 22);
    ctx.font = '12px ui-monospace, monospace';
    wrapText(ctx, item.name, x + 10, y + 42, cellW - 34, 14, 2);
  });
  ctx.restore();
}

function relaxGraph() {
  for (let iter = 0; iter < 2; iter++) {
    for (const ed of graphEdges) {
      const dx = ed.b.x - ed.a.x;
      const dy = ed.b.y - ed.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = 110;
      const force = (d - target) * 0.0014;
      const fx = dx / d * force;
      const fy = dy / d * force;
      if (!ed.a.fixed) { ed.a.vx += fx; ed.a.vy += fy; }
      if (!ed.b.fixed) { ed.b.vx -= fx; ed.b.vy -= fy; }
    }

    for (const n of graphNodes) {
      if (n.fixed) continue;
      n.vx += -n.x * 0.000018;
      n.vy += -n.y * 0.000018;
      n.x += n.vx;
      n.y += n.vy;
      n.vx *= 0.88;
      n.vy *= 0.88;
    }
  }
}

function drawGraph(w, h) {
  relaxGraph();
  ctx.save();
  ctx.translate(w / 2 + camera.x, h / 2 + camera.y);
  ctx.scale(camera.scale, camera.scale);

  ctx.lineWidth = 1 / camera.scale;
  ctx.strokeStyle = colorAlpha(getCss('--accent'), 0.15);
  for (const ed of graphEdges) {
    ctx.beginPath();
    ctx.moveTo(ed.a.x, ed.a.y);
    ctx.lineTo(ed.b.x, ed.b.y);
    ctx.stroke();
  }

  for (const n of graphNodes) drawGraphNode(n);
  ctx.restore();

  ctx.fillStyle = getCss('--muted');
  ctx.font = '13px system-ui';
  ctx.fillText(`Import graph: ${graphNodes.length} files, ${graphEdges.length} resolved links. Drag orbs. Drag empty space to pan.`, 14, 24);

  if (!graphFrameQueued) {
    graphFrameQueued = true;
    requestAnimationFrame(() => {
      graphFrameQueued = false;
      if (mode === 'graph') draw();
    });
  }
}

function drawGraphNode(n) {
  const r = n.radius;
  const accent = n.f.todos ? getCss('--warn') : getCss('--accent');

  const g = ctx.createRadialGradient(n.x - r * 0.4, n.y - r * 0.6, 1, n.x, n.y, r * 1.5);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.18, colorMix(accent, '#ffffff', 0.7));
  g.addColorStop(1, colorMix(accent, '#07101a', 0.55));

  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = n.fixed ? getCss('--accent2') : colorMix(accent, '#ffffff', 0.5);
  ctx.lineWidth = (n.fixed ? 2.5 : 1.4) / camera.scale;
  ctx.stroke();

  const label = niceLabel(n.f.path);
  ctx.font = `${Math.max(9, 12 / Math.sqrt(camera.scale))}px ui-monospace, monospace`;
  const metrics = ctx.measureText(label);
  const tw = metrics.width + 10;
  const th = 17;
  const tx = n.x - tw / 2;
  const ty = n.y - r - th - 5;

  ctx.fillStyle = 'rgba(7, 11, 16, 0.78)';
  ctx.strokeStyle = colorAlpha(accent, 0.42);
  ctx.lineWidth = 1 / camera.scale;
  ctx.beginPath();
  roundRect(ctx, tx, ty, tw, th, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#e9f4ff';
  ctx.fillText(label, tx + 5, ty + 12);
}

function drawHotspots(w, h) {
  ctx.fillStyle = '#091019';
  ctx.fillRect(0, 0, w, h);
  const files = [...repo.files]
    .filter(f => f.kind === 'text')
    .sort((a, b) => (b.lines + b.todos * 50 + b.symbols.length * 10) - (a.lines + a.todos * 50 + a.symbols.length * 10))
    .slice(0, 80);
  const cols = Math.max(3, Math.floor(w / 170));
  const cellW = w / cols;
  files.forEach((f, i) => {
    const x = (i % cols) * cellW + 8;
    const y = Math.floor(i / cols) * 76 + 12;
    if (y > h - 30) return;
    const heat = Math.min(1, (f.lines + f.todos * 50) / 1800);
    ctx.fillStyle = colorAlpha(colorMix(getCss('--accent2'), getCss('--accent'), heat), 0.28);
    ctx.strokeStyle = '#24384d';
    ctx.beginPath();
    roundRect(ctx, x, y, cellW - 16, 58, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = getCss('--text');
    ctx.font = '12px ui-monospace, monospace';
    wrapText(ctx, f.path, x + 8, y + 20, cellW - 32, 13, 2);
    ctx.fillStyle = getCss('--muted');
    ctx.fillText(`${f.lines} lines · ${f.todos} TODO`, x + 8, y + 50);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
  let line = '';
  let lines = 0;
  const chars = String(text || '');
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lineH;
      lines++;
      line = ch;
      if (lines >= maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line.length < chars.length ? line + '…' : line, x, y);
}

function hitWalk(x, y) {
  const w = canvas.clientWidth;
  const pad = Math.max(30, Math.min(55, w * 0.06));
  const cols = Math.max(2, Math.floor((w - pad * 2) / 190));
  const cellW = (w - pad * 2 - 30) / cols;
  const cellH = 86;
  for (let i = 0; i < roomItems.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const rx = pad + 18 + col * cellW;
    const ry = pad + 62 + row * cellH;
    if (x >= rx && x <= rx + cellW - 14 && y >= ry && y <= ry + 62) return i;
  }
  return -1;
}

function screenToGraph(x, y) {
  return {
    x: (x - canvas.clientWidth / 2 - camera.x) / camera.scale,
    y: (y - canvas.clientHeight / 2 - camera.y) / camera.scale
  };
}

function hitGraphNode(x, y) {
  const g = screenToGraph(x, y);
  let best = null;
  let bd = Infinity;
  for (const n of graphNodes) {
    const d = Math.hypot(n.x - g.x, n.y - g.y);
    const limit = Math.max(18 / camera.scale, n.radius + 7 / camera.scale);
    if (d < limit && d < bd) {
      bd = d;
      best = n;
    }
  }
  return best ? { node: best, graph: g } : null;
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!repo) return;
  canvas.setPointerCapture(ev.pointerId);
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  movedDuringPointer = false;

  if (mode === 'graph') {
    const hit = hitGraphNode(x, y);
    if (hit) {
      hit.node.fixed = true;
      graphPointer = {
        kind: 'node',
        id: ev.pointerId,
        node: hit.node,
        offsetX: hit.node.x - hit.graph.x,
        offsetY: hit.node.y - hit.graph.y,
        startX: ev.clientX,
        startY: ev.clientY
      };
      inspectFile(hit.node.f.path);
    } else {
      graphPointer = {
        kind: 'pan',
        id: ev.pointerId,
        lastX: ev.clientX,
        lastY: ev.clientY,
        startX: ev.clientX,
        startY: ev.clientY
      };
    }
  }
});

canvas.addEventListener('pointermove', (ev) => {
  if (!graphPointer || mode !== 'graph') return;
  const dist = Math.hypot(ev.clientX - graphPointer.startX, ev.clientY - graphPointer.startY);
  if (dist > 3) movedDuringPointer = true;

  if (graphPointer.kind === 'node') {
    const rect = canvas.getBoundingClientRect();
    const g = screenToGraph(ev.clientX - rect.left, ev.clientY - rect.top);
    graphPointer.node.x = g.x + graphPointer.offsetX;
    graphPointer.node.y = g.y + graphPointer.offsetY;
    graphPointer.node.vx = 0;
    graphPointer.node.vy = 0;
  } else if (graphPointer.kind === 'pan') {
    camera.x += ev.clientX - graphPointer.lastX;
    camera.y += ev.clientY - graphPointer.lastY;
    graphPointer.lastX = ev.clientX;
    graphPointer.lastY = ev.clientY;
  }
  draw();
});

canvas.addEventListener('pointerup', (ev) => {
  if (graphPointer && graphPointer.kind === 'node' && !movedDuringPointer) {
    graphPointer.node.fixed = false;
  }
  graphPointer = null;
});

canvas.addEventListener('click', (ev) => {
  if (!repo || movedDuringPointer) return;
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;

  if (mode === 'walk') {
    const i = hitWalk(x, y);
    if (i >= 0) {
      selectedIndex = i;
      activateSelected();
      return;
    }
  } else if (mode === 'graph') {
    const hit = hitGraphNode(x, y);
    if (hit) inspectFile(hit.node.f.path);
  }
  draw();
});

function activateSelected() {
  const item = roomItems[selectedIndex];
  if (!item) return;
  if (item.type === 'up' || item.type === 'dir') enterDir(item.path);
  else inspectFile(item.path);
  draw();
}

document.addEventListener('keydown', (e) => {
  if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (mode !== 'walk' || !roomItems.length) return;
  const cols = Math.max(2, Math.floor((canvas.clientWidth - 110) / 190));
  if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') selectedIndex = Math.min(roomItems.length - 1, selectedIndex + 1);
  if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') selectedIndex = Math.max(0, selectedIndex - 1);
  if (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') selectedIndex = Math.min(roomItems.length - 1, selectedIndex + cols);
  if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'w') selectedIndex = Math.max(0, selectedIndex - cols);
  if (e.key === 'Enter') activateSelected();
  if (e.key === 'Backspace') { e.preventDefault(); enterDir(currentDir.split('/').slice(0, -1).join('/')); }
  draw();
});

canvas.addEventListener('wheel', e => {
  if (mode !== 'graph') return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  camera.scale = Math.max(0.2, Math.min(4, camera.scale * factor));
  draw();
}, { passive: false });

function initCardWindows() {
  document.querySelectorAll('.card').forEach((card, index) => {
    const id = card.dataset.cardId || `card-${index}`;
    const saved = loadJson(`repoViewer.card.${id}`, null);
    if (saved) {
      card.style.setProperty('--card-x', `${saved.x || 0}px`);
      card.style.setProperty('--card-y', `${saved.y || 0}px`);
      if (saved.w) card.style.width = `${saved.w}px`;
      if (saved.h) card.style.height = `${saved.h}px`;
    }

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    card.appendChild(handle);

    const title = card.querySelector('h2');
    let state = null;

    title?.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      title.setPointerCapture(e.pointerId);
      const x = parseFloat(card.style.getPropertyValue('--card-x')) || 0;
      const y = parseFloat(card.style.getPropertyValue('--card-y')) || 0;
      state = { type: 'move', id, startX: e.clientX, startY: e.clientY, x, y };
      card.classList.add('card-dragging');
    });

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const rect = card.getBoundingClientRect();
      state = { type: 'resize', id, startX: e.clientX, startY: e.clientY, w: rect.width, h: rect.height };
      card.classList.add('card-resizing');
    });

    const move = (e) => {
      if (!state) return;
      const snap = $('snapCards').checked;
      const grid = snap ? 12 : 1;
      if (state.type === 'move') {
        const x = snapValue(state.x + e.clientX - state.startX, grid);
        const y = snapValue(state.y + e.clientY - state.startY, grid);
        card.style.setProperty('--card-x', `${x}px`);
        card.style.setProperty('--card-y', `${y}px`);
      } else if (state.type === 'resize') {
        const w = Math.max(160, snapValue(state.w + e.clientX - state.startX, grid));
        const h = Math.max(68, snapValue(state.h + e.clientY - state.startY, grid));
        card.style.width = `${w}px`;
        card.style.height = `${h}px`;
      }
    };

    const up = () => {
      if (!state) return;
      saveCardState(card, state.id);
      state = null;
      card.classList.remove('card-dragging', 'card-resizing');
    };

    title?.addEventListener('pointermove', move);
    handle.addEventListener('pointermove', move);
    title?.addEventListener('pointerup', up);
    handle.addEventListener('pointerup', up);
    title?.addEventListener('pointercancel', up);
    handle.addEventListener('pointercancel', up);
  });
}

function saveCardState(card, id) {
  const rect = card.getBoundingClientRect();
  saveJson(`repoViewer.card.${id}`, {
    x: parseFloat(card.style.getPropertyValue('--card-x')) || 0,
    y: parseFloat(card.style.getPropertyValue('--card-y')) || 0,
    w: Math.round(rect.width),
    h: Math.round(rect.height)
  });
}

function snapValue(v, grid) {
  return Math.round(v / grid) * grid;
}

function setupTheme() {
  const saved = localStorage.getItem('repoViewer.theme') || '#70c7ff';
  $('themeColor').value = saved;
  applyTheme(saved);
  $('themeColor').addEventListener('input', () => {
    const value = $('themeColor').value;
    localStorage.setItem('repoViewer.theme', value);
    applyTheme(value);
    draw();
  });

  const snap = localStorage.getItem('repoViewer.snapCards');
  $('snapCards').checked = snap == null ? true : snap === '1';
  $('snapCards').addEventListener('change', () => localStorage.setItem('repoViewer.snapCards', $('snapCards').checked ? '1' : '0'));
}

function applyTheme(hex) {
  const hsl = hexToHsl(hex);
  const comp = (hsl.h + 180) % 360;
  const comp2 = (hsl.h + 205) % 360;
  const root = document.documentElement;
  root.style.setProperty('--bg', hslToCss(hsl.h, 30, 5));
  root.style.setProperty('--bg2', hslToCss(hsl.h, 38, 14));
  root.style.setProperty('--panel', hslToCss(hsl.h, 32, 11));
  root.style.setProperty('--panel2', hslToCss(hsl.h, 34, 8));
  root.style.setProperty('--line', hslToCss(hsl.h, 32, 22));
  root.style.setProperty('--accent', hslToCss(comp, 95, 72));
  root.style.setProperty('--accent2', hslToCss(comp2, 90, 66));
  root.style.setProperty('--warn', hslToCss((comp + 34) % 360, 95, 72));
}

function hexToHsl(hex) {
  let r = parseInt(hex.slice(1, 3), 16) / 255;
  let g = parseInt(hex.slice(3, 5), 16) / 255;
  let b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToCss(h, s, l) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function colorAlpha(color, alpha) {
  const c = parseCssColor(color);
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

function colorMix(a, b, t) {
  const ca = parseCssColor(a);
  const cb = parseCssColor(b);
  const u = Math.max(0, Math.min(1, t));
  const r = Math.round(ca.r * u + cb.r * (1 - u));
  const g = Math.round(ca.g * u + cb.g * (1 - u));
  const blue = Math.round(ca.b * u + cb.b * (1 - u));
  return `rgb(${r},${g},${blue})`;
}

function parseCssColor(color) {
  const s = String(color || '').trim();
  if (s.startsWith('#')) {
    return {
      r: parseInt(s.slice(1, 3), 16),
      g: parseInt(s.slice(3, 5), 16),
      b: parseInt(s.slice(5, 7), 16)
    };
  }

  const hsl = /^hsl\(([-\d.]+)\s+([-\d.]+)%\s+([-\d.]+)%/i.exec(s);
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));

  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(s);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };

  return { r: 112, g: 199, b: 255 };
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function addRecentRepo(root, type) {
  const list = loadJson('repoViewer.recentRepos', []);
  const next = [{ root, type, time: Date.now() }, ...list.filter(x => x.root !== root)].slice(0, 20);
  saveJson('repoViewer.recentRepos', next);
  renderRecentRepos();
}

function renderRecentRepos() {
  const localList = loadJson('repoViewer.recentRepos', []);
  const merged = [
    ...localList,
    ...serverRepoList
      .filter(item => !localList.some(local => local.root === item.root))
      .map(item => ({ root: item.root, type: item.source || 'server-cache', time: 0 }))
  ];
  $('repoHistory').innerHTML = '<option value="">Recent / cached repos</option>' + merged.map(item => `<option value="${esc(item.root)}" data-type="${esc(item.type)}">${esc(item.type)} · ${esc(item.root)}</option>`).join('');
}

async function openFromInput() {
  const value = $('repoPath').value.trim();
  if (!value) return;
  try {
    if (parseGithubUrl(value)) {
      activeSource = { type: 'github', value };
      applyRepo(await loadGithubRepo(value));
      return;
    }

    if (!backendAvailable) throw new Error('Direct path scanning needs the optional local Python server. Use Pick Folder in static mode.');
    await api('api/repo/open', { method: 'POST', body: JSON.stringify({ path: value }) });
    activeSource = { type: 'server', value };
    await scan(true);
  } catch (e) {
    alert(e.message);
    setStatus(e.message);
  }
}

async function detectBackend() {
  try {
    await api('api/health');
    backendAvailable = true;
    try {
      const listed = await api('api/repos');
      serverRepoList = listed.repos || [];
    } catch {
      serverRepoList = [];
    }
  } catch {
    backendAvailable = false;
    serverRepoList = [];
  }
  $('gitStatus').disabled = !backendAvailable;
  $('gitStatus').title = backendAvailable ? 'Show git status for the optional local server root.' : 'Git status needs the optional local Python server.';
  renderRecentRepos();
}

function wireControls() {
  $('openRepo').onclick = openFromInput;
  $('openGithub').onclick = async () => {
    const value = $('repoPath').value.trim();
    try {
      activeSource = { type: 'github', value };
      applyRepo(await loadGithubRepo(value));
    } catch (e) {
      alert(e.message);
      setStatus(e.message);
    }
  };
  $('pickFolder').onclick = async () => {
    try {
      const result = await pickLocalFolder();
      activeSource = { type: 'cache', value: result.root };
      applyRepo(result);
    } catch (e) {
      alert(e.message);
      setStatus(e.message);
    }
  };
  $('rescan').onclick = () => scan(true).catch(e => { alert(e.message); setStatus(e.message); });
  $('gitStatus').onclick = async () => {
    try {
      const s = await api('api/git/status');
      $('gitOut').textContent = (s.stdout || '') + (s.stderr || '');
    } catch (e) {
      $('gitOut').textContent = e.message;
    }
  };
  $('repoHistory').onchange = async () => {
    const root = $('repoHistory').value;
    if (!root) return;
    if (repoCache.has(root)) {
      activeSource = { type: 'cache', value: root };
      applyRepo(repoCache.get(root));
    } else if (parseGithubUrl(root)) {
      activeSource = { type: 'github', value: root };
      applyRepo(await loadGithubRepo(root));
    } else if (backendAvailable) {
      $('repoPath').value = root;
      await openFromInput();
    } else {
      $('repoPath').value = root;
      setStatus('This recent repo is not in memory. Reopen it from GitHub or Pick Folder.');
    }
  };

  $('searchBox').addEventListener('input', debounce(async () => {
    if (!repo) return;
    const q = $('searchBox').value.trim().toLowerCase();
    if (!q) { $('searchResults').innerHTML = ''; return; }
    const results = [];

    for (const f of repo.files) {
      let score = 0;
      const hay = `${f.path} ${(f.symbols || []).join(' ')}`.toLowerCase();
      if (hay.includes(q)) score += 10;
      if (f.content && f.content.toLowerCase().includes(q)) score += 3;
      if (score) results.push({ ...f, score });
    }

    if (backendAvailable && (!repo.source || repo.source === 'server')) {
      try {
        const r = await api('api/search?q=' + encodeURIComponent(q));
        for (const f of r.results || []) if (!results.some(x => x.path === f.path)) results.push(f);
      } catch {}
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0) || a.path.localeCompare(b.path));
    $('searchResults').innerHTML = results.slice(0, 40).map(f => `<div class="result" data-path="${esc(f.path)}"><div class="path">${esc(f.path)}</div><div class="meta">${f.lines || 0} lines · ${(f.symbols || []).length} symbols · ${f.todos || 0} TODO · score ${f.score || 0}</div></div>`).join('');
    $('searchResults').querySelectorAll('.result').forEach(el => el.onclick = () => inspectFile(el.dataset.path));
  }, 250));

  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    mode = b.dataset.mode;
    draw();
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function boot() {
  setupTheme();
  initCardWindows();
  wireControls();
  renderRecentRepos();
  resize();
  await detectBackend();

  if (backendAvailable) {
    try { await scan(false); }
    catch { setStatus('Server mode ready. Open a repo or use static GitHub/folder mode.'); }
  } else {
    setStatus('Static mode ready. Paste a GitHub URL or pick a folder.');
  }
}

boot();
