/* ------------------------------------------------------------------
 * Reddit DE – Kommentar-Übersetzer :: Einstellungsseite
 * ------------------------------------------------------------------ */

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  enabled: true,
  apiKey: '',
  model: 'gpt-5.4-mini',
  detectModel: 'gpt-5.4-mini',
  reasoningEffort: 'low',
  maxConcurrent: 5,
  autoTranslate: true,
  onlyVisible: true,
  fastPrefilter: false,
  useCache: true,
  minLength: 3,
  detectMode: 'thread',
  logRequests: true,
  verboseLog: false,
};

// Reihenfolge = Empfehlung. Das große Gratis-Kontingent (2,5 Mio. Token/Tag)
// gilt für die Mini-/Nano-Familie; die großen Modelle teilen sich 250k/Tag.
const MODELS = [
  { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini — 2,5 Mio. Token/Tag (empfohlen)' },
  { id: 'gpt-5-mini', label: 'gpt-5-mini — 2,5 Mio. Token/Tag' },
  { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini — 2,5 Mio. Token/Tag' },
  { id: 'gpt-4o-mini', label: 'gpt-4o-mini — 2,5 Mio. Token/Tag' },
  { id: 'gpt-5.4-nano', label: 'gpt-5.4-nano — 2,5 Mio. Token/Tag (schnell, schwächer)' },
  { id: 'gpt-5-nano', label: 'gpt-5-nano — 2,5 Mio. Token/Tag (schnell, schwächer)' },
  { id: 'gpt-4.1-nano', label: 'gpt-4.1-nano — 2,5 Mio. Token/Tag (schnell, schwächer)' },
  { id: 'o4-mini', label: 'o4-mini — 2,5 Mio. Token/Tag' },
  { id: 'o3-mini', label: 'o3-mini — 2,5 Mio. Token/Tag' },
  { id: 'gpt-5.4', label: 'gpt-5.4 — 250k Token/Tag (beste Qualität)' },
  { id: 'gpt-5.2', label: 'gpt-5.2 — 250k Token/Tag' },
  { id: 'gpt-5', label: 'gpt-5 — 250k Token/Tag' },
  { id: 'gpt-4.1', label: 'gpt-4.1 — 250k Token/Tag' },
  { id: 'gpt-4o', label: 'gpt-4o — 250k Token/Tag' },
];

const $ = (id) => document.getElementById(id);

function fillModelSelect(select) {
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    select.appendChild(opt);
  }
}

function setSelectValue(select, value) {
  if (!value) return;
  if (![...select.options].some((o) => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value + ' (eigene Eingabe)';
    select.appendChild(opt);
  }
  select.value = value;
}

function flash(el, message, kind) {
  el.textContent = message;
  el.className = 'status' + (kind ? ' ' + kind : '');
  if (kind === 'ok') {
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.textContent = '';
      el.className = 'status';
    }, 4000);
  }
}

async function load() {
  fillModelSelect($('model'));
  fillModelSelect($('detectModel'));

  const s = { ...DEFAULTS, ...(await api.storage.local.get(Object.keys(DEFAULTS))) };

  $('apiKey').value = s.apiKey || '';
  setSelectValue($('model'), s.model);
  setSelectValue($('detectModel'), s.detectModel);
  $('reasoningEffort').value = s.reasoningEffort || 'low';
  $('enabled').checked = !!s.enabled;
  $('autoTranslate').checked = !!s.autoTranslate;
  $('onlyVisible').checked = !!s.onlyVisible;
  $('useCache').checked = !!s.useCache;
  $('fastPrefilter').checked = !!s.fastPrefilter;
  $('maxConcurrent').value = s.maxConcurrent ?? 5;
  $('minLength').value = s.minLength ?? 3;
  $('detectMode').value = s.detectMode || 'thread';
  $('logRequests').checked = !!s.logRequests;
  $('verboseLog').checked = !!s.verboseLog;
}

async function save() {
  const values = {
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    detectModel: $('detectModel').value,
    reasoningEffort: $('reasoningEffort').value,
    enabled: $('enabled').checked,
    autoTranslate: $('autoTranslate').checked,
    onlyVisible: $('onlyVisible').checked,
    useCache: $('useCache').checked,
    fastPrefilter: $('fastPrefilter').checked,
    maxConcurrent: Math.min(5, Math.max(1, Number($('maxConcurrent').value) || 5)),
    minLength: Math.min(200, Math.max(1, Number($('minLength').value) || 3)),
    detectMode: $('detectMode').value === 'comment' ? 'comment' : 'thread',
    logRequests: $('logRequests').checked,
    verboseLog: $('verboseLog').checked,
  };

  $('maxConcurrent').value = values.maxConcurrent;
  $('minLength').value = values.minLength;

  await api.storage.local.set(values);
  flash($('saveStatus'), 'Gespeichert. Reddit-Tabs neu laden, damit alles greift.', 'ok');
}

/* --- Host-Berechtigung (Firefox erteilt sie in MV3 nicht automatisch) --- */

const ORIGIN = 'https://api.openai.com/*';

async function hasPermission() {
  try {
    if (!api.permissions || !api.permissions.contains) return true;
    return await api.permissions.contains({ origins: [ORIGIN] });
  } catch (_) {
    return true;
  }
}

async function refreshPermissionUi() {
  const granted = await hasPermission();
  $('permSection').hidden = granted;
  if (!granted) flash($('permStatus'), 'Noch nicht erteilt.', 'err');
  return granted;
}

async function grantPermission() {
  try {
    const ok = await api.permissions.request({ origins: [ORIGIN] });
    if (ok) {
      flash($('permStatus'), 'Zugriff erteilt.', 'ok');
      setTimeout(refreshPermissionUi, 300);
    } else {
      flash($('permStatus'), 'Zugriff wurde abgelehnt.', 'err');
    }
  } catch (err) {
    flash($('permStatus'), 'Fehler: ' + (err?.message || err), 'err');
  }
}

async function test() {
  const btn = $('test');
  const status = $('testStatus');
  const sample = $('sample');

  const apiKey = $('apiKey').value.trim();
  if (!apiKey) {
    flash(status, 'Bitte zuerst einen API-Key eintragen.', 'err');
    return;
  }

  if (!(await refreshPermissionUi())) {
    flash(status, 'Bitte zuerst den Zugriff auf api.openai.com erlauben (oben).', 'err');
    return;
  }

  btn.disabled = true;
  sample.hidden = true;
  flash(status, 'Teste …');

  try {
    const res = await api.runtime.sendMessage({
      type: 'testKey',
      apiKey,
      model: $('model').value,
    });
    if (res && res.status === 'ok') {
      flash(status, 'Verbindung steht – ' + (res.endpoint || 'API') + ' antwortet.', 'ok');
      sample.textContent = res.text;
      sample.hidden = false;
    } else {
      flash(status, res?.message || 'Test fehlgeschlagen.', 'err');
    }
  } catch (err) {
    flash(status, 'Fehler: ' + (err?.message || err), 'err');
  } finally {
    btn.disabled = false;
  }
}

/* --- Verbrauchsanzeige -------------------------------------------- */

const nf = new Intl.NumberFormat('de-DE');

function formatTokens(input, output) {
  return nf.format(input + output) + ' Token  (' + nf.format(input) + ' ein / ' + nf.format(output) + ' aus)';
}

async function refreshStats() {
  try {
    const res = await api.runtime.sendMessage({ type: 'getStats' });
    const stats = res?.stats;
    if (!stats) return;

    const t = stats.today;
    const g = stats.total;

    $('statToday').textContent = formatTokens(t.input, t.output);
    $('statCalls').textContent = nf.format(t.calls);
    $('statSplit').textContent = nf.format(t.detect) + ' / ' + nf.format(t.translate);
    $('statReasoning').textContent =
      nf.format(t.reasoning) + (t.cached ? '  ·  ' + nf.format(t.cached) + ' zwischengespeichert' : '');
    $('statTotal').textContent =
      formatTokens(g.input, g.output) + ' in ' + nf.format(g.calls) + ' Aufrufen seit ' + (g.since || '–');
  } catch (err) {
    flash($('statsStatus'), 'Statistik nicht verfügbar: ' + (err?.message || err), 'err');
  }
}

async function resetStats() {
  await api.runtime.sendMessage({ type: 'resetStats' });
  await refreshStats();
  flash($('statsStatus'), 'Zähler zurückgesetzt.', 'ok');
}

async function clearCache() {
  const res = await api.runtime.sendMessage({ type: 'clearCache' });
  flash($('clearStatus'), (res?.removed ?? 0) + ' Einträge gelöscht.', 'ok');
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  refreshPermissionUi();
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('clear').addEventListener('click', clearCache);
  $('grant').addEventListener('click', grantPermission);
  $('refreshStats').addEventListener('click', refreshStats);
  $('resetStats').addEventListener('click', resetStats);
  refreshStats();

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
});
