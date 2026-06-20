// Monaco AMD loader path
require.config({ paths: { 'vs': 'https://unpkg.com/monaco-editor@0.52.0/min/vs' } });

require(['vs/editor/editor.main'], function () {
  // 言語登録と語境界
  monaco.languages.register({ id: 'kanji-esperanto' });
  monaco.languages.setLanguageConfiguration('kanji-esperanto', {
    // No global flag to avoid stateful RegExp interactions
    wordPattern: /([a-zA-Z]+)|([\u3400-\u9fff\uf900-\ufaff々〻\u02b0-\u02ff\u1d00-\u1d7f\u2070-\u209f\u2c60-\u2c7f\u0300-\u036f]+)/
  });

  // 遅延読込用のシンプルキャッシュ（先頭文字 → アイテム配列）
  const cache = new Map();
  const inflight = new Map();
  const reverseCache = new Map();
  const reverseInflight = new Map();
  const SUGGEST_LIMIT = 100;
  const params = new URLSearchParams(location.search);
  const STRICT = params.get('strict') === '1';
  const DEFAULT_DICTIONARY_ID = 'pejvo-piv-20260614';
  const DICTIONARY_SET_KEY = `ke-dictionary-set-v1:${location.pathname}`;
  const MODE_KEY = window.KE_LOOKUP_MODE_KEY || `ke-lookup-mode-v1:${location.pathname}`;
  const LOOKUP_MODES = { FORWARD: 'forward', REVERSE: 'reverse' };
  const DICTIONARY_SETS = {
    [DEFAULT_DICTIONARY_ID]: {
      id: DEFAULT_DICTIONARY_ID,
      label: 'PEJVO/PIV 2026-06-14',
      bucketUrl: (letter) => `./data/ke-${letter}.json`,
      reverseUrl: './data/reverse.json'
    }
  };
  const STORAGE_KEY = `ke-doc-v1:${location.pathname}`;
  const HISTORY_KEY = `ke-doc-hist-v1:${location.pathname}`;
  const HISTORY_LIMIT = 50;
  let activeDictionaryId = params.get('dict') || DEFAULT_DICTIONARY_ID;
  try {
    activeDictionaryId = params.get('dict') || localStorage.getItem(DICTIONARY_SET_KEY) || DEFAULT_DICTIONARY_ID;
  } catch { }
  if (!DICTIONARY_SETS[activeDictionaryId]) activeDictionaryId = DEFAULT_DICTIONARY_ID;
  let lookupMode = Object.values(LOOKUP_MODES).includes(window.KE_EARLY_LOOKUP_MODE)
    ? window.KE_EARLY_LOOKUP_MODE
    : LOOKUP_MODES.FORWARD;
  try {
    const savedMode = localStorage.getItem(MODE_KEY);
    if (Object.values(LOOKUP_MODES).includes(savedMode)) lookupMode = savedMode;
  } catch { }
  let lastCompletionSnapshot = { mode: lookupMode, query: '', fingerprint: '', timestamp: 0 };

  function activeDictionarySet() {
    return DICTIONARY_SETS[activeDictionaryId] || DICTIONARY_SETS[DEFAULT_DICTIONARY_ID];
  }

  function setLookupMode(mode) {
    lookupMode = mode === LOOKUP_MODES.REVERSE ? LOOKUP_MODES.REVERSE : LOOKUP_MODES.FORWARD;
    window.KE_EARLY_LOOKUP_MODE = lookupMode;
    window.KE_LOOKUP_MODE = lookupMode;
    try { localStorage.setItem(MODE_KEY, lookupMode); } catch { }
    updateModeButton();
    hideSuggest();
    setTimeout(() => editor && editor.trigger('ke', 'editor.action.triggerSuggest', {}), 0);
  }

  function toggleLookupMode() {
    setLookupMode(lookupMode === LOOKUP_MODES.FORWARD ? LOOKUP_MODES.REVERSE : LOOKUP_MODES.FORWARD);
  }

  async function loadBucket(ch) {
    const letter = (ch || '').toLowerCase();
    if (!letter || letter.length !== 1) return [];
    const dictionary = activeDictionarySet();
    const key = `${dictionary.id}:${letter}`;
    if (cache.has(key)) return cache.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const url = dictionary.bucketUrl(letter);
        let res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) {
          // one retry with cache busting to avoid transient 404/opaque
          res = await fetch(url + `?v=${Date.now()}`);
        }
        if (!res.ok) return [];
        const json = await res.json();
        const arr = Array.isArray(json.items) ? json.items : [];
        cache.set(key, arr);
        return arr;
      } catch {
        return [];
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  async function loadReverseIndex() {
    const dictionary = activeDictionarySet();
    const key = dictionary.id;
    if (reverseCache.has(key)) return reverseCache.get(key);
    if (reverseInflight.has(key)) return reverseInflight.get(key);
    const p = (async () => {
      try {
        let res = await fetch(dictionary.reverseUrl, { cache: 'force-cache' });
        if (!res.ok) res = await fetch(dictionary.reverseUrl + `?v=${Date.now()}`);
        if (!res.ok) return [];
        const json = await res.json();
        const arr = Array.isArray(json.items) ? json.items : [];
        reverseCache.set(key, arr);
        return arr;
      } catch {
        return [];
      } finally {
        reverseInflight.delete(key);
      }
    })();
    reverseInflight.set(key, p);
    return p;
  }

  // NOTE: No global fallback (all.json) — use only the active bucket or inline snippets

  function extractAsciiPrefix(line, caret0) {
    // カーソル直前の連続したアルファベットのみを抽出
    // スペースや漢字の後ろのアルファベットだけを取得
    const left = line.slice(0, caret0);
    const m = left.match(/[A-Za-z]+$/);
    return m ? m[0] : '';
  }

  const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff々〻]/;
  const BODY_QUERY_RE = /[A-Za-z\u3400-\u9fff\uf900-\ufaff々〻\u02b0-\u02ff\u1d00-\u1d7f\u2070-\u209f\u2c60-\u2c7f\u0300-\u036f]+$/;

  function extractBodyQuery(line, caret0) {
    const left = line.slice(0, caret0);
    const m = left.match(BODY_QUERY_RE);
    if (!m || !HAN_RE.test(m[0])) return '';
    return m[0];
  }

  function extractQueryForMode(mode, line, caret0) {
    return mode === LOOKUP_MODES.REVERSE ? extractBodyQuery(line, caret0) : extractAsciiPrefix(line, caret0);
  }

  function currentQuery(model, position, mode = lookupMode) {
    const line = model.getLineContent(position.lineNumber);
    const col0 = position.column - 1;
    return extractQueryForMode(mode, line, col0);
  }

  async function buildItemsForPrefix(prefix, position, col0) {
    let source = [];
    const bucket = await loadBucket(prefix[0]);
    if (bucket && bucket.length) {
      source = bucket;
    } else if (Array.isArray(window.KE_SNIPPETS)) {
      source = window.KE_SNIPPETS;
    }

    const query = prefix.toLowerCase();
    const priorityOf = (s, fallback) => {
      const n = Number(s.priority);
      return Number.isFinite(n) ? n : fallback;
    };

    const candidates = source
      .map((s, index) => ({ source: s, index, sourcePrefix: String(s.prefix || '').toLowerCase() }))
      .filter(c => c.sourcePrefix && c.sourcePrefix.startsWith(query))
      .sort((a, b) => {
        const aExact = a.sourcePrefix === query ? 0 : 1;
        const bExact = b.sourcePrefix === query ? 0 : 1;
        return aExact - bExact
          || priorityOf(a.source, a.index) - priorityOf(b.source, b.index)
          || a.sourcePrefix.localeCompare(b.sourcePrefix)
          || String(a.source.body || '').localeCompare(String(b.source.body || ''));
      });

    let exactPreselected = false;
    let items = candidates
      .slice(0, SUGGEST_LIMIT)
      .map(({ source: s, index, sourcePrefix }) => {
        const exact = sourcePrefix === query;
        const priority = priorityOf(s, index);
        const preselect = exact && !exactPreselected;
        if (preselect) exactPreselected = true;
        return {
          label: (s.label || (s.prefix + ' → ' + s.body)),
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: new monaco.Range(position.lineNumber, col0 - prefix.length + 1, position.lineNumber, col0 + 1),
          detail: s.detail || '',
          documentation: s.documentation || undefined,
          sortText: `${exact ? '0' : '1'}${String(priority).padStart(6, '0')}:${sourcePrefix}:${String(s.body || '')}`,
          preselect
        };
      });
    return items;
  }

  function reverseMatchRank(body, query) {
    const haystack = String(body || '').toLowerCase();
    const needle = String(query || '').toLowerCase();
    if (!needle) return -1;
    if (haystack === needle) return 0;
    if (haystack.startsWith(needle)) return 1;
    if (haystack.includes(needle)) return 2;
    return -1;
  }

  async function buildReverseItemsForQuery(query, position, col0) {
    const source = await loadReverseIndex();
    const matches = source
      .map((s, index) => ({ source: s, index, rank: reverseMatchRank(s.body, query) }))
      .filter(c => c.rank >= 0)
      .sort((a, b) => (
        a.rank - b.rank
        || Number(a.source.priority || 0) - Number(b.source.priority || 0)
        || Number(b.source.frequency || 0) - Number(a.source.frequency || 0)
        || String(a.source.body || '').localeCompare(String(b.source.body || ''))
        || String(a.source.root || '').localeCompare(String(b.source.root || ''))
      ));

    let exactPreselected = false;
    return matches
      .slice(0, SUGGEST_LIMIT)
      .map(({ source: s, index, rank }) => {
        const prefixes = Array.isArray(s.prefixes) ? s.prefixes : [];
        const root = String(s.root || s.insertText || prefixes[0] || '');
        const insertText = String(s.insertText || prefixes[0] || root);
        const priority = Number.isFinite(Number(s.priority)) ? Number(s.priority) : index;
        const preselect = rank === 0 && !exactPreselected;
        if (preselect) exactPreselected = true;
        return {
          label: `${s.body} → ${root}`,
          kind: monaco.languages.CompletionItemKind.Reference,
          insertText,
          range: new monaco.Range(position.lineNumber, col0 - query.length + 1, position.lineNumber, col0 + 1),
          detail: prefixes.length ? `入力候補: ${prefixes.join(', ')}` : '',
          documentation: s.documentation || s.detail || '',
          filterText: `${s.body} ${root} ${prefixes.join(' ')}`,
          sortText: `${rank}${String(priority).padStart(6, '0')}:${s.body}:${root}`,
          preselect
        };
      });
  }

  function buildCompletionItems(mode, query, position, col0) {
    return mode === LOOKUP_MODES.REVERSE
      ? buildReverseItemsForQuery(query, position, col0)
      : buildItemsForPrefix(query, position, col0);
  }

  // No test hooks or debug endpoints in production — keep behavior minimal/explicit

  function preloadAllBucketsIfStrict() {
    if (!STRICT) return Promise.resolve();
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    return Promise.all([...letters.map(ch => loadBucket(ch)), loadReverseIndex()]);
  }

  function finalizeItems(prefix, items) {
    const exact = items.filter(i => String(i.sortText || '').startsWith('0'));
    return exact.length ? exact : items;
  }

  function fingerprintItems(prefix, items) {
    const head = items.slice(0, 5).map(i => String(i.label)).join('||');
    return `${prefix}|${items.length}|${head}`;
  }

  function registerProvider() {
    monaco.languages.registerCompletionItemProvider('kanji-esperanto', {
      // 通常入力（a-z）でも補完を自動発火させる
      // onDidType での明示トリガーも併用し、どちらからでも開くように冗長化
      triggerCharacters: 'abcdefghijklmnopqrstuvwxyz'.split(''),
      provideCompletionItems: async (model, position, _context, token) => {
        const line = model.getLineContent(position.lineNumber);
        const col0 = position.column - 1; // 0-based caret index
        const mode = lookupMode;
        const query = extractQueryForMode(mode, line, col0);
        if (!query || query.length < 1) return { suggestions: [] }; // 1文字以上で候補
        let items = await buildCompletionItems(mode, query, position, col0);
        items = finalizeItems(query, items);
        // レース防止: 返却直前のプレフィクスが当初と異なる場合は結果を捨てる
        try {
          if (token && token.isCancellationRequested) return { suggestions: [] };
          const nowQuery = currentQuery(model, editor.getPosition(), mode);
          if (lookupMode !== mode || nowQuery !== query) return { suggestions: [] };
        } catch { }
        // まれに辞書ロードの直後で空になる揺らぎに対応（1回だけ待って再試行）
        const bucketKey = `${activeDictionarySet().id}:${query[0].toLowerCase()}`;
        if (mode === LOOKUP_MODES.FORWARD && !items.length && inflight.has(bucketKey)) {
          try { await inflight.get(bucketKey); } catch { }
          items = await buildCompletionItems(mode, query, position, col0);
          items = finalizeItems(query, items);
        }
        const fingerprint = fingerprintItems(query, items);
        lastCompletionSnapshot = { mode, query, fingerprint, timestamp: Date.now() };
        return { suggestions: items };
      }
    });
  }

  // エディタ作成
  const host = document.getElementById('editor');
  let extraOpts = {};
  try { extraOpts = JSON.parse(host.getAttribute('data-options') || '{}'); } catch { }
  // 直前の内容を復元（ローカル保存）
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { }

  const editor = monaco.editor.create(host, Object.assign({
    value: saved || 'Kiam Okcidento renkontas Orienton kaj surmetas orientan veston, unu sola lingvo akiras du aspektojn — ambaŭ belajn —, kaj naskiĝas nova kompreno.\n何时 西o 遇as 东方on 和 上置as 东方an 服on, 一 独a 语o 获as 二 观ojn — 两 美ajn —, 和 生成as 新a 懂o.\n',
    language: 'kanji-esperanto',
    theme: 'vs',
    fontSize: 16,
    minimap: { enabled: false },
    automaticLayout: true,
    suggestOnTriggerCharacters: true
  }, extraOpts));

  // Ctrl+Space で常に候補を表示
  editor.addAction({
    id: 'ke-trigger-suggest',
    label: 'Kanji Esperanto: Trigger Suggest',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space],
    run: () => editor.trigger('ke', 'editor.action.triggerSuggest', {})
  });

  // ローカル保存 & 履歴（簡易スナップショット）
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  const saveNow = () => {
    try {
      const v = editor.getValue();
      localStorage.setItem(STORAGE_KEY, v);
      let hist = [];
      try { hist = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { }
      const last = hist[hist.length - 1];
      if (!last || last.v !== v) {
        hist.push({ t: Date.now(), v });
        if (hist.length > HISTORY_LIMIT) hist = hist.slice(-HISTORY_LIMIT);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
      }
    } catch { }
  };
  const saveDebounced = debounce(saveNow, 300);
  editor.onDidChangeModelContent(saveDebounced);

  editor.addAction({
    id: 'ke-restore-last-snapshot',
    label: 'KE: Restore Last Snapshot',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyR],
    run: () => {
      try {
        const hist = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        const last = hist[hist.length - 1];
        if (last && typeof last.v === 'string') {
          editor.setValue(last.v);
          localStorage.setItem(STORAGE_KEY, last.v);
        }
      } catch { }
    }
  });

  editor.addAction({
    id: 'ke-clear-storage',
    label: 'KE: Clear Local Storage',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Backspace],
    run: () => {
      try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(HISTORY_KEY); } catch { }
    }
  });

  function hideSuggest() {
    try {
      editor.trigger('ke', 'hideSuggestWidget', {});
    } catch { }
    try {
      const c = editor.getContribution && editor.getContribution('editor.contrib.suggestController');
      if (c && typeof c.cancel === 'function') c.cancel();
    } catch { }
  }

  function updateModeButton() {
    if (typeof window.KE_SET_MODE_BUTTON === 'function') {
      window.KE_SET_MODE_BUTTON(lookupMode);
      return;
    }
    const btn = document.getElementById('btn-mode-toggle');
    if (!btn) return;
    const reverse = lookupMode === LOOKUP_MODES.REVERSE;
    btn.textContent = reverse ? '漢字→語根' : '語根→漢字';
    btn.setAttribute('aria-pressed', reverse ? 'true' : 'false');
    btn.title = reverse ? '漢字からエスペラント語根を検索' : 'エスペラント語根から漢字を入力';
  }
  updateModeButton();
  window.KE_LOOKUP_MODE = lookupMode;
  window.KE_SET_LOOKUP_MODE = setLookupMode;
  window.KE_APP_MODE_READY = true;

  // strict モードは全データ読込後に補完プロバイダを登録（初回から決定的）
  preloadAllBucketsIfStrict().then(registerProvider).catch(registerProvider);

  // Backspace/Delete 後に候補再表示（ローカルに寄せた最小挙動）
  editor.onKeyDown((e) => {
    if (e.keyCode === monaco.KeyCode.Backspace || e.keyCode === monaco.KeyCode.Delete) {
      setTimeout(() => editor.trigger('ke', 'editor.action.triggerSuggest', {}), 0);
    }
    if (e.keyCode === monaco.KeyCode.Space) {
      // 空白入力時は候補を閉じる（次の語根に備えてクリーンな状態へ）
      setTimeout(() => hideSuggest(), 0);
    }
  });
  // 文字入力直後にも確実にサジェストを起動（IMEや環境差の影響を避ける）
  editor.onDidType((text) => {
    // スペースが入力されたら即座に候補を閉じて終了
    if (/^\s$/.test(text)) {
      hideSuggest();
      return;
    }
    const mode = lookupMode;
    // 語根→漢字では a-z 以外を閉じる。漢字→語根では漢字を含む検索語がない場合だけ閉じる。
    if (mode === LOOKUP_MODES.FORWARD && !/^[a-z]$/i.test(text)) {
      hideSuggest();
      return;
    }
    try {
      const model = editor.getModel();
      const pos = editor.getPosition();
      const col0 = pos.column - 1;
      const line = model.getLineContent(pos.lineNumber);
      const query = extractQueryForMode(mode, line, col0);
      if (!query) { hideSuggest(); return; }
      const maybe = mode === LOOKUP_MODES.REVERSE ? loadReverseIndex() : loadBucket(query[0]);
      Promise.resolve(maybe)
        .then(async () => {
          let shouldRetrigger = true;
          try {
            const curModel = editor.getModel();
            const curPos = editor.getPosition();
            if (!curModel || !curPos) return;
            const curCol0 = curPos.column - 1;
            const curLine = curModel.getLineContent(curPos.lineNumber);
            const curQuery = extractQueryForMode(mode, curLine, curCol0);
            if (lookupMode !== mode || curQuery !== query) return;
            let projected = await buildCompletionItems(mode, query, curPos, curCol0);
            projected = finalizeItems(query, projected);
            const fingerprint = fingerprintItems(query, projected);
            if (lastCompletionSnapshot.mode === mode && lastCompletionSnapshot.query === query && lastCompletionSnapshot.fingerprint === fingerprint) {
              shouldRetrigger = false;
            }
          } catch {
            shouldRetrigger = true;
          }
          if (!shouldRetrigger) return;
          hideSuggest();
          setTimeout(() => editor.trigger('ke', 'editor.action.triggerSuggest', {}), 10);
        })
        .catch(() => {
          hideSuggest();
          setTimeout(() => editor.trigger('ke', 'editor.action.triggerSuggest', {}), 10);
        });
    } catch {
      // fallback trigger（失敗時は閉じるより提示を優先）
      hideSuggest();
      setTimeout(() => editor.trigger('ke', 'editor.action.triggerSuggest', {}), 10);
    }
  });
  // 変更イベントでの自動サジェストは行わない

  // === Mobile-friendly Clipboard & Utility Toolbar ===
  (function setupMobileToolbar(){
    const toastEl = document.getElementById('ke-toast');
    const showToast = (msg) => {
      if (!toastEl) { return; }
      toastEl.textContent = msg;
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => { toastEl.textContent = ''; }, 1800);
    };

    const appRoot = document.getElementById('app');
    const plain = document.createElement('textarea');
    plain.id = 'ke-plain';
    plain.style.display = 'none';
    plain.style.width = '100%';
    plain.style.height = '100%';
    plain.style.boxSizing = 'border-box';
    plain.style.fontFamily = 'monospace';
    plain.style.fontSize = '16px';
    plain.style.padding = '10px';
    appRoot.appendChild(plain);

    function switchToPlain() {
      try { plain.value = editor.getValue(); } catch {}
      host.style.display = 'none';
      plain.style.display = 'block';
      plain.focus();
      showToast('テキストエリアに切替（長押しでコピペ可）');
    }
    function switchToMonaco() {
      try { editor.setValue(plain.value); saveNow(); } catch {}
      plain.style.display = 'none';
      host.style.display = 'block';
      editor.focus();
      showToast('Monacoに戻りました');
    }
    let plainMode = false;

    async function copySelectionOrAll() {
      try {
        const model = editor.getModel();
        const sel = editor.getSelection();
        let text = '';
        if (sel && !sel.isEmpty()) {
          text = model.getValueInRange(sel);
        } else {
          text = model.getValue();
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          showToast('コピーしました');
          return;
        }
      } catch {}
      try {
        const ta = document.createElement('textarea');
        ta.value = editor.getModel().getValue();
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('コピーしました（フォールバック）');
      } catch {
        showToast('コピーに失敗しました');
      }
    }

    async function pasteFromClipboard() {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          if (text) {
            const sel = editor.getSelection();
            editor.executeEdits('ke-paste', [{ range: sel, text, forceMoveMarkers: true }]);
            editor.focus();
            showToast('ペーストしました');
            return;
          }
        }
      } catch {}
      const fallback = window.prompt('クリップボード読み取り不可です。ここに貼り付けてください：', '');
      if (fallback != null) {
        const sel = editor.getSelection();
        editor.executeEdits('ke-paste', [{ range: sel, text: String(fallback), forceMoveMarkers: true }]);
        editor.focus();
        showToast('ペーストしました');
      }
    }

    function selectAll() {
      try { editor.trigger('ke', 'editor.action.selectAll'); editor.focus(); showToast('全選択しました'); } catch {}
    }

    async function shareSelectionOrAll() {
      try {
        const model = editor.getModel();
        const sel = editor.getSelection();
        const text = (sel && !sel.isEmpty()) ? model.getValueInRange(sel) : model.getValue();
        if (navigator.share && text) {
          const snippet = text.length > 10000 ? text.slice(0, 10000) + '\n…' : text;
          await navigator.share({ text: snippet, title: 'Kanji Esperanto Text' });
          return;
        }
      } catch {}
      copySelectionOrAll();
    }

    const byId = (id) => document.getElementById(id);
    const wire = (id, fn) => { const el = byId(id); if (el) el.addEventListener('click', fn, { passive: true }); };
    wire('btn-copy', () => copySelectionOrAll());
    wire('btn-paste', () => pasteFromClipboard());
    wire('btn-select-all', () => selectAll());
    wire('btn-share', () => shareSelectionOrAll());
    wire('btn-mode-toggle', () => toggleLookupMode());
    wire('btn-plain-toggle', () => {
      plainMode = !plainMode;
      const btn = document.getElementById('btn-plain-toggle');
      if (plainMode) { switchToPlain(); btn && (btn.textContent = 'Monacoに戻る'); }
      else { switchToMonaco(); btn && (btn.textContent = 'シンプル編集'); }
    });
  })();
  // === End of Mobile-friendly Toolbar ===
});
