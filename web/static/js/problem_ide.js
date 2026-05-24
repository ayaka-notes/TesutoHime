/* Full-screen problem IDE: Monaco editor, per-language completion, run & submit. */
(function () {
  'use strict';
  var CFG = window.IDE_CONFIG;
  var MAX_LEN = 1048576;

  // ---- swallow browser shortcuts that would derail the exam ---------------
  // Ctrl/Cmd + S (save page), P (print), O (open file), U (view source)
  // all leak the student out of the IDE — the worst is Ctrl+S, which
  // reflexively triggered from another editor pops the browser's "save
  // page" dialog instead of saving the code. Monaco itself binds Ctrl+S
  // internally but we intercept at the *document capture phase* so the
  // browser never gets a shot at its default action — required for the
  // kiosk path where Monaco's focus prevents the parent window's
  // listener from ever seeing the event. F5 / Ctrl+R is intentionally
  // NOT blocked: localStorage autosaves the editor, and an emergency
  // refresh is a valid escape hatch.
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var mod = e.ctrlKey || e.metaKey;
    if (mod && (k === 's' || k === 'p' || k === 'o' || k === 'u')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ---- starter templates -------------------------------------------------
  var TEMPLATES = {
    cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n',
    python: '',
    verilog: 'module answer();\n\nendmodule\n',
    git: ''
  };
  // map an OJ language id to a Monaco language id
  var MONACO_LANG = {
    cpp: 'cpp', python: 'python', verilog: 'systemverilog', git: 'plaintext'
  };

  // ---- completion database ----------------------------------------------
  // Categorised symbols. Word-based completion (existing variables in the
  // file) is provided by Monaco itself; this database adds the standard
  // library and language symbols, plus member completion after '.' / '->'.
  var DB = {
    cpp: {
      keywords: ('alignas alignof asm auto break case catch class const constexpr ' +
        'consteval constinit continue decltype default delete do else enum explicit ' +
        'extern for friend goto if inline mutable namespace new noexcept nullptr ' +
        'operator private protected public register reinterpret_cast return sizeof ' +
        'static static_assert static_cast struct switch template this throw try ' +
        'typedef typeid typename union using virtual volatile while ' +
        'bool char char32_t double float int long short signed unsigned void wchar_t ' +
        'true false const_cast dynamic_cast').split(' '),
      headers: ('bits/stdc++.h iostream iomanip sstream fstream vector map ' +
        'unordered_map set unordered_set algorithm string cstring cmath cstdio ' +
        'cstdlib cassert climits cctype queue stack deque list bitset numeric ' +
        'utility tuple functional array memory random chrono complex').split(' '),
      // template containers -> inserted with angle brackets & placeholders
      containers: [
        ['vector', 'vector<${1:int}>'],
        ['map', 'map<${1:int}, ${2:int}>'],
        ['unordered_map', 'unordered_map<${1:int}, ${2:int}>'],
        ['set', 'set<${1:int}>'],
        ['unordered_set', 'unordered_set<${1:int}>'],
        ['multiset', 'multiset<${1:int}>'],
        ['multimap', 'multimap<${1:int}, ${2:int}>'],
        ['pair', 'pair<${1:int}, ${2:int}>'],
        ['tuple', 'tuple<${1:int}, ${2:int}>'],
        ['deque', 'deque<${1:int}>'],
        ['list', 'list<${1:int}>'],
        ['stack', 'stack<${1:int}>'],
        ['queue', 'queue<${1:int}>'],
        ['priority_queue', 'priority_queue<${1:int}>'],
        ['array', 'array<${1:int}, ${2:N}>'],
        ['bitset', 'bitset<${1:N}>'],
        ['shared_ptr', 'shared_ptr<${1:int}>'],
        ['unique_ptr', 'unique_ptr<${1:int}>'],
        ['function', 'function<${1:void()}>'],
      ],
      // non-template types -> inserted as-is
      types: ('string wstring string_view size_t ptrdiff_t int8_t int16_t ' +
        'int32_t int64_t uint8_t uint16_t uint32_t uint64_t ostream istream ' +
        'stringstream istringstream ostringstream ios').split(' '),
      funcs: ('sort stable_sort partial_sort nth_element lower_bound upper_bound ' +
        'binary_search equal_range merge max min minmax max_element min_element ' +
        'accumulate partial_sum reduce reverse rotate unique count count_if find ' +
        'find_if find_if_not fill fill_n iota copy copy_if transform for_each ' +
        'all_of any_of none_of remove remove_if replace next_permutation ' +
        'prev_permutation swap gcd lcm __gcd abs llabs fabs pow sqrt cbrt exp log ' +
        'log2 log10 ceil floor round trunc sin cos tan atan atan2 hypot ' +
        'make_pair make_tuple make_shared make_unique tie get to_string stoi stol ' +
        'stoll stoull stod stof move forward begin end rbegin rend distance ' +
        'advance memset memcpy memcmp malloc free qsort getline scanf printf ' +
        'sscanf sprintf snprintf puts putchar getchar setprecision setw setfill ' +
        'isdigit isalpha isalnum isspace isupper islower tolower toupper ' +
        'emplace_back push_back').split(' '),
      vars: ('cin cout cerr clog endl flush std ios_base fixed scientific ' +
        'boolalpha left right hex dec oct').split(' '),
      macros: ('INT_MAX INT_MIN LLONG_MAX LLONG_MIN UINT_MAX ULLONG_MAX ' +
        'RAND_MAX M_PI EOF NULL CHAR_BIT SIZE_MAX').split(' '),
      members: ('push_back pop_back emplace_back push_front pop_front emplace ' +
        'emplace_hint size length empty clear begin end rbegin rend cbegin cend ' +
        'front back at insert erase find count contains lower_bound upper_bound ' +
        'equal_range resize reserve capacity shrink_to_fit assign swap data c_str ' +
        'substr append replace push pop top max_size unique remove reverse sort ' +
        'merge splice get_allocator str').split(' '),
      memberProps: ('first second').split(' '),
      snippets: [
        ['main', 'int main() {\n\t$0\n\treturn 0;\n}'],
        ['for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t$0\n}'],
        ['forr', 'for (auto ${1:x} : ${2:container}) {\n\t$0\n}'],
        ['while', 'while (${1:cond}) {\n\t$0\n}'],
        ['ifelse', 'if (${1:cond}) {\n\t$2\n} else {\n\t$0\n}'],
        ['include', 'include <$1>'],
        ['cout', 'cout << ${1:x} << "\\n";'],
        ['cin', 'cin >> ${1:x};'],
        ['vector', 'vector<${1:int}> ${2:v}(${3:n});'],
        ['sortv', 'sort(${1:v}.begin(), ${1:v}.end());'],
        ['fastio', 'ios::sync_with_stdio(false);\n\tcin.tie(nullptr);']
      ]
    },
    python: {
      keywords: ('and as assert async await break class continue def del elif else ' +
        'except finally for from global if import in is lambda nonlocal not or ' +
        'pass raise return try while with yield True False None match case').split(' '),
      types: ('int float str bool list dict set tuple frozenset bytes bytearray ' +
        'complex object range').split(' '),
      funcs: ('print input len abs min max sum sorted reversed enumerate zip map ' +
        'filter all any round divmod pow ord chr hex oct bin format repr id hash ' +
        'iter next open eval exec isinstance issubclass type getattr setattr ' +
        'hasattr delattr callable vars dir globals locals super property ' +
        'staticmethod classmethod gcd sqrt floor ceil factorial comb perm ' +
        'log log2 exp defaultdict Counter deque OrderedDict namedtuple ' +
        'heappush heappop heapify bisect_left bisect_right').split(' '),
      vars: ('sys math os collections itertools functools heapq bisect re random ' +
        'string decimal fractions copy inf nan pi e maxsize stdin stdout argv').split(' '),
      macros: [],
      members: ('append extend insert remove pop clear index count sort reverse ' +
        'copy keys values items get setdefault popitem update add discard union ' +
        'intersection difference symmetric_difference issubset issuperset split ' +
        'rsplit splitlines join strip lstrip rstrip replace find rfind startswith ' +
        'endswith lower upper title capitalize swapcase casefold format format_map ' +
        'encode decode isdigit isalpha isalnum isspace isupper islower isnumeric ' +
        'zfill ljust rjust center read readline readlines write writelines close ' +
        'seek tell most_common total bit_length').split(' '),
      memberProps: [],
      snippets: [
        ['main', "def main():\n\t$0\n\n\nif __name__ == '__main__':\n\tmain()"],
        ['for', 'for ${1:i} in range(${2:n}):\n\t$0'],
        ['forr', 'for ${1:x} in ${2:iterable}:\n\t$0'],
        ['while', 'while ${1:cond}:\n\t$0'],
        ['ifelse', 'if ${1:cond}:\n\t$2\nelse:\n\t$0'],
        ['def', 'def ${1:name}(${2:args}):\n\t$0'],
        ['readints', '${1:n}, ${2:m} = map(int, input().split())'],
        ['readall', '${1:data} = sys.stdin.read().split()']
      ]
    }
  };

  // Build the static (hardcoded-database) completion function for a language.
  // For C++ this is only a fallback used while clangd is still downloading or
  // when the browser can't run it; for Python it is the primary provider.
  function makeStaticProvider(monaco, lang) {
    var db = DB[lang];
    var K = monaco.languages.CompletionItemKind;
    var SNIP = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

    function fnItem(name, kind, detail, range, sort) {
      return {
        label: name, kind: kind, detail: detail, range: range,
        insertText: name + '($0)', insertTextRules: SNIP, sortText: sort,
      };
    }
    function plainItem(name, kind, detail, range, sort) {
      return { label: name, kind: kind, detail: detail, range: range,
        insertText: name, sortText: sort };
    }

    return function provideCompletionItems(model, position) {
        if (!db) return { suggestions: [] };
        var word = model.getWordUntilPosition(position);
        var range = {
          startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
          startColumn: word.startColumn, endColumn: word.endColumn,
        };
        var before = model.getValueInRange({
          startLineNumber: position.lineNumber, startColumn: 1,
          endLineNumber: position.lineNumber, endColumn: position.column,
        });
        var memberRe = lang === 'cpp' ? /(\.|->)\s*[A-Za-z_0-9]*$/ : /\.\s*[A-Za-z_0-9]*$/;
        var items = [];

        // inside an #include directive: suggest header names, auto-closing the bracket
        var incMatch = before.match(/^\s*#\s*include\s*(["<])[^">]*$/);
        if (lang === 'cpp' && incMatch) {
          var closer = incMatch[1] === '"' ? '"' : '>';
          var afterChar = model.getLineContent(position.lineNumber)
            .charAt(position.column - 1);
          var suffix = afterChar === closer ? '' : closer;
          (db.headers || []).forEach(function (h) {
            items.push({
              label: h, kind: K.Module, detail: '头文件',
              insertText: h + suffix, range: range, sortText: '1' + h,
            });
          });
          return { suggestions: items };
        }

        if (memberRe.test(before)) {
          // member access: suggest standard-library members
          db.members.forEach(function (m) {
            items.push(fnItem(m, K.Method, '成员函数', range, '1' + m));
          });
          db.memberProps.forEach(function (m) {
            items.push(plainItem(m, K.Field, '成员', range, '0' + m));
          });
          return { suggestions: items };
        }

        (db.containers || []).forEach(function (c) {
          items.push({
            label: c[0], kind: K.Class, detail: '容器',
            insertText: c[1], insertTextRules: SNIP, range: range, sortText: '3' + c[0],
          });
        });
        db.types.forEach(function (t) {
          items.push(plainItem(t, K.Class, '类型', range, '3' + t));
        });
        db.funcs.forEach(function (f) {
          items.push(fnItem(f, K.Function, '标准库函数', range, '4' + f));
        });
        db.vars.forEach(function (v) {
          items.push(plainItem(v, K.Variable, '标准库', range, '5' + v));
        });
        (db.macros || []).forEach(function (m) {
          items.push(plainItem(m, K.Constant, '常量', range, '6' + m));
        });
        db.keywords.forEach(function (kw) {
          items.push(plainItem(kw, K.Keyword, '关键字', range, '7' + kw));
        });
        db.snippets.forEach(function (s) {
          items.push({
            label: s[0], kind: K.Snippet, detail: '代码片段',
            insertText: s[1], insertTextRules: SNIP, range: range, sortText: '2' + s[0],
          });
        });
        return { suggestions: items };
    };
  }

  // Register completion providers. Each LSP-backed language (C++ -> clangd,
  // Python -> pyright) is a hybrid: real semantic completion from its language
  // server once ready, otherwise the static database — so the editor is usable
  // while the server is still loading.
  function registerCompletions(monaco) {
    registerHybrid(monaco, 'cpp', ['.', '>', ':', '<', '"', '/']);
    registerHybrid(monaco, 'python', ['.']);
  }
  function registerHybrid(monaco, lang, triggerChars) {
    var staticProvider = makeStaticProvider(monaco, lang);
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: triggerChars,
      provideCompletionItems: function (model, position, context, token) {
        var c = clients[lang];
        if (c && c.isReady()) return c.provideCompletion(model, position, context);
        return staticProvider(model, position);
      },
      resolveCompletionItem: function (item, token) {
        var c = clients[lang];
        if (item && item._lsp && c) return c.resolveCompletion(item);
        return item;
      },
    });
  }

  // ---- editor state ------------------------------------------------------
  var editor = null, monacoRef = null;
  var langSelect = document.getElementById('ide-language');
  var currentLang = langSelect ? langSelect.value : 'cpp';

  // per-language language-server clients (lsp-monaco.js instances)
  var clients = {};      // language -> client
  var lspState = {};     // language -> 'loading' | 'ready' | 'error' | 'off'
  var lspErr = {};       // language -> error detail string

  function storageKey(lang) { return 'ide_code_' + CFG.problemId + '_' + lang; }
  function seedKey(lang)    { return 'ide_seed_' + CFG.problemId + '_' + lang; }

  // Pick the starter we'd seed today (per-problem starter > generic template).
  function currentStarter(lang) {
    if (CFG.starterCode && typeof CFG.starterCode[lang] === 'string') {
      return CFG.starterCode[lang];
    }
    return TEMPLATES[lang] !== undefined ? TEMPLATES[lang] : '';
  }

  // Markers an earlier version of the importer scribbled into the
  // saved code. If we see them in localStorage, the saved value is
  // auto-generated junk (not a student edit) — replace unconditionally.
  // Otherwise the redefinition lands on top of clangd's force-included
  // prologue.h (which now owns the canonical ListNode/TreeNode defs).
  var STALE_MARKERS = [
    '// --- TesutoHime LeetCode prelude (auto-generated) ---',
    '# --- TesutoHime LeetCode prelude (auto-generated) ---',
  ];
  function looksStaleAutoGenerated(s) {
    if (!s) return false;
    for (var i = 0; i < STALE_MARKERS.length; i++) {
      if (s.indexOf(STALE_MARKERS[i]) !== -1) return true;
    }
    return false;
  }

  function loadCode(lang) {
    var saved = null, seed = null;
    try { saved = localStorage.getItem(storageKey(lang)); } catch (e) {}
    try { seed  = localStorage.getItem(seedKey(lang)); } catch (e) {}
    var starter = currentStarter(lang);

    // First-ever visit OR user wiped their saved code: seed fresh.
    if (saved === null || saved === '') {
      try {
        localStorage.setItem(storageKey(lang), starter);
        localStorage.setItem(seedKey(lang),    starter);
      } catch (e) {}
      return starter;
    }

    // Saved code carries a marker an earlier auto-importer left in it
    // (eg. an in-editor LeetCode helper-types prelude that has since
    // moved into clangd's force-included header — keeping both copies
    // produces ``Redefinition of 'ListNode'``). Treat as never-edited
    // and refresh from the current starter.
    if (looksStaleAutoGenerated(saved)) {
      try {
        localStorage.setItem(storageKey(lang), starter);
        localStorage.setItem(seedKey(lang),    starter);
      } catch (e) {}
      return starter;
    }

    // Saved value matches the last seed we wrote → student hasn't
    // actually edited; if the starter has since changed on the server,
    // pick up the new starter automatically.
    if (seed !== null && saved === seed && starter !== seed) {
      try {
        localStorage.setItem(storageKey(lang), starter);
        localStorage.setItem(seedKey(lang),    starter);
      } catch (e) {}
      return starter;
    }

    // Student has typed something custom — preserve their work.
    return saved;
  }
  function saveCode() {
    if (!editor) return;
    try { localStorage.setItem(storageKey(currentLang), editor.getValue()); } catch (e) {}
  }

  function applyLanguage(lang) {
    var prev = currentLang;
    currentLang = lang;
    if (!editor) return;
    // hand the document from the previous language server to the new one
    if (clients[prev]) clients[prev].didClose();
    var ml = MONACO_LANG[lang] || 'plaintext';
    monacoRef.editor.setModelLanguage(editor.getModel(), ml);
    editor.setValue(loadCode(lang));
    var c = clients[lang];
    if (c && c.isReady()) c.didOpen(editor.getValue());
    refreshLspStatus();
  }

  // ---- language-server status indicator ---------------------------------
  function engineName(lang) {
    return lang === 'cpp' ? 'clangd' : lang === 'python' ? 'Pyright' : '';
  }
  function setLspStatus(state, detail) {
    var el = document.getElementById('ide-clangd-status');
    if (!el) return;
    var eng = engineName(currentLang);
    el.className = 'ide__clangd-status ide__clangd-status--' + state;
    var text = {
      loading: eng + ' 加载中…',
      ready: eng + ' 已就绪',
      error: eng + ' 不可用',
      off: '基础补全',
    }[state] || '';
    var tip = {
      loading: '正在下载并启动 ' + eng + ' 智能引擎（首次较慢，之后走缓存）',
      ready: eng + ' 语义补全 / 悬浮提示 / 错误诊断已启用',
      error: eng + ' 加载失败，已回退到基础补全',
      off: '该语言使用基础补全',
    }[state] || '';
    el.textContent = text;
    el.title = detail || tip;
  }
  // reflect whichever language server backs the currently selected language
  function refreshLspStatus() {
    var st = lspState[currentLang];
    if (!st) { setLspStatus('off'); return; }
    setLspStatus(st, lspErr[currentLang]);
  }

  // Boot one language server for `lang` and wire its lifecycle callbacks.
  function setupLsp(lang, serverKind, workerUrl, docUri, rootUri, initOptions) {
    if (!workerUrl || !window.LspMonaco) { lspState[lang] = 'off'; return; }
    var client = window.LspMonaco.create({
      name: serverKind, serverKind: serverKind, languageId: lang,
      docUri: docUri, rootUri: rootUri,
      workerUrl: workerUrl, logUrl: CFG.clangdLogUrl,
      initializationOptions: initOptions || {},
    });
    if (!client.available()) { lspState[lang] = 'off'; return; }
    clients[lang] = client;
    lspState[lang] = 'loading';
    client.setDiagModel(editor.getModel());
    var bootStart = Date.now();
    client.start(monacoRef, {
      onReady: function () {
        lspState[lang] = 'ready';
        if (currentLang === lang) {
          refreshLspStatus();
          client.didOpen(editor.getValue());
        }
      },
      onError: function (msg) {
        lspState[lang] = 'error';
        lspErr[lang] = msg;
        if (currentLang === lang) refreshLspStatus();
      },
      onProgress: function (value, max) {
        if (currentLang !== lang) return;
        // A cached load streams from disk in well under a second — don't flash
        // a scary download percentage for that; only show it for a real fetch.
        if (Date.now() - bootStart < 800) return;
        var el = document.getElementById('ide-clangd-status');
        if (!el) return;
        var pct = max ? Math.floor(value / max * 100) + '%'
                      : Math.round(value / 1048576) + ' MB';
        el.textContent = engineName(lang) + ' 加载中… ' + pct;
      },
    });
  }

  // ---- Monaco bootstrap --------------------------------------------------
  require.config({ paths: { vs: CFG.monacoVs } });
  require(['vs/editor/editor.main'], function () {
    monacoRef = window.monaco;
    registerCompletions(monacoRef);

    // ---- selectable editor themes ----------------------------------------
    var pinkGutter = {
      'editorLineNumber.foreground': '#d49aa6',
      'editorLineNumber.activeForeground': '#e77c8e',
      'editorCursor.foreground': '#e77c8e',
    };
    monacoRef.editor.defineTheme('acmoj-light', {
      base: 'vs', inherit: true, rules: [], colors: pinkGutter,
    });
    monacoRef.editor.defineTheme('acmoj-warm', {
      base: 'vs', inherit: true,
      rules: [
        { token: 'keyword', foreground: 'c0567a' },
        { token: 'type', foreground: '9c6b3f' },
        { token: 'number', foreground: 'b07d2b' },
        { token: 'string', foreground: 'a85d3c' },
        { token: 'comment', foreground: 'b0a89c', fontStyle: 'italic' },
      ],
      colors: {
        'editor.background': '#fffdfb',
        'editorLineNumber.foreground': '#d8b0a0',
        'editorLineNumber.activeForeground': '#e77c8e',
        'editorCursor.foreground': '#e77c8e',
      },
    });
    monacoRef.editor.defineTheme('acmoj-dark', {
      base: 'vs-dark', inherit: true, rules: [],
      colors: {
        'editorLineNumber.foreground': '#b5707f',
        'editorLineNumber.activeForeground': '#e77c8e',
        'editorCursor.foreground': '#e77c8e',
      },
    });

    var savedTheme = lsGet('ide_theme') || 'acmoj-light';
    var themeSelect = document.getElementById('ide-theme');
    if (themeSelect) {
      themeSelect.value = savedTheme;
      if (themeSelect.value !== savedTheme) {  // stale value -> fall back
        savedTheme = 'acmoj-light';
        themeSelect.value = savedTheme;
      }
      themeSelect.addEventListener('change', function () {
        monacoRef.editor.setTheme(themeSelect.value);
        lsSet('ide_theme', themeSelect.value);
      });
    }

    editor = monacoRef.editor.create(document.getElementById('ide-editor'), {
      value: loadCode(currentLang),
      language: MONACO_LANG[currentLang] || 'plaintext',
      theme: savedTheme,
      fontSize: 14,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 4,
      renderWhitespace: 'selection',
      suggestOnTriggerCharacters: true,
      quickSuggestions: true,
      wordBasedSuggestions: 'currentDocument'
    });
    editor.onDidChangeModelContent(function () {
      saveCode();
      var c = clients[currentLang];
      if (c && c.isReady()) c.didChange(editor.getValue());
    });
    document.getElementById('ide-submit').disabled = false;
    document.getElementById('ide-run').disabled = false;

    // ---- boot the per-language language servers --------------------------
    setupLsp('cpp', 'clangd', CFG.clangdWorker,
             'file:///home/web_user/main.cpp', 'file:///home/web_user', null);
    // pyright resolves its bundled typeshed only when pointed at it via a
    // pyrightconfig.json placed in the workspace root.
    setupLsp('python', 'pyright', CFG.pyrightWorker,
             'file:///src/main.py', 'file:///src/', {
               files: {
                 '/src/main.py': '',
                 '/src/pyrightconfig.json': '{"typeshedPath":"/typeshed"}',
               },
             });
    refreshLspStatus();
  });

  // ---- language switch ---------------------------------------------------
  if (langSelect) {
    langSelect.addEventListener('change', function () {
      saveCode();
      applyLanguage(langSelect.value);
    });
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

  // ---- horizontal splitter (remembers left-pane width) -------------------
  (function () {
    var splitter = document.getElementById('ide-splitter');
    var left = document.getElementById('ide-left');
    var body = document.getElementById('ide-body');
    if (!splitter || !left || !body) return;
    var KEY = 'ide_left_width';
    var dragging = false;

    var saved = parseInt(lsGet(KEY), 10);
    if (saved > 0) left.style.width = saved + 'px';

    splitter.addEventListener('mousedown', function (e) {
      dragging = true; splitter.classList.add('dragging');
      document.body.style.userSelect = 'none'; e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var rect = body.getBoundingClientRect();
      var w = e.clientX - rect.left;
      var min = 240, max = rect.width - 320;
      if (w < min) w = min;
      if (w > max) w = max;
      left.style.width = w + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false; splitter.classList.remove('dragging');
      document.body.style.userSelect = '';
      lsSet(KEY, parseInt(left.style.width, 10));
    });
  })();

  // ---- console vertical resize (remembers console height) ---------------
  (function () {
    var grip = document.getElementById('ide-console-grip');
    var consoleEl = document.getElementById('ide-console');
    if (!grip || !consoleEl) return;
    var KEY = 'ide_console_height';
    var dragging = false;

    var saved = parseInt(lsGet(KEY), 10);
    if (saved > 0) consoleEl.style.flexBasis = saved + 'px';

    grip.addEventListener('mousedown', function (e) {
      dragging = true; grip.classList.add('dragging');
      document.body.style.userSelect = 'none'; e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var h = window.innerHeight - e.clientY;
      if (h < 120) h = 120;
      if (h > window.innerHeight - 220) h = window.innerHeight - 220;
      consoleEl.style.flexBasis = h + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false; grip.classList.remove('dragging');
      document.body.style.userSelect = '';
      lsSet(KEY, parseInt(consoleEl.style.flexBasis, 10));
    });
  })();

  // ---- console tabs ------------------------------------------------------
  function activateTab(name) {
    var tabs = document.querySelectorAll('.ide__tab');
    var panels = document.querySelectorAll('.ide__panel');
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    panels.forEach(function (p) { p.classList.toggle('active', p.dataset.panel === name); });
  }
  document.querySelectorAll('.ide__tab').forEach(function (t) {
    t.addEventListener('click', function () { activateTab(t.dataset.tab); });
  });

  // ---- run (self-test) ---------------------------------------------------
  var runBtn = document.getElementById('ide-run');
  runBtn.addEventListener('click', function () {
    if (!editor) return;
    var code = editor.getValue();
    var input = document.getElementById('ide-input').value;
    var resultMeta = document.getElementById('ide-result-meta');
    var resultOut = document.getElementById('ide-result-output');
    activateTab('result');
    resultMeta.innerHTML = '<span class="ide__result-muted"><span class="ide__spinner"></span>正在沙箱中编译运行…</span>';
    resultOut.textContent = '';
    runBtn.disabled = true;
    var origLabel = runBtn.textContent;
    runBtn.textContent = '运行中…';

    fetch(CFG.runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Acmoj-Is-Csrf': 'no' },
      body: JSON.stringify({ language: currentLang, code: code, input: input })
    }).then(function (r) {
      if (r.status === 404) throw new Error('自测运行服务尚未部署');
      return r.json();
    }).then(function (data) {
      if (data.error) {
        resultMeta.innerHTML = '<span class="ide__result-bad">' + escapeHtml(data.error) + '</span>';
        resultOut.textContent = data.output || data.compile_message || '';
        return;
      }
      var ok = data.status === 'ok';
      var label = { ok: '运行完成', compile_error: '编译错误', time_limit_exceeded: '超出时间限制',
        runtime_error: '运行时错误', memory_limit_exceeded: '超出内存限制' }[data.status] || data.status;
      var meta = '<span class="' + (ok ? 'ide__result-ok' : 'ide__result-bad') + '">' + label + '</span>';
      if (data.time_msecs != null) meta += ' <span class="ide__result-muted">· 用时 ' + data.time_msecs + ' ms</span>';
      if (data.memory_bytes != null) meta += ' <span class="ide__result-muted">· 内存 ' + Math.round(data.memory_bytes / 1024) + ' KiB</span>';
      resultMeta.innerHTML = meta;
      if (data.status === 'compile_error') {
        resultOut.textContent = data.compile_message || '(无编译输出)';
      } else {
        var out = data.output != null ? data.output : '';
        if (data.stderr) out += (out ? '\n' : '') + '[stderr]\n' + data.stderr;
        resultOut.textContent = out || '(无输出)';
      }
    }).catch(function (e) {
      resultMeta.innerHTML = '<span class="ide__result-bad">' + escapeHtml(e.message || '运行失败') + '</span>';
      resultOut.textContent = '';
    }).then(function () {
      runBtn.disabled = false;
      runBtn.textContent = origLabel;
    });
  });

  // ---- submit ------------------------------------------------------------
  document.getElementById('ide-submit').addEventListener('click', function () {
    if (!editor) return;
    var code = editor.getValue();
    if (code.length === 0) { alert('代码不能为空'); return; }
    if (code.length > MAX_LEN) { alert('代码超过长度上限'); return; }
    saveCode();
    var form = document.getElementById('ide-submit-form');
    form.querySelector('[name=language]').value = currentLang;
    form.querySelector('[name=code]').value = code;
    var pub = document.getElementById('ide-public');
    var pubInput = form.querySelector('[name=public]');
    if (pub && pubInput) { pubInput.disabled = !pub.checked; }
    form.submit();
  });

  function escapeHtml(s) {
    return String(s).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
