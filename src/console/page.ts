/**
 * The console UI, inlined as one string. Keeping it here rather than in a
 * separate asset keeps the package zero-dependency and means the published
 * `dist/` needs no build step beyond tsc.
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>s3node console</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --accent:#2563eb; --danger:#b91c1c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --fg:#e6e6e6; --muted:#9aa0a6; --line:#262a31; --accent:#60a5fa; --danger:#f87171; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:baseline; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .muted { color:var(--muted); font-size:12px; }
  main { display:grid; grid-template-columns:minmax(200px,260px) 1fr; gap:0; min-height:calc(100vh - 53px); }
  @media (max-width:720px) { main { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } }
  aside { border-right:1px solid var(--line); padding:14px; }
  section { padding:14px 20px; overflow-x:auto; }
  button { font:inherit; padding:5px 10px; border:1px solid var(--line); background:transparent; color:var(--fg); border-radius:6px; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.danger { color:var(--danger); }
  input[type=text] { font:inherit; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); width:100%; }
  ul { list-style:none; margin:0; padding:0; }
  li.bucket { padding:6px 8px; border-radius:6px; cursor:pointer; display:flex; justify-content:space-between; gap:8px; }
  li.bucket:hover { background:color-mix(in srgb, var(--accent) 12%, transparent); }
  li.bucket[aria-current=true] { background:color-mix(in srgb, var(--accent) 20%, transparent); font-weight:600; }
  table { border-collapse:collapse; width:100%; min-width:520px; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { font-weight:600; color:var(--muted); font-size:12px; }
  td.key { white-space:normal; word-break:break-all; }
  .row { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
  .grow { flex:1; min-width:160px; }
  .empty { color:var(--muted); padding:20px 0; }
  #error { display:none; margin:10px 20px; padding:8px 12px; border:1px solid var(--danger); color:var(--danger); border-radius:6px; }
</style>
</head>
<body>
<header>
  <h1>s3node</h1>
  <span class="muted" id="info">loading…</span>
</header>
<div id="error"></div>
<main>
  <aside>
    <div class="row">
      <input type="text" id="newBucket" placeholder="new bucket" class="grow">
      <button id="createBucket">Add</button>
    </div>
    <ul id="buckets"></ul>
  </aside>
  <section>
    <div class="row">
      <input type="text" id="prefix" placeholder="prefix filter" class="grow">
      <button id="refresh">Refresh</button>
      <input type="file" id="file" hidden>
      <button id="upload">Upload…</button>
    </div>
    <div id="objects"><p class="empty">Select a bucket.</p></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id)
let current = null

function fail(err) {
  const box = $('error')
  box.textContent = String(err && err.message ? err.message : err)
  box.style.display = 'block'
  setTimeout(() => { box.style.display = 'none' }, 6000)
}

async function api(path, options) {
  const response = await fetch(path, options)
  if (!response.ok) throw new Error(await response.text() || response.statusText)
  const type = response.headers.get('content-type') || ''
  return type.includes('json') ? response.json() : response
}

const units = ['B', 'KB', 'MB', 'GB', 'TB']
function size(bytes) {
  let n = Number(bytes), i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i]
}

async function loadInfo() {
  const info = await api('api/info')
  $('info').textContent = info.region + ' · v' + info.version + ' · ' +
    info.buckets + ' buckets · ' + info.objects + ' objects · ' + size(info.bytes)
}

async function loadBuckets() {
  const { buckets } = await api('api/buckets')
  const list = $('buckets')
  list.innerHTML = ''
  if (!buckets.length) {
    list.innerHTML = '<li class="muted">No buckets yet.</li>'
    return
  }
  for (const bucket of buckets) {
    const li = document.createElement('li')
    li.className = 'bucket'
    li.setAttribute('aria-current', String(bucket.name === current))
    const name = document.createElement('span')
    name.textContent = bucket.name
    name.onclick = () => { current = bucket.name; loadBuckets(); loadObjects() }
    const remove = document.createElement('button')
    remove.className = 'danger'
    remove.textContent = '×'
    remove.title = 'Delete bucket'
    remove.onclick = async (event) => {
      event.stopPropagation()
      if (!confirm('Delete bucket ' + bucket.name + '? It must already be empty.')) return
      try {
        await api('api/bucket?name=' + encodeURIComponent(bucket.name), { method: 'DELETE' })
        if (current === bucket.name) { current = null; $('objects').innerHTML = '<p class="empty">Select a bucket.</p>' }
        await loadBuckets(); await loadInfo()
      } catch (err) { fail(err) }
    }
    li.append(name, remove)
    list.append(li)
  }
}

async function loadObjects() {
  if (!current) return
  const prefix = $('prefix').value
  const { objects } = await api('api/objects?bucket=' + encodeURIComponent(current) +
    '&prefix=' + encodeURIComponent(prefix))
  const host = $('objects')
  host.innerHTML = ''
  if (!objects.length) {
    host.innerHTML = '<p class="empty">No objects.</p>'
    return
  }
  const table = document.createElement('table')
  table.innerHTML = '<thead><tr><th>Key</th><th>Size</th><th>Modified</th><th></th></tr></thead>'
  const body = document.createElement('tbody')
  for (const object of objects) {
    const tr = document.createElement('tr')
    const key = document.createElement('td'); key.className = 'key'; key.textContent = object.key
    const bytes = document.createElement('td'); bytes.textContent = size(object.size)
    const when = document.createElement('td'); when.textContent = new Date(object.lastModified).toLocaleString()
    const actions = document.createElement('td')

    const url = 'api/object?bucket=' + encodeURIComponent(current) + '&key=' + encodeURIComponent(object.key)
    const download = document.createElement('button')
    download.textContent = 'Get'
    download.onclick = () => { window.location.href = url }
    const remove = document.createElement('button')
    remove.className = 'danger'
    remove.textContent = 'Delete'
    remove.onclick = async () => {
      if (!confirm('Delete ' + object.key + '?')) return
      try { await api(url, { method: 'DELETE' }); await loadObjects(); await loadInfo() }
      catch (err) { fail(err) }
    }
    actions.append(download, ' ', remove)
    tr.append(key, bytes, when, actions)
    body.append(tr)
  }
  table.append(body)
  host.append(table)
}

$('createBucket').onclick = async () => {
  const name = $('newBucket').value.trim()
  if (!name) return
  try {
    await api('api/bucket?name=' + encodeURIComponent(name), { method: 'POST' })
    $('newBucket').value = ''
    await loadBuckets(); await loadInfo()
  } catch (err) { fail(err) }
}
$('refresh').onclick = () => loadObjects().catch(fail)
$('prefix').onkeydown = (event) => { if (event.key === 'Enter') loadObjects().catch(fail) }
$('upload').onclick = () => { if (!current) return fail('Select a bucket first.'); $('file').click() }
$('file').onchange = async () => {
  const file = $('file').files[0]
  if (!file) return
  try {
    await api('api/object?bucket=' + encodeURIComponent(current) + '&key=' + encodeURIComponent(file.name),
      { method: 'PUT', body: file })
    $('file').value = ''
    await loadObjects(); await loadInfo()
  } catch (err) { fail(err) }
}

loadInfo().catch(fail)
loadBuckets().catch(fail)
</script>
</body>
</html>
`
