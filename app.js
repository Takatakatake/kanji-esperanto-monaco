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
  let lastCompletionSnapshot = { query: '', fingerprint: '', timestamp: 0 };

  function activeDictionarySet() {
    return DICTIONARY_SETS[activeDictionaryId] || DICTIONARY_SETS[DEFAULT_DICTIONARY_ID];
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

  function currentPrefix(model, position) {
    const line = model.getLineContent(position.lineNumber);
    const col0 = position.column - 1;
    return extractAsciiPrefix(line, col0);
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
        const prefix = extractAsciiPrefix(line, col0);
        if (!prefix || prefix.length < 1) return { suggestions: [] }; // 1文字以上で候補
        let items = await buildItemsForPrefix(prefix, position, col0);
        items = finalizeItems(prefix, items);
        // レース防止: 返却直前のプレフィクスが当初と異なる場合は結果を捨てる
        try {
          if (token && token.isCancellationRequested) return { suggestions: [] };
          const nowPrefix = currentPrefix(model, editor.getPosition());
          if (nowPrefix !== prefix) return { suggestions: [] };
        } catch { }
        // まれに辞書ロードの直後で空になる揺らぎに対応（1回だけ待って再試行）
        const bucketKey = `${activeDictionarySet().id}:${prefix[0].toLowerCase()}`;
        if (!items.length && inflight.has(bucketKey)) {
          try { await inflight.get(bucketKey); } catch { }
          items = await buildItemsForPrefix(prefix, position, col0);
          items = finalizeItems(prefix, items);
        }
        const fingerprint = fingerprintItems(prefix, items);
        lastCompletionSnapshot = { query: prefix, fingerprint, timestamp: Date.now() };
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
    if (!/^[a-z]$/i.test(text)) {
      hideSuggest();
      return;
    }
    try {
      const model = editor.getModel();
      const pos = editor.getPosition();
      const col0 = pos.column - 1;
      const line = model.getLineContent(pos.lineNumber);
      const prefix = extractAsciiPrefix(line, col0);
      if (!prefix) { hideSuggest(); return; }
      const maybe = loadBucket(prefix[0]);
      Promise.resolve(maybe)
        .then(async () => {
          let shouldRetrigger = true;
          try {
            const curModel = editor.getModel();
            const curPos = editor.getPosition();
            if (!curModel || !curPos) return;
            const curCol0 = curPos.column - 1;
            const curLine = curModel.getLineContent(curPos.lineNumber);
            const curPrefix = extractAsciiPrefix(curLine, curCol0);
            if (curPrefix !== prefix) return;
            let projected = await buildItemsForPrefix(prefix, curPos, curCol0);
            projected = finalizeItems(prefix, projected);
            const fingerprint = fingerprintItems(prefix, projected);
            if (lastCompletionSnapshot.query === prefix && lastCompletionSnapshot.fingerprint === fingerprint) {
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

    function setupDictionarySelect() {
      const select = byId('dict-select');
      if (!select) return;
      select.textContent = '';
      for (const dict of Object.values(DICTIONARY_SETS)) {
        const option = document.createElement('option');
        option.value = dict.id;
        option.textContent = dict.label;
        select.appendChild(option);
      }
      select.value = activeDictionaryId;
      select.addEventListener('change', () => {
        const next = select.value;
        if (!DICTIONARY_SETS[next] || next === activeDictionaryId) return;
        activeDictionaryId = next;
        try { localStorage.setItem(DICTIONARY_SET_KEY, activeDictionaryId); } catch {}
        cache.clear();
        inflight.clear();
        reverseCache.clear();
        reverseInflight.clear();
        runAssignmentLookup();
        hideSuggest();
        showToast('割当案を切替えました');
      });
    }

    function assignmentMatchRank(item, rawQuery) {
      const query = String(rawQuery || '').trim();
      if (!query) return -1;
      const kanji = String(item.kanji || '');
      const body = String(item.body || '');
      if (kanji === query || body === query) return 0;
      if (kanji.startsWith(query) || body.startsWith(query)) return 1;
      if (kanji.includes(query) || body.includes(query)) return 2;
      return -1;
    }

    function clearNode(node) {
      while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function renderLookupResults(results, query) {
      const target = byId('lookup-results');
      if (!target) return;
      clearNode(target);
      if (!query) {
        const empty = document.createElement('div');
        empty.className = 'lookup-empty';
        empty.textContent = '漢字を入力してください';
        target.appendChild(empty);
        return;
      }
      if (!results.length) {
        const empty = document.createElement('div');
        empty.className = 'lookup-empty';
        empty.textContent = '該当なし';
        target.appendChild(empty);
        return;
      }
      for (const item of results.slice(0, 80)) {
        const row = document.createElement('div');
        row.className = 'lookup-item';

        const kanji = document.createElement('div');
        kanji.className = 'lookup-kanji';
        kanji.textContent = item.body || item.kanji || '';

        const root = document.createElement('div');
        root.className = 'lookup-root';
        root.textContent = item.root || '';

        const meta = document.createElement('div');
        meta.className = 'lookup-meta';
        const frequency = Number.isFinite(Number(item.frequency)) ? `F${item.frequency}` : '';
        meta.textContent = [item.type, frequency, item.base ? '基本' : ''].filter(Boolean).join(' / ');

        row.appendChild(kanji);
        row.appendChild(root);
        row.appendChild(meta);
        target.appendChild(row);
      }
      if (results.length > 80) {
        const more = document.createElement('div');
        more.className = 'lookup-empty';
        more.textContent = `${results.length}件中80件を表示`;
        target.appendChild(more);
      }
    }

    async function runAssignmentLookup() {
      const input = byId('lookup-query');
      const query = input ? input.value.trim() : '';
      if (!query) { renderLookupResults([], query); return; }
      const items = await loadReverseIndex();
      const results = items
        .map((item, index) => ({ item, index, rank: assignmentMatchRank(item, query) }))
        .filter(entry => entry.rank >= 0)
        .sort((a, b) => (
          a.rank - b.rank
          || String(a.item.kanji || '').length - String(b.item.kanji || '').length
          || String(a.item.body || '').length - String(b.item.body || '').length
          || Number(a.item.priority || 0) - Number(b.item.priority || 0)
          || Number(b.item.frequency || 0) - Number(a.item.frequency || 0)
          || String(a.item.root || '').localeCompare(String(b.item.root || ''))
          || a.index - b.index
        ))
        .map(entry => entry.item);
      renderLookupResults(results, query);
    }

    function setupAssignmentLookup() {
      const panel = byId('assignment-lookup');
      const button = byId('btn-assignment-lookup');
      const input = byId('lookup-query');
      const clear = byId('lookup-clear');
      if (!panel || !button || !input) return;
      const setOpen = (open) => {
        panel.dataset.open = open ? 'true' : 'false';
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          input.focus();
          runAssignmentLookup();
        }
      };
      button.addEventListener('click', () => setOpen(panel.dataset.open !== 'true'));
      input.addEventListener('input', () => runAssignmentLookup());
      clear && clear.addEventListener('click', () => {
        input.value = '';
        renderLookupResults([], '');
        input.focus();
      });
      renderLookupResults([], '');
    }

    setupDictionarySelect();
    setupAssignmentLookup();
    wire('btn-copy', () => copySelectionOrAll());
    wire('btn-paste', () => pasteFromClipboard());
    wire('btn-select-all', () => selectAll());
    wire('btn-share', () => shareSelectionOrAll());
    wire('btn-plain-toggle', () => {
      plainMode = !plainMode;
      const btn = document.getElementById('btn-plain-toggle');
      if (plainMode) { switchToPlain(); btn && (btn.textContent = 'Monacoに戻る'); }
      else { switchToMonaco(); btn && (btn.textContent = 'シンプル編集へ'); }
    });
  })();
  // === End of Mobile-friendly Toolbar ===
});
