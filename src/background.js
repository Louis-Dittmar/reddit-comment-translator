/* ------------------------------------------------------------------
 * Reddit DE – Kommentar-Übersetzer :: Hintergrundskript
 *
 * Zuständig für:
 *   - Einstellungen + Cache (Übersetzungen und Beitragssprachen)
 *   - Warteschlange mit begrenzter Parallelität (Standard: 5)
 *   - Spracherkennung: EIN Aufruf pro Beitrag, der eine Stichprobe von
 *     bis zu 5 Kommentaren gemeinsam prüft. Danach steht die Sprache des
 *     Beitrags fest und es folgen keine weiteren Erkennungs-Aufrufe.
 *   - Übersetzung über die Responses-API (Rückfall auf Chat Completions,
 *     falls ein Modell die Responses-API nicht unterstützt)
 * ------------------------------------------------------------------ */

const api = globalThis.browser ?? globalThis.chrome;

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

const CACHE_PREFIX = 'c:'; // Übersetzungen
const THREAD_PREFIX = 't:'; // erkannte Beitragssprachen
const CACHE_LIMIT = 1200;
const THREAD_TTL = 1000 * 60 * 60 * 24 * 7; // 7 Tage

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
  detectMode: 'thread', // 'thread' = 1 Aufruf pro Beitrag, 'comment' = pro Kommentar
  logRequests: true, // store:true -> Anfragen erscheinen in den OpenAI-Logs
  verboseLog: false, // ausführliche Ausgabe in der Browser-Konsole
};

const STATS_KEY = 'usageStats';

/* ------------------------------------------------------------------
 * Einstellungen
 * ------------------------------------------------------------------ */

async function getSettings() {
  const stored = await api.storage.local.get(Object.keys(DEFAULTS));
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (stored[key] !== undefined && stored[key] !== null) out[key] = stored[key];
  }
  out.maxConcurrent = Math.min(5, Math.max(1, Number(out.maxConcurrent) || 5));
  return out;
}

/* ------------------------------------------------------------------
 * Cache
 * ------------------------------------------------------------------ */

function hash(text) {
  // FNV-1a, 32 Bit – reicht als Cache-Schlüssel völlig aus.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16) + ':' + text.length.toString(36);
}

function cacheKey(text, model) {
  return CACHE_PREFIX + model + ':' + hash(text);
}

async function cacheGet(key) {
  const res = await api.storage.local.get(key);
  return res[key] ?? null;
}

async function cacheSet(key, value) {
  await api.storage.local.set({ [key]: { ...value, t: Date.now() } });
  cleanupCache();
}

let cleanupPending = false;
function cleanupCache() {
  if (cleanupPending) return;
  cleanupPending = true;
  setTimeout(async () => {
    cleanupPending = false;
    try {
      const all = await api.storage.local.get(null);
      const entries = Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX));
      if (entries.length <= CACHE_LIMIT) return;
      entries.sort((a, b) => (a[1]?.t ?? 0) - (b[1]?.t ?? 0));
      const drop = entries.slice(0, entries.length - CACHE_LIMIT).map(([k]) => k);
      if (drop.length) await api.storage.local.remove(drop);
    } catch (_) {
      /* nicht kritisch */
    }
  }, 5000);
}

async function clearCache() {
  const all = await api.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX) || k.startsWith(THREAD_PREFIX));
  if (keys.length) await api.storage.local.remove(keys);
  threadLanguages.clear();
  return keys.length;
}

/* ------------------------------------------------------------------
 * Prompts
 * ------------------------------------------------------------------ */

const DETECT_RULES = [
  '- Beurteile die Sprache des Fließtextes. Einzelne englische Lehnwörter, Marken-, Spiel- oder',
  '  Produktnamen, Zitate, Code, URLs, Emojis sowie Reddit-Kürzel (u/name, r/sub, /s, OP, TIL, ELI5)',
  '  machen einen ansonsten deutschen Kommentar NICHT zu einem englischen.',
  '- Ist ein Text zu kurz oder sprachlich nicht bestimmbar (nur Zahlen, Emojis, Links): und',
  '- Bei Mischtext entscheidet die Sprache, in der der größere Teil der Sätze verfasst ist.',
];

const DETECT_BATCH_SYSTEM = [
  'Du bist ein präziser Sprach-Detektor für Reddit-Kommentare.',
  'Du bekommst mehrere Kommentare, jeder eingeleitet durch eine Zeile "### <Nummer>".',
  '',
  'Antworte mit genau einer Zeile: die ISO-639-1 Codes aller Kommentare in derselben',
  'Reihenfolge, klein geschrieben, durch Komma getrennt, ohne Leerzeichen.',
  'Beispiel bei vier Kommentaren: en,en,de,en',
  'Keine Erklärung, keine Nummerierung, kein weiterer Text.',
  '',
  'Regeln:',
  ...DETECT_RULES,
].join('\n');

const DETECT_SINGLE_SYSTEM = [
  'Du bist ein präziser Sprach-Detektor.',
  'Du bekommst den Text eines Reddit-Kommentars und bestimmst dessen Hauptsprache.',
  '',
  'Antworte ausschließlich mit dem ISO-639-1 Sprachcode in Kleinbuchstaben,',
  'z. B.: de, en, fr, es, tr, ru, ar, ja. Keine Erklärung, kein weiterer Text.',
  '',
  'Regeln:',
  ...DETECT_RULES,
].join('\n');

const TRANSLATE_SYSTEM = [
  'Du bist ein professioneller Übersetzer für Online-Foren und übersetzt Reddit-Kommentare ins Deutsche.',
  '',
  'Ausgabe:',
  '- Gib ausschließlich die deutsche Übersetzung aus. Keine Vorrede, keine Erklärungen,',
  '  keine Anführungszeichen um den Gesamttext, kein Hinweis auf die Ausgangssprache.',
  '- Ist der Text bereits vollständig auf Deutsch, gib ihn unverändert und Zeichen für Zeichen',
  '  identisch zurück. Formuliere ihn dann nicht um.',
  '',
  'Struktur (sehr wichtig):',
  '- Übernimm die Zeilen- und Absatzstruktur des Originals exakt: gleiche Anzahl Absätze,',
  '  gleiche Leerzeilen, gleiche Zeilenumbrüche.',
  '- Erhalte Markdown-Zeichen in Funktion und Position: **fett**, *kursiv*, ~~durchgestrichen~~,',
  '  `Code`, Codeblöcke mit ```, Zitatzeilen mit >, Listenpunkte mit - oder 1., Überschriften mit #.',
  '- Links im Format [Text](URL): übersetze nur den Text, die URL bleibt unverändert.',
  '',
  'Inhalt:',
  '- Übersetze natürlich und idiomatisch, nicht wörtlich. Deutsche Redewendungen statt Wort-für-Wort.',
  '- Behalte Ton und Register bei: locker bleibt locker, sachlich bleibt sachlich, ironisch bleibt ironisch,',
  '  derbe Sprache bleibt derb. Duze, wie es in Foren üblich ist.',
  '- Unverändert bleiben: Code, URLs, Benutzer- und Subreddit-Namen (u/name, r/sub), Hashtags,',
  '  Emojis, Zahlen, Einheiten, Eigennamen, Marken, Spiel- und Filmtitel sowie das Sarkasmus-Kürzel /s.',
  '- Gängige Netz-Abkürzungen sinngemäß auflösen (z. B. IMO → meiner Meinung nach, AFAIK → soweit ich weiß),',
  '  wenn das den Satz verständlicher macht. OP bleibt OP.',
].join('\n');

/* ------------------------------------------------------------------
 * API-Zugriff: Responses-API mit Rückfall auf Chat Completions
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function isReasoningModel(model) {
  return /^(gpt-5|o[134])/i.test(String(model || ''));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wird auf false gesetzt, falls die Responses-API nicht erreichbar ist.
let useResponsesApi = true;

/**
 * Kennzeichnet jede Anfrage, damit sie sich in den OpenAI-Logs
 * (platform.openai.com/logs) zuordnen lässt.
 */
function makeMetadata(kind, extra = {}) {
  const meta = { app: 'reddit-de-translator', kind: String(kind) };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') continue;
    meta[key] = String(value).slice(0, 500);
  }
  return meta;
}

async function askModel(opts) {
  const started = Date.now();
  const result = await callApi(opts);
  trackUsage(opts, result.usage, Date.now() - started);
  return result;
}

async function callApi(opts) {
  if (useResponsesApi) {
    try {
      return await request(buildResponsesBody(opts), RESPONSES_URL, readResponsesOutput, opts);
    } catch (err) {
      if (!err || !err.fallbackToChat) throw err;
      useResponsesApi = false;
      console.warn('[Reddit DE] Responses-API nicht verfügbar, nutze Chat Completions:', err.message);
    }
  }
  return request(buildChatBody(opts), CHAT_URL, readChatOutput, opts);
}

function buildResponsesBody({ model, system, user, maxTokens, reasoningEffort, store, metadata }) {
  const body = {
    model,
    instructions: system,
    input: user,
    max_output_tokens: maxTokens,
    store: !!store,
  };
  if (store && metadata) body.metadata = metadata;
  if (isReasoningModel(model)) {
    if (reasoningEffort && reasoningEffort !== 'default') body.reasoning = { effort: reasoningEffort };
  } else {
    body.temperature = 0.2;
  }
  return body;
}

function buildChatBody({ model, system, user, maxTokens, reasoningEffort, store, metadata }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_completion_tokens: maxTokens,
    store: !!store,
  };
  if (store && metadata) body.metadata = metadata;
  if (isReasoningModel(model)) {
    if (reasoningEffort && reasoningEffort !== 'default') body.reasoning_effort = reasoningEffort;
  } else {
    body.temperature = 0.2;
  }
  return body;
}

function readResponsesOutput(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return { text: data.output_text.trim(), truncated: data.status === 'incomplete' };
  }
  const parts = [];
  for (const item of data.output ?? []) {
    if (item.type === 'reasoning') continue;
    for (const chunk of item.content ?? []) {
      if (typeof chunk.text === 'string' && (!chunk.type || chunk.type === 'output_text')) parts.push(chunk.text);
    }
  }
  const truncated = data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens';
  return { text: parts.join('').trim(), truncated };
}

function readChatOutput(data) {
  const choice = data?.choices?.[0];
  const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
  return { text, truncated: choice?.finish_reason === 'length' };
}

function tokenField(body) {
  return 'max_output_tokens' in body ? 'max_output_tokens' : 'max_completion_tokens' in body ? 'max_completion_tokens' : 'max_tokens';
}

async function request(body, url, readOutput, opts) {
  let attempt = 0;
  let delay = 1200;

  for (;;) {
    attempt++;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + opts.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= 3) {
        throw new ApiError(
          'Keine Verbindung zu api.openai.com. Ist der Zugriff in den Add-on-Einstellungen erlaubt? (' +
            (err?.message || err) + ')',
          0
        );
      }
      await sleep(delay);
      delay *= 2;
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const { text, truncated } = readOutput(data);
      if (!text) {
        const field = tokenField(body);
        if (truncated && body[field] < 16000 && attempt < 4) {
          body[field] = Math.min(16000, body[field] * 2);
          continue;
        }
        throw new ApiError('Leere Antwort vom Modell' + (truncated ? ' (Token-Budget erschöpft)' : ''), 200);
      }
      return { text, usage: data?.usage ?? null };
    }

    const raw = await res.text().catch(() => '');
    let msg = raw;
    try {
      msg = JSON.parse(raw)?.error?.message || raw;
    } catch (_) {
      /* Klartext */
    }

    // Responses-API nicht vorhanden oder für dieses Modell nicht nutzbar
    if (url === RESPONSES_URL && (res.status === 404 || res.status === 405) && !/model/i.test(msg)) {
      const err = new ApiError('Responses-API nicht verfügbar: ' + msg, res.status);
      err.fallbackToChat = true;
      throw err;
    }
    if (url === RESPONSES_URL && res.status === 400 && /not supported|unsupported|unknown/i.test(msg) && /endpoint|v1\/responses/i.test(msg)) {
      const err = new ApiError('Modell unterstützt die Responses-API nicht: ' + msg, res.status);
      err.fallbackToChat = true;
      throw err;
    }

    if (res.status === 400 && attempt < 5 && dropUnsupportedParam(body, msg)) continue;

    if (res.status === 401) throw new ApiError('API-Key ungültig oder fehlt (401).', 401);
    if (res.status === 403) throw new ApiError('Zugriff verweigert (403). Ist das Modell für diesen Key freigeschaltet?', 403);
    if (res.status === 404) throw new ApiError('Modell "' + body.model + '" nicht gefunden (404).', 404);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new ApiError(res.status === 429 ? 'Rate-Limit erreicht (429).' : 'Serverfehler (' + res.status + ').', res.status);
    }

    throw new ApiError('API-Fehler ' + res.status + ': ' + (msg || 'unbekannt'), res.status);
  }
}

function dropUnsupportedParam(body, message) {
  const m = String(message || '').toLowerCase();
  for (const key of ['reasoning', 'reasoning_effort', 'temperature', 'store', 'max_output_tokens', 'max_completion_tokens']) {
    if (key in body && m.includes(key)) {
      if (key === 'max_completion_tokens') {
        body.max_tokens = body.max_completion_tokens;
        delete body.max_completion_tokens;
      } else {
        delete body[key];
      }
      return true;
    }
  }
  // Unspezifischer 400er: die häufigsten Auslöser der Reihe nach entfernen.
  for (const key of ['reasoning', 'reasoning_effort', 'temperature', 'store']) {
    if (key in body) {
      delete body[key];
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------
 * Verbrauchsstatistik und Konsolenprotokoll
 * ------------------------------------------------------------------ */

function emptyDay(date) {
  return { date, calls: 0, detect: 0, translate: 0, input: 0, output: 0, reasoning: 0, cached: 0 };
}

function emptyStats() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    today: emptyDay(today),
    total: { since: today, calls: 0, input: 0, output: 0, reasoning: 0, cached: 0 },
  };
}

let statsCache = null;
let statsTimer = null;

async function loadStats() {
  if (statsCache) return statsCache;
  const stored = await api.storage.local.get(STATS_KEY);
  statsCache = stored[STATS_KEY] ?? emptyStats();
  if (!statsCache.today || !statsCache.total) statsCache = emptyStats();
  return statsCache;
}

function saveStatsSoon() {
  if (statsTimer) return;
  statsTimer = setTimeout(async () => {
    statsTimer = null;
    if (statsCache) await api.storage.local.set({ [STATS_KEY]: statsCache });
  }, 1500);
}

function readUsage(usage) {
  if (!usage) return { input: 0, output: 0, reasoning: 0, cached: 0 };
  return {
    // Responses-API: input_tokens / output_tokens, Chat: prompt_tokens / completion_tokens
    input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output: usage.output_tokens ?? usage.completion_tokens ?? 0,
    reasoning:
      usage.output_tokens_details?.reasoning_tokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      0,
    cached:
      usage.input_tokens_details?.cached_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      0,
  };
}

async function trackUsage(opts, usage, ms) {
  const u = readUsage(usage);
  const kind = opts.metadata?.kind ?? 'unbekannt';

  if (opts.verbose) {
    console.info(
      '[Reddit DE] ' + kind.padEnd(9) + ' ' + opts.model +
        '  Eingabe ' + u.input + ' / Ausgabe ' + u.output +
        (u.reasoning ? ' (davon Denken ' + u.reasoning + ')' : '') +
        (u.cached ? ' / zwischengespeichert ' + u.cached : '') +
        '  gesamt ' + (u.input + u.output) +
        '  ' + (ms / 1000).toFixed(1) + 's' +
        (opts.metadata?.post ? '  ' + opts.metadata.post : '') +
        (opts.metadata?.chars ? '  ' + opts.metadata.chars + ' Zeichen' : '')
    );
  }

  try {
    const stats = await loadStats();
    const today = new Date().toISOString().slice(0, 10);
    if (stats.today.date !== today) stats.today = emptyDay(today);

    stats.today.calls++;
    stats.today.input += u.input;
    stats.today.output += u.output;
    stats.today.reasoning += u.reasoning;
    stats.today.cached += u.cached;
    if (kind === 'detect') stats.today.detect++;
    if (kind === 'translate') stats.today.translate++;

    stats.total.calls++;
    stats.total.input += u.input;
    stats.total.output += u.output;
    stats.total.reasoning += u.reasoning;
    stats.total.cached += u.cached;

    saveStatsSoon();
  } catch (_) {
    /* Statistik ist nicht kritisch */
  }
}

/* ------------------------------------------------------------------
 * Schnellfilter (optional, spart Aufrufe – standardmäßig aus)
 * ------------------------------------------------------------------ */

const GERMAN_HINTS =
  /\b(und|oder|nicht|ist|sind|war|waren|ein|eine|einen|einem|einer|der|die|das|den|dem|des|ich|du|er|sie|es|wir|ihr|mit|auch|aber|noch|schon|wenn|weil|dass|dann|man|mein|dein|sein|beim|vom|zum|zur|hier|dort|sehr|mehr|immer|nie|kann|kannst|können|habe|hast|haben|hatte|wird|werden|wurde|muss|müssen|sollte|gibt|halt|eben|doch|mal|ganz|leider|vielleicht|natürlich|überhaupt)\b/gi;

function looksGerman(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 6) return false;
  const hits = (text.match(GERMAN_HINTS) || []).length;
  const umlauts = (text.match(/[äöüßÄÖÜ]/g) || []).length;
  return hits / words > 0.14 || (hits >= 3 && umlauts >= 2);
}

/* ------------------------------------------------------------------
 * Spracherkennung – einmal pro Beitrag
 * ------------------------------------------------------------------ */

// postId -> Promise<{ lang, samples }>. Parallele Anfragen teilen sich
// dasselbe Versprechen, dadurch entsteht genau ein API-Aufruf je Beitrag.
const threadLanguages = new Map();

function majority(codes) {
  const counts = new Map();
  for (const code of codes) {
    if (!code || code === 'und') continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return { lang: best, count: bestCount, total: codes.length };
}

function normalizeLang(raw) {
  const code = String(raw || '').trim().toLowerCase().match(/[a-z]{2,3}/)?.[0] || '';
  if (code === 'deu' || code === 'ger') return 'de';
  if (code === 'eng') return 'en';
  return code;
}

async function detectBatch(samples, settings, postId) {
  const model = settings.detectModel || settings.model;
  const input = samples
    .map((text, i) => '### ' + (i + 1) + '\n' + text.slice(0, 1200))
    .join('\n\n');

  const res = await askModel({
    apiKey: settings.apiKey,
    model,
    system: DETECT_BATCH_SYSTEM,
    user: input,
    maxTokens: isReasoningModel(model) ? 900 : 40,
    reasoningEffort: 'minimal',
    store: settings.logRequests,
    verbose: settings.verboseLog,
    metadata: makeMetadata('detect', { post: postId, samples: samples.length, chars: input.length }),
  });

  const codes = res.text
    .split(/[^a-zA-Z]+/)
    .map(normalizeLang)
    .filter(Boolean);

  return codes;
}

async function detectThreadLanguage(postId, samples, settings) {
  const key = THREAD_PREFIX + postId;

  if (settings.useCache) {
    const hit = await cacheGet(key);
    if (hit && Date.now() - (hit.t ?? 0) < THREAD_TTL) return hit.lang ?? null;
  }

  if (!samples || !samples.length) return null;

  if (settings.fastPrefilter && samples.filter(looksGerman).length > samples.length / 2) {
    if (settings.useCache) await cacheSet(key, { lang: 'de' });
    return 'de';
  }

  const codes = await detectBatch(samples, settings, postId);
  const { lang } = majority(codes);

  console.info(
    '[Reddit DE] Beitrag ' + postId + ': ' + samples.length + ' Kommentare geprüft -> ' +
      (codes.join(',') || 'keine Angabe') + ' => ' + (lang || 'unbestimmt')
  );

  if (lang && settings.useCache) await cacheSet(key, { lang });
  return lang;
}

function getThreadLanguage(postId, samples, settings) {
  if (!postId) return Promise.resolve(null);
  if (threadLanguages.has(postId)) return threadLanguages.get(postId);

  const pending = detectThreadLanguage(postId, samples, settings).catch((err) => {
    // Fehlgeschlagene Erkennung nicht dauerhaft merken
    threadLanguages.delete(postId);
    throw err;
  });
  threadLanguages.set(postId, pending);
  return pending;
}

/* ------------------------------------------------------------------
 * Warteschlange mit begrenzter Parallelität
 * ------------------------------------------------------------------ */

const queue = [];
let running = 0;

function enqueue(task) {
  return new Promise((resolve) => {
    queue.push({ task, resolve });
    pump();
  });
}

async function pump() {
  const settings = await getSettings();
  const limit = settings.maxConcurrent;
  while (running < limit && queue.length) {
    const job = queue.shift();
    running++;
    Promise.resolve()
      .then(() => job.task(settings))
      .then(
        (value) => job.resolve(value),
        (err) => job.resolve({ status: 'error', message: err?.message || String(err) })
      )
      .finally(() => {
        running--;
        pump();
      });
  }
}

/* ------------------------------------------------------------------
 * Kernablauf
 * ------------------------------------------------------------------ */

function sameText(a, b) {
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/[«»„“”"']/g, '').trim().toLowerCase();
  return norm(a) === norm(b);
}

async function processComment({ text, force, postId, samples }, settings) {
  const clean = String(text || '').trim();
  if (!clean) return { status: 'skipped', reason: 'empty' };

  if (clean.replace(/\s+/g, ' ').length < Number(settings.minLength || 0)) {
    return { status: 'skipped', reason: 'too-short' };
  }

  if (!settings.apiKey) {
    return { status: 'error', message: 'Kein API-Key hinterlegt. Bitte in den Add-on-Einstellungen eintragen.' };
  }

  const key = cacheKey(clean, settings.model);

  if (settings.useCache && !force) {
    const hit = await cacheGet(key);
    if (hit) {
      if (hit.lang === 'de') return { status: 'skipped', reason: 'german', lang: 'de', cached: true };
      if (hit.text) return { status: 'ok', text: hit.text, lang: hit.lang, cached: true };
    }
  }

  // --- Schritt 1: Sprache bestimmen ---------------------------------
  let lang = null;

  if (settings.detectMode === 'comment') {
    // Einzelprüfung je Kommentar (mehr Aufrufe, dafür feiner)
    if (settings.fastPrefilter && looksGerman(clean)) {
      if (settings.useCache) await cacheSet(key, { lang: 'de' });
      return { status: 'skipped', reason: 'german', lang: 'de', prefilter: true };
    }
    const model = settings.detectModel || settings.model;
    const res = await askModel({
      apiKey: settings.apiKey,
      model,
      system: DETECT_SINGLE_SYSTEM,
      user: clean.slice(0, 4000),
      maxTokens: isReasoningModel(model) ? 600 : 8,
      reasoningEffort: 'minimal',
      store: settings.logRequests,
      verbose: settings.verboseLog,
      metadata: makeMetadata('detect', { post: postId, scope: 'comment', chars: clean.length }),
    });
    lang = normalizeLang(res.text);
  } else {
    // Ein Aufruf je Beitrag, Ergebnis gilt für alle Kommentare
    lang = await getThreadLanguage(postId, samples, settings);
  }

  if (lang === 'de') {
    if (settings.useCache) await cacheSet(key, { lang: 'de' });
    return { status: 'skipped', reason: 'german', lang: 'de', scope: settings.detectMode };
  }
  if (settings.detectMode === 'comment' && (!lang || lang === 'und' || lang === 'zxx')) {
    return { status: 'skipped', reason: 'undetermined', lang: lang || null };
  }
  // Im Beitragsmodus wird bei unbestimmter Sprache übersetzt – die
  // Übersetzung erkennt deutschen Text selbst und gibt ihn unverändert zurück.

  // --- Schritt 2: Übersetzung ----------------------------------------
  const budget = Math.min(
    16000,
    Math.max(900, Math.ceil(clean.length / 2) + (isReasoningModel(settings.model) ? 1400 : 400))
  );

  const translation = await askModel({
    apiKey: settings.apiKey,
    model: settings.model,
    system: TRANSLATE_SYSTEM,
    user: clean,
    maxTokens: budget,
    reasoningEffort: settings.reasoningEffort,
    store: settings.logRequests,
    verbose: settings.verboseLog,
    metadata: makeMetadata('translate', { post: postId, from: lang, chars: clean.length, budget }),
  });

  const out = translation.text;

  // Rückgabe identisch zum Original -> der Kommentar war bereits deutsch.
  if (sameText(out, clean)) {
    if (settings.useCache) await cacheSet(key, { lang: 'de' });
    return { status: 'skipped', reason: 'german', lang: 'de', viaTranslation: true };
  }

  if (settings.useCache) await cacheSet(key, { lang, text: out });

  return { status: 'ok', text: out, lang, model: settings.model };
}

/* ------------------------------------------------------------------
 * Nachrichten aus Content-Script und Optionsseite
 * ------------------------------------------------------------------ */

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'translate') {
    enqueue((settings) =>
      processComment({ text: msg.text, force: !!msg.force, postId: msg.postId, samples: msg.samples }, settings)
    ).then(sendResponse);
    return true;
  }

  if (msg.type === 'forgetThread') {
    threadLanguages.delete(msg.postId);
    api.storage.local.remove(THREAD_PREFIX + msg.postId).then(
      () => sendResponse({ status: 'ok' }),
      () => sendResponse({ status: 'ok' })
    );
    return true;
  }

  if (msg.type === 'getSettings') {
    getSettings().then((s) => sendResponse({ ...s, apiKey: s.apiKey ? '***' : '' }));
    return true;
  }

  if (msg.type === 'getStats') {
    loadStats().then((stats) => sendResponse({ status: 'ok', stats }));
    return true;
  }

  if (msg.type === 'resetStats') {
    statsCache = emptyStats();
    api.storage.local.set({ [STATS_KEY]: statsCache }).then(
      () => sendResponse({ status: 'ok' }),
      () => sendResponse({ status: 'ok' })
    );
    return true;
  }

  if (msg.type === 'clearCache') {
    clearCache().then((n) => sendResponse({ status: 'ok', removed: n }));
    return true;
  }

  if (msg.type === 'testKey') {
    (async () => {
      const settings = await getSettings();
      const apiKey = msg.apiKey || settings.apiKey;
      const model = msg.model || settings.model;
      if (!apiKey) {
        sendResponse({ status: 'error', message: 'Kein API-Key angegeben.' });
        return;
      }
      const before = useResponsesApi;
      try {
        const r = await askModel({
          apiKey,
          model,
          system: TRANSLATE_SYSTEM,
          user: 'This is a short test comment.\n\nAnd this is a **second** paragraph.',
          maxTokens: isReasoningModel(model) ? 900 : 200,
          reasoningEffort: 'low',
          store: settings.logRequests,
          verbose: true,
          metadata: makeMetadata('test'),
        });
        sendResponse({
          status: 'ok',
          text: r.text,
          model,
          endpoint: useResponsesApi ? 'Responses-API' : 'Chat Completions' + (before ? ' (Rückfall)' : ''),
        });
      } catch (err) {
        sendResponse({ status: 'error', message: err?.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});

// Klick auf das Symbol in der Symbolleiste öffnet die Einstellungen.
if (api.action && api.action.onClicked) {
  api.action.onClicked.addListener(() => api.runtime.openOptionsPage());
}

api.runtime.onInstalled.addListener(async () => {
  const current = await api.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (current[k] === undefined) patch[k] = v;
  }
  if (Object.keys(patch).length) await api.storage.local.set(patch);
});
