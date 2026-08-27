/* ------------------------------------------------------------------
 * Prüft das Hintergrundskript ohne Browser:
 *   - genau EIN Erkennungs-Aufruf je Beitrag (Stichprobe aus 5 Kommentaren)
 *   - Nutzung der Responses-API inklusive Rückfall auf Chat Completions
 *   - deutscher Beitrag  -> keine Übersetzung
 *
 * Aufruf:  node test/background.test.js
 * ------------------------------------------------------------------ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return { ...data };
        if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      },
      async set(obj) {
        Object.assign(data, obj);
      },
      async remove(keys) {
        for (const k of [].concat(keys)) delete data[k];
      },
    },
    onChanged: { addListener() {} },
    _data: data,
  };
}

/**
 * Lädt background.js in einen frischen Kontext.
 * responder(url, body) liefert entweder { status, json } oder { status, text }.
 */
function loadBackground(responder, settings = {}) {
  const calls = [];
  let listener = null;

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, debug() {}, error() {} },
    setTimeout,
    clearTimeout,
    async fetch(url, options) {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      const res = await responder(url, body, calls.length);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        async json() {
          return res.json;
        },
        async text() {
          return res.text ?? JSON.stringify(res.json ?? {});
        },
      };
    },
    browser: {
      storage: createStorage({
        apiKey: 'sk-test',
        useCache: false,
        maxConcurrent: 5,
        detectMode: 'thread',
        ...settings,
      }),
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
        onInstalled: { addListener() {} },
        openOptionsPage() {},
      },
      action: { onClicked: { addListener() {} } },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  const send = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
  return { send, calls, storage: sandbox.browser.storage };
}

/* --- Antwortvorlagen ---------------------------------------------- */

const responsesReply = (text) => ({
  status: 200,
  json: {
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});

const chatReply = (text) => ({
  status: 200,
  json: { choices: [{ message: { content: text }, finish_reason: 'stop' }] },
});

const isDetect = (call) => /Sprach-Detektor/.test(call.body.instructions ?? call.body.messages?.[0]?.content ?? '');

const SAMPLES = [
  'This is the first english comment in the thread.',
  'Second comment, also clearly english and long enough.',
  'Third one talking about something entirely different.',
  'Fourth comment with a bit of ranting about the topic.',
  'Fifth and final sample comment for the language check.',
];

/* --- Test 1: ein Erkennungs-Aufruf für den ganzen Beitrag ---------- */

async function testSingleDetectPerThread() {
  const { send, calls } = loadBackground((url, body) => {
    if (isDetect({ body })) return responsesReply('en,en,en,en,en');
    return responsesReply('ÜBERSETZT: ' + body.input);
  });

  const results = await Promise.all(
    SAMPLES.map((text) => send({ type: 'translate', text, postId: 't3_abc', samples: SAMPLES }))
  );

  const detects = calls.filter(isDetect);
  const translations = calls.filter((c) => !isDetect(c));

  assert.strictEqual(detects.length, 1, 'Es darf genau eine Spracherkennung je Beitrag geben, war: ' + detects.length);
  assert.strictEqual(translations.length, 5, 'Erwartet 5 Übersetzungen, war: ' + translations.length);
  assert.ok(calls.every((c) => c.url.endsWith('/v1/responses')), 'Alle Aufrufe müssen an die Responses-API gehen');
  assert.ok(detects[0].body.input.includes('### 5'), 'Die Erkennung muss alle 5 Kommentare enthalten');
  assert.ok(results.every((r) => r.status === 'ok'), 'Alle Kommentare müssen übersetzt werden');

  // Ein weiterer Kommentar im selben Beitrag: keine erneute Erkennung
  await send({ type: 'translate', text: 'A late sixth comment appears here.', postId: 't3_abc', samples: SAMPLES });
  assert.strictEqual(calls.filter(isDetect).length, 1, 'Nachfolgende Kommentare dürfen keine neue Erkennung auslösen');

  // Anderer Beitrag: genau eine weitere Erkennung
  await send({ type: 'translate', text: 'A comment from another post entirely.', postId: 't3_xyz', samples: SAMPLES });
  assert.strictEqual(calls.filter(isDetect).length, 2, 'Ein neuer Beitrag braucht genau eine eigene Erkennung');

  console.log('  ok  1 Erkennung je Beitrag, danach nur noch Übersetzungen');
}

/* --- Test 2: deutscher Beitrag wird nicht übersetzt ---------------- */

async function testGermanThread() {
  const { send, calls } = loadBackground((url, body) => {
    if (isDetect({ body })) return responsesReply('de,de,de,de,de');
    return responsesReply('sollte nie aufgerufen werden');
  });

  const results = await Promise.all(
    SAMPLES.map((text) => send({ type: 'translate', text, postId: 't3_de', samples: SAMPLES }))
  );

  assert.strictEqual(calls.length, 1, 'Ein deutscher Beitrag darf genau einen Aufruf kosten, war: ' + calls.length);
  assert.ok(results.every((r) => r.status === 'skipped' && r.reason === 'german'), 'Alle Kommentare müssen übersprungen werden');
  console.log('  ok  deutscher Beitrag: 1 Aufruf gesamt, keine Übersetzung');
}

/* --- Test 3: Mehrheitsentscheid bei gemischter Stichprobe ---------- */

async function testMixedSample() {
  const { send, calls } = loadBackground((url, body) => {
    if (isDetect({ body })) return responsesReply('en,en,de,en,und');
    return responsesReply('Deutsche Fassung.');
  });

  const res = await send({ type: 'translate', text: 'Some english comment here.', postId: 't3_mix', samples: SAMPLES });
  assert.strictEqual(res.status, 'ok', 'Mehrheitlich englischer Beitrag muss übersetzt werden');
  assert.strictEqual(res.lang, 'en', 'Quellsprache muss die Mehrheit sein, war: ' + res.lang);
  assert.strictEqual(calls.length, 2, 'Erwartet 1 Erkennung + 1 Übersetzung');
  console.log('  ok  gemischte Stichprobe: Mehrheit entscheidet');
}

/* --- Test 4: deutscher Kommentar im englischen Beitrag ------------- */

async function testGermanCommentInsideEnglishThread() {
  const original = 'Das ist ein deutscher Kommentar mitten im Thread.';
  const { send } = loadBackground((url, body) => {
    if (isDetect({ body })) return responsesReply('en,en,en,en,en');
    return responsesReply(body.input); // Modell gibt deutschen Text unverändert zurück
  });

  const res = await send({ type: 'translate', text: original, postId: 't3_en2', samples: SAMPLES });
  assert.strictEqual(res.status, 'skipped', 'Unveränderte Rückgabe muss als "bereits deutsch" gelten');
  assert.strictEqual(res.reason, 'german');
  console.log('  ok  unveränderte Rückgabe wird als deutsch erkannt');
}

/* --- Test 5: Rückfall auf Chat Completions ------------------------ */

async function testChatFallback() {
  const { send, calls } = loadBackground((url, body) => {
    if (url.endsWith('/v1/responses')) {
      return { status: 404, text: JSON.stringify({ error: { message: 'Unknown endpoint' } }) };
    }
    if (isDetect({ body })) return chatReply('en,en,en,en,en');
    return chatReply('Deutsche Fassung.');
  });

  const res = await send({ type: 'translate', text: 'Hello there, this is english.', postId: 't3_fb', samples: SAMPLES });
  assert.strictEqual(res.status, 'ok', 'Nach dem Rückfall muss übersetzt werden');
  assert.ok(calls.some((c) => c.url.endsWith('/v1/chat/completions')), 'Es muss auf Chat Completions gewechselt werden');
  assert.ok(
    calls.filter((c) => c.url.endsWith('/v1/responses')).length === 1,
    'Nach dem ersten Fehlschlag darf die Responses-API nicht erneut versucht werden'
  );
  console.log('  ok  Rückfall auf Chat Completions funktioniert');
}

/* --- Test 6: Format des Responses-Aufrufs -------------------------- */

async function testResponsesBody() {
  const { send, calls } = loadBackground((url, body) => {
    if (isDetect({ body })) return responsesReply('en,en,en,en,en');
    return responsesReply('Deutsche Fassung.');
  });

  await send({ type: 'translate', text: 'Check the request body please.', postId: 't3_body', samples: SAMPLES });

  const translation = calls.find((c) => !isDetect(c));
  assert.ok(translation.body.instructions, 'instructions fehlt');
  assert.ok(translation.body.input, 'input fehlt');
  assert.ok(translation.body.max_output_tokens > 0, 'max_output_tokens fehlt');
  assert.deepStrictEqual(translation.body.reasoning, { effort: 'low' }, 'reasoning.effort falsch');
  assert.strictEqual(translation.body.store, true, 'store muss standardmäßig true sein (Protokollierung)');
  assert.strictEqual(translation.body.messages, undefined, 'Chat-Format darf nicht verwendet werden');
  console.log('  ok  Responses-Aufruf hat das erwartete Format');
}

/* --- Test 7: Protokollierung bei OpenAI --------------------------- */

async function testLogging() {
  const { send, calls } = loadBackground(
    (url, body) => {
      if (isDetect({ body })) return responsesReply('en,en,en,en,en');
      return responsesReply('Deutsche Fassung.');
    },
    { logRequests: true }
  );

  await send({ type: 'translate', text: 'Please log this request.', postId: 't3_log', samples: SAMPLES });

  for (const call of calls) {
    assert.strictEqual(call.body.store, true, 'store muss true sein, damit die Anfrage in den Logs erscheint');
    assert.ok(call.body.metadata, 'metadata fehlt');
    assert.strictEqual(call.body.metadata.app, 'reddit-de-translator');
    assert.strictEqual(call.body.metadata.post, 't3_log');
  }

  const detect = calls.find(isDetect);
  const translate = calls.find((c) => !isDetect(c));
  assert.strictEqual(detect.body.metadata.kind, 'detect');
  assert.strictEqual(detect.body.metadata.samples, '5', 'Stichprobengröße muss im Log stehen');
  assert.strictEqual(translate.body.metadata.kind, 'translate');
  assert.strictEqual(translate.body.metadata.from, 'en', 'Ausgangssprache muss im Log stehen');
  assert.ok(Number(translate.body.metadata.chars) > 0, 'Zeichenzahl muss im Log stehen');
  assert.ok(Object.values(translate.body.metadata).every((v) => typeof v === 'string'), 'Metadaten müssen Strings sein');

  console.log('  ok  store:true und Metadaten für die OpenAI-Logs gesetzt');
}

/* --- Test 8: Protokollierung abschaltbar -------------------------- */

async function testLoggingDisabled() {
  const { send, calls } = loadBackground(
    (url, body) => {
      if (isDetect({ body })) return responsesReply('en,en,en,en,en');
      return responsesReply('Deutsche Fassung.');
    },
    { logRequests: false }
  );

  await send({ type: 'translate', text: 'Do not log this one.', postId: 't3_nolog', samples: SAMPLES });

  for (const call of calls) {
    assert.strictEqual(call.body.store, false, 'store muss false sein, wenn die Protokollierung aus ist');
    assert.strictEqual(call.body.metadata, undefined, 'ohne Protokollierung dürfen keine Metadaten mitgehen');
  }
  console.log('  ok  Protokollierung lässt sich abschalten');
}

/* --- Test 9: Token-Statistik ------------------------------------- */

async function testUsageStats() {
  const { send, storage } = loadBackground((url, body) => {
    if (isDetect({ body })) {
      return {
        status: 200,
        json: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'en,en,en,en,en' }] }],
          usage: { input_tokens: 100, output_tokens: 10, output_tokens_details: { reasoning_tokens: 6 } },
        },
      };
    }
    return {
      status: 200,
      json: {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Deutsche Fassung.' }] }],
        usage: { input_tokens: 400, output_tokens: 200, output_tokens_details: { reasoning_tokens: 50 } },
      },
    };
  });

  await send({ type: 'translate', text: 'Count my tokens please.', postId: 't3_stats', samples: SAMPLES });
  const res = await send({ type: 'getStats' });
  const stats = res.stats;

  assert.strictEqual(stats.today.calls, 2, 'zwei Aufrufe erwartet');
  assert.strictEqual(stats.today.detect, 1);
  assert.strictEqual(stats.today.translate, 1);
  assert.strictEqual(stats.today.input, 500, 'Eingabe-Token: 100 + 400');
  assert.strictEqual(stats.today.output, 210, 'Ausgabe-Token: 10 + 200');
  assert.strictEqual(stats.today.reasoning, 56, 'Denk-Token: 6 + 50');
  assert.strictEqual(stats.total.calls, 2);

  await send({ type: 'resetStats' });
  const after = (await send({ type: 'getStats' })).stats;
  assert.strictEqual(after.today.calls, 0, 'Zurücksetzen muss die Zähler leeren');

  console.log('  ok  Token-Statistik zählt Ein-/Ausgabe und Denk-Token');
}

/* --- Test 10: Einzelprüfung je Kommentar bleibt möglich ------------ */

async function testCommentMode() {
  const { send, calls } = loadBackground(
    (url, body) => {
      if (isDetect({ body })) return responsesReply('en');
      return responsesReply('Deutsche Fassung.');
    },
    { detectMode: 'comment' }
  );

  await Promise.all(
    SAMPLES.slice(0, 3).map((text) => send({ type: 'translate', text, postId: 't3_cm', samples: SAMPLES }))
  );

  assert.strictEqual(calls.filter(isDetect).length, 3, 'Im Kommentarmodus wird jeder Kommentar einzeln geprüft');
  console.log('  ok  Einzelprüfung je Kommentar weiterhin verfügbar');
}

/* --- Ablauf -------------------------------------------------------- */

(async () => {
  const tests = [
    testSingleDetectPerThread,
    testGermanThread,
    testMixedSample,
    testGermanCommentInsideEnglishThread,
    testChatFallback,
    testResponsesBody,
    testLogging,
    testLoggingDisabled,
    testUsageStats,
    testCommentMode,
  ];

  console.log('background.js');
  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      console.error('  FEHLER in ' + t.name + ': ' + err.message);
      process.exit(1);
    }
  }
  console.log('\nAlle Tests bestanden.');
  process.exit(0);
})();
