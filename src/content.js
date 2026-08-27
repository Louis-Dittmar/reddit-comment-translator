/* ------------------------------------------------------------------
 * Reddit DE – Kommentar-Übersetzer :: Content-Script
 *
 * Fügt unter jedem Reddit-Kommentar eine Box mit der deutschen
 * Übersetzung ein. Der Originalkommentar bleibt unangetastet.
 *
 * Unterstützt das neue Reddit (shreddit) und old.reddit.com.
 * ------------------------------------------------------------------ */

(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const BOX_CLASS = 'rdtde-box';
  const MARK = 'rdtdeAttached';

  let settings = {
    enabled: true,
    autoTranslate: true,
    onlyVisible: true,
    minLength: 3,
  };

  /* ----------------------------------------------------------------
   * 1. Text aus dem DOM lesen – mit Zeilen- und Markdown-Struktur
   * ---------------------------------------------------------------- */

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'NOSCRIPT', 'TEMPLATE',
    'FACEPLATE-SCREEN-READER-CONTENT', 'RPL-TOOLTIP',
  ]);

  function extractMarkdown(root) {
    const out = [];

    const push = (s) => out.push(s);

    const inline = (node) => {
      let s = '';
      for (const child of node.childNodes) s += serializeInline(child);
      return s;
    };

    function serializeInline(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return '';
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true' && tag !== 'IMG') return '';

      switch (tag) {
        case 'BR':
          return '\n';
        case 'STRONG':
        case 'B': {
          const t = inline(node).trim();
          return t ? '**' + t + '**' : '';
        }
        case 'EM':
        case 'I': {
          const t = inline(node).trim();
          return t ? '*' + t + '*' : '';
        }
        case 'DEL':
        case 'S':
        case 'STRIKE': {
          const t = inline(node).trim();
          return t ? '~~' + t + '~~' : '';
        }
        case 'CODE': {
          const t = node.textContent;
          return t ? '`' + t + '`' : '';
        }
        case 'A': {
          const text = inline(node).trim();
          const href = node.getAttribute('href') || '';
          if (!text) return '';
          if (!href || href.startsWith('#') || text === href) return text;
          if (/^\/(r|u|user)\//.test(href) && /^\/?(r|u|user)\//.test(text)) return text;
          return '[' + text + '](' + href + ')';
        }
        case 'IMG':
        case 'FACEPLATE-IMG': {
          const alt = node.getAttribute('alt') || '';
          return alt && !/^avatar/i.test(alt) ? alt : '';
        }
        default:
          return inline(node);
      }
    }

    function walkBlock(node, prefix) {
      walkNodes(node.childNodes, prefix);
    }

    function walkNodes(nodes, prefix) {
      for (const child of nodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.nodeValue.replace(/\s+/g, ' ');
          if (t.trim()) push(prefix + t.trim() + '\n\n');
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = child.tagName;
        if (SKIP_TAGS.has(tag)) continue;

        switch (tag) {
          case 'P':
          case 'DIV': {
            const t = inline(child).replace(/[ \t]+\n/g, '\n').trim();
            if (t) push(prefix + t.split('\n').join('\n' + prefix) + '\n\n');
            break;
          }
          case 'H1': case 'H2': case 'H3':
          case 'H4': case 'H5': case 'H6': {
            const level = Number(tag[1]);
            const t = inline(child).trim();
            if (t) push(prefix + '#'.repeat(level) + ' ' + t + '\n\n');
            break;
          }
          case 'UL':
          case 'OL': {
            const ordered = tag === 'OL';
            let i = Number(child.getAttribute('start') || 1);
            for (const li of child.children) {
              if (li.tagName !== 'LI') continue;
              const marker = ordered ? i++ + '. ' : '- ';
              const nested = li.querySelector(':scope > ul, :scope > ol');
              const clone = li.cloneNode(true);
              for (const n of clone.querySelectorAll(':scope > ul, :scope > ol')) n.remove();
              const t = inline(clone).trim();
              if (t) push(prefix + marker + t.split('\n').join('\n' + prefix + '  ') + '\n');
              if (nested) walkNodes([nested], prefix + '  ');
            }
            if (!prefix) push('\n');
            break;
          }
          case 'BLOCKQUOTE': {
            const before = out.length;
            walkBlock(child, '');
            const inner = out.splice(before).join('').trimEnd();
            if (inner) {
              push(inner.split('\n').map((l) => (prefix + '> ' + l).trimEnd()).join('\n') + '\n\n');
            }
            break;
          }
          case 'PRE': {
            const code = child.textContent.replace(/\s+$/, '');
            if (code.trim()) push('```\n' + code + '\n```\n\n');
            break;
          }
          case 'HR':
            push(prefix + '---\n\n');
            break;
          case 'TABLE': {
            for (const row of child.querySelectorAll('tr')) {
              const cells = [...row.children].map((c) => inline(c).trim());
              if (cells.some(Boolean)) push(prefix + '| ' + cells.join(' | ') + ' |\n');
            }
            push('\n');
            break;
          }
          case 'BR':
            push('\n');
            break;
          default: {
            if (child.children.length && /^(UL|OL|P|DIV|BLOCKQUOTE|PRE|TABLE|H[1-6])$/.test(child.children[0].tagName)) {
              walkBlock(child, prefix);
            } else {
              const t = inline(child).trim();
              if (t) push(prefix + t + '\n\n');
            }
          }
        }
      }
    }

    walkBlock(root, '');

    return out
      .join('')
      .replace(/[   ]/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ----------------------------------------------------------------
   * 2. Markdown -> DOM (sicher, ohne innerHTML)
   * ---------------------------------------------------------------- */

  function safeHref(href) {
    try {
      const url = new URL(href, location.origin);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;

  function renderInline(target, text) {
    let last = 0;
    text.replace(INLINE_RE, (match, code, bold, strike, italic, link, url, offset) => {
      if (offset > last) target.appendChild(document.createTextNode(text.slice(last, offset)));
      last = offset + match.length;

      if (code) {
        const el = document.createElement('code');
        el.textContent = code.slice(1, -1);
        target.appendChild(el);
      } else if (bold) {
        const el = document.createElement('strong');
        renderInline(el, bold.slice(2, -2));
        target.appendChild(el);
      } else if (strike) {
        const el = document.createElement('del');
        renderInline(el, strike.slice(2, -2));
        target.appendChild(el);
      } else if (italic) {
        const el = document.createElement('em');
        renderInline(el, italic.slice(1, -1));
        target.appendChild(el);
      } else if (link) {
        const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link);
        const href = m ? safeHref(m[2]) : null;
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer nofollow';
          a.textContent = m[1];
          target.appendChild(a);
        } else {
          target.appendChild(document.createTextNode(link));
        }
      } else if (url) {
        const href = safeHref(url);
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer nofollow';
          a.textContent = url;
          target.appendChild(a);
        } else {
          target.appendChild(document.createTextNode(url));
        }
      }
      return match;
    });
    if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderMultiline(target, text) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (i) target.appendChild(document.createElement('br'));
      renderInline(target, line);
    });
  }

  function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;

    const isBlank = (l) => !l.trim();

    while (i < lines.length) {
      const line = lines[i];

      if (isBlank(line)) { i++; continue; }

      // Codeblock
      const fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        i++;
        const buf = [];
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++; // schließendes ```
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      // Trennlinie
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        frag.appendChild(document.createElement('hr'));
        i++;
        continue;
      }

      // Überschrift
      const head = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        const h = document.createElement('h' + Math.min(4, head[1].length + 2));
        renderInline(h, head[2].trim());
        frag.appendChild(h);
        i++;
        continue;
      }

      // Zitat
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && (/^\s*>/.test(lines[i]) || (buf.length && !isBlank(lines[i])))) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const bq = document.createElement('blockquote');
        bq.appendChild(renderMarkdown(buf.join('\n')));
        frag.appendChild(bq);
        continue;
      }

      // Liste (inklusive Verschachtelung über Einrückung)
      const ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
      const indentOf = (l) => /^(\s*)/.exec(l)[1].length;
      const listItem = ITEM_RE.exec(line);
      if (listItem) {
        const baseIndent = listItem[1].length;
        const ordered = /\d/.test(listItem[2]);
        const list = document.createElement(ordered ? 'ol' : 'ul');

        while (i < lines.length) {
          if (isBlank(lines[i])) {
            const next = lines[i + 1];
            if (next && ITEM_RE.test(next) && indentOf(next) >= baseIndent) { i++; continue; }
            break;
          }

          const m = ITEM_RE.exec(lines[i]);

          if (!m) {
            // Fortsetzungszeile eines Listenpunkts
            if (indentOf(lines[i]) > baseIndent && list.lastElementChild) {
              list.lastElementChild.appendChild(document.createTextNode(' '));
              renderInline(list.lastElementChild, lines[i].trim());
              i++;
              continue;
            }
            break;
          }

          const indent = m[1].length;
          if (indent < baseIndent) break;

          if (indent > baseIndent) {
            // Eingerückter Block -> als Unterliste in den letzten Punkt hängen
            const sub = [];
            while (i < lines.length) {
              if (isBlank(lines[i])) {
                const next = lines[i + 1];
                if (next && !isBlank(next) && indentOf(next) > baseIndent) { sub.push(''); i++; continue; }
                break;
              }
              if (indentOf(lines[i]) <= baseIndent) break;
              sub.push(lines[i]);
              i++;
            }
            const dedent = Math.min(...sub.filter((l) => l.trim()).map(indentOf));
            const host = list.lastElementChild || list.appendChild(document.createElement('li'));
            host.appendChild(renderMarkdown(sub.map((l) => l.slice(dedent)).join('\n')));
            continue;
          }

          if (/\d/.test(m[2]) !== ordered) break;
          const li = document.createElement('li');
          renderInline(li, m[3]);
          list.appendChild(li);
          i++;
        }
        frag.appendChild(list);
        continue;
      }

      // Absatz (bis zur nächsten Leerzeile) – einfache Umbrüche bleiben erhalten
      const buf = [];
      while (
        i < lines.length &&
        !isBlank(lines[i]) &&
        !/^\s*(```|>|#{1,6}\s|(---+|\*\*\*+|___+)\s*$)/.test(lines[i]) &&
        !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) {
        const p = document.createElement('p');
        renderMultiline(p, buf.join('\n'));
        frag.appendChild(p);
      } else {
        i++;
      }
    }

    return frag;
  }

  /* ----------------------------------------------------------------
   * 3. Adapter für die beiden Reddit-Oberflächen
   * ---------------------------------------------------------------- */

  function ownDescendant(host, selector, hostSelector) {
    for (const el of host.querySelectorAll(selector)) {
      if (el.closest(hostSelector) === host) return el;
    }
    return null;
  }

  const shredditAdapter = {
    name: 'shreddit',
    selector: 'shreddit-comment',
    getBody(host) {
      return ownDescendant(host, '[slot="comment"]', 'shreddit-comment');
    },
    getTextRoot(body) {
      return body.querySelector('[id$="-post-rtjson-content"]') || body.querySelector('.md') || body;
    },
    insert(box, body) {
      body.insertAdjacentElement('afterend', box);
    },
    isDeleted(host) {
      return host.hasAttribute('is-comment-deleted') || host.hasAttribute('deleted');
    },
  };

  const oldRedditAdapter = {
    name: 'old',
    selector: '.comment, .thing.comment',
    getBody(host) {
      const entry = host.querySelector(':scope > .entry');
      return entry ? entry.querySelector('.usertext-body > .md') : null;
    },
    getTextRoot(body) {
      return body;
    },
    insert(box, body) {
      box.classList.add('rdtde-old');
      const holder = body.closest('.usertext-body') || body;
      holder.insertAdjacentElement('afterend', box);
    },
    isDeleted(host) {
      return host.classList.contains('deleted');
    },
  };

  const adapters = [shredditAdapter, oldRedditAdapter];

  /* ----------------------------------------------------------------
   * 4. Box aufbauen und Zustände anzeigen
   * ---------------------------------------------------------------- */

  const LANG_NAMES = {
    en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', pt: 'Portugiesisch',
    nl: 'Niederländisch', pl: 'Polnisch', ru: 'Russisch', uk: 'Ukrainisch', tr: 'Türkisch',
    sv: 'Schwedisch', no: 'Norwegisch', nb: 'Norwegisch', da: 'Dänisch', fi: 'Finnisch',
    cs: 'Tschechisch', sk: 'Slowakisch', hu: 'Ungarisch', ro: 'Rumänisch', bg: 'Bulgarisch',
    el: 'Griechisch', he: 'Hebräisch', ar: 'Arabisch', fa: 'Persisch', hi: 'Hindi',
    ja: 'Japanisch', ko: 'Koreanisch', zh: 'Chinesisch', th: 'Thai', vi: 'Vietnamesisch',
    id: 'Indonesisch', ms: 'Malaiisch', hr: 'Kroatisch', sr: 'Serbisch', sl: 'Slowenisch',
    lt: 'Litauisch', lv: 'Lettisch', et: 'Estnisch', ca: 'Katalanisch', gl: 'Galicisch',
    is: 'Isländisch', ga: 'Irisch', af: 'Afrikaans', sw: 'Suaheli', tl: 'Tagalog',
  };

  function langName(code) {
    if (!code) return null;
    return LANG_NAMES[code] || code.toUpperCase();
  }

  function buildBox() {
    const box = document.createElement('div');
    box.className = BOX_CLASS;
    box.dataset.state = 'pending';
    box.setAttribute('lang', 'de');

    const head = document.createElement('div');
    head.className = 'rdtde-head';

    const badge = document.createElement('span');
    badge.className = 'rdtde-badge';
    badge.textContent = 'DE';

    const meta = document.createElement('span');
    meta.className = 'rdtde-meta';

    const actions = document.createElement('span');
    actions.className = 'rdtde-actions';

    const retry = document.createElement('button');
    retry.className = 'rdtde-btn';
    retry.type = 'button';
    retry.title = 'Neu übersetzen';
    retry.setAttribute('aria-label', 'Neu übersetzen');
    retry.textContent = '↻';

    actions.append(retry);
    head.append(badge, meta, actions);

    const body = document.createElement('div');
    body.className = 'rdtde-body';

    box.append(head, body);
    box._meta = meta;
    box._body = body;
    box._retry = retry;
    return box;
  }

  function setStatus(box, state, text, opts = {}) {
    box.dataset.state = state;
    box._meta.textContent = '';
    if (state === 'pending' || state === 'loading') {
      const sp = document.createElement('span');
      sp.className = 'rdtde-spinner';
      box._meta.append(sp, document.createTextNode(' ' + text));
    } else {
      box._meta.textContent = text;
    }
    box._retry.style.display = opts.hideRetry ? 'none' : '';
  }

  function showTranslation(box, result) {
    box._body.textContent = '';
    box._body.appendChild(renderMarkdown(result.text));
    const from = langName(result.lang);
    const bits = [];
    bits.push(from ? 'Übersetzt aus ' + from : 'Deutsche Übersetzung');
    if (result.cached) bits.push('aus dem Zwischenspeicher');
    else if (result.model) bits.push(result.model);
    setStatus(box, 'done', bits.join(' · '));
    box.dataset.state = 'done';
  }

  function showError(box, message) {
    box._body.textContent = message;
    setStatus(box, 'error', 'Übersetzung fehlgeschlagen');
  }

  function removeBox(box) {
    box.classList.add('rdtde-leaving');
    setTimeout(() => box.remove(), 220);
  }

  /* ----------------------------------------------------------------
   * 5. Ablauf pro Kommentar
   * ---------------------------------------------------------------- */

  /* --- Beitrag und Stichprobe für die Spracherkennung --------------- */

  // Die Sprache wird einmal je Beitrag bestimmt. Dafür sammelt das Skript
  // die ersten Kommentare des Beitrags als Stichprobe.
  const SAMPLE_SIZE = 5;
  const SAMPLE_MIN_LENGTH = 15;
  const samplesByPost = new Map();

  function currentPostId() {
    const fromUrl = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    if (fromUrl) return 't3_' + fromUrl[1].toLowerCase();

    const post = document.querySelector('shreddit-post[id]');
    if (post) return post.getAttribute('id');

    const oldPost = document.querySelector('.thing.link[data-fullname]');
    if (oldPost) return oldPost.getAttribute('data-fullname');

    return location.pathname;
  }

  function addSample(postId, text) {
    if (!postId) return;
    let list = samplesByPost.get(postId);
    if (!list) {
      list = [];
      samplesByPost.set(postId, list);
    }
    if (list.length >= SAMPLE_SIZE) return;
    if (text.replace(/\s+/g, ' ').trim().length < SAMPLE_MIN_LENGTH) return;
    if (list.includes(text)) return;
    list.push(text);
  }

  function samplesFor(postId) {
    return samplesByPost.get(postId) ?? [];
  }

  const observedForVisibility = new WeakSet();
  let visibilityObserver = null;

  function ensureVisibilityObserver() {
    if (visibilityObserver) return visibilityObserver;
    visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          visibilityObserver.unobserve(entry.target);
          const job = entry.target._rdtdeJob;
          if (job) job();
        }
      },
      { rootMargin: '500px 0px' }
    );
    return visibilityObserver;
  }

  async function requestTranslation(box, text, force, postId) {
    setStatus(box, 'loading', force ? 'Übersetze neu …' : 'Übersetze …', { hideRetry: true });
    let result;
    try {
      result = await api.runtime.sendMessage({
        type: 'translate',
        text,
        force: !!force,
        postId,
        samples: samplesFor(postId),
      });
    } catch (err) {
      showError(box, 'Verbindung zum Add-on unterbrochen. Seite neu laden.');
      return;
    }
    if (!result) {
      showError(box, 'Keine Antwort vom Add-on.');
      return;
    }

    if (result.status === 'ok') {
      showTranslation(box, result);
      return;
    }
    if (result.status === 'skipped') {
      // Bereits Deutsch oder nicht übersetzbar -> Box wieder entfernen.
      removeBox(box);
      return;
    }
    showError(box, result.message || 'Unbekannter Fehler.');
  }

  function attach(host, adapter) {
    if (host.dataset[MARK]) return;
    if (adapter.isDeleted(host)) return;

    const body = adapter.getBody(host);
    if (!body) return;

    const textRoot = adapter.getTextRoot(body);
    if (!textRoot) return;

    const text = extractMarkdown(textRoot);
    if (!text || text.length < Math.max(1, settings.minLength)) return;
    if (/^\[(gelöscht|entfernt|deleted|removed)\]$/i.test(text)) return;

    host.dataset[MARK] = '1';

    const postId = currentPostId();
    addSample(postId, text);

    const box = buildBox();
    box._retry.addEventListener('click', () => requestTranslation(box, text, true, postId));

    const start = () => {
      if (box.isConnected) return;
      adapter.insert(box, body);
      requestTranslation(box, text, false, postId);
    };

    if (settings.autoTranslate) {
      if (settings.onlyVisible && 'IntersectionObserver' in window) {
        host._rdtdeJob = start;
        if (!observedForVisibility.has(host)) {
          observedForVisibility.add(host);
          ensureVisibilityObserver().observe(host);
        }
      } else {
        start();
      }
    } else {
      // Manueller Modus: kompakte Box mit Auslöser.
      adapter.insert(box, body);
      box.dataset.state = 'idle';
      box._meta.textContent = '';
      const trigger = document.createElement('button');
      trigger.className = 'rdtde-btn';
      trigger.type = 'button';
      trigger.style.width = 'auto';
      trigger.style.padding = '0 6px';
      trigger.textContent = 'Ins Deutsche übersetzen';
      trigger.addEventListener('click', () => requestTranslation(box, text, false, postId));
      box._meta.appendChild(trigger);
      box._retry.style.display = 'none';
    }
  }

  /* ----------------------------------------------------------------
   * 6. Seite beobachten
   * ---------------------------------------------------------------- */

  function scan() {
    if (!settings.enabled) return;
    for (const adapter of adapters) {
      let nodes;
      try {
        nodes = document.querySelectorAll(adapter.selector);
      } catch (_) {
        continue;
      }
      for (const node of nodes) {
        try {
          attach(node, adapter);
        } catch (err) {
          console.debug('[Reddit DE] Kommentar übersprungen:', err);
        }
      }
    }
  }

  let scanTimer = null;
  function scheduleScan(delay = 250) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  function removeAllBoxes() {
    for (const box of document.querySelectorAll('.' + BOX_CLASS)) box.remove();
    for (const host of document.querySelectorAll('[data-' + MARK.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ']')) {
      delete host.dataset[MARK];
    }
  }

  async function init() {
    try {
      const stored = await api.storage.local.get([
        'enabled', 'autoTranslate', 'onlyVisible', 'minLength',
      ]);
      settings = { ...settings, ...stored };
    } catch (_) {
      /* Standardwerte verwenden */
    }

    if (!settings.enabled) return;

    scan();

    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.addedNodes && rec.addedNodes.length) {
          scheduleScan();
          return;
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Reddit ist eine SPA – nach Navigationen erneut prüfen.
    window.addEventListener('popstate', () => scheduleScan(400));
    window.addEventListener('pageshow', () => scheduleScan(400));
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let relevant = false;
    for (const key of ['enabled', 'autoTranslate', 'onlyVisible', 'minLength']) {
      if (key in changes) {
        settings[key] = changes[key].newValue;
        relevant = true;
      }
    }
    if (!relevant) return;
    if (!settings.enabled) removeAllBoxes();
    else scheduleScan(100);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
