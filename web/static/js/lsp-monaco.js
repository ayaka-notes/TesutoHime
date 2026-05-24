/* ===========================================================================
 * lsp-monaco.js — real IntelliSense for the problem IDE, per language.
 *
 * A reusable factory: window.LspMonaco.create(opts) builds one Language Server
 * client that boots a language server in a Web Worker and bridges it to Monaco
 * via the Language Server Protocol (completion / hover / signature help / live
 * diagnostics). The IDE creates one per language:
 *   - C++    -> clangd  (clangd-worker.js, WebAssembly, needs cross-origin iso)
 *   - Python -> pyright (pyright.worker.js, pure JS, foreground+background)
 *
 * Both speak plain LSP JSON-RPC objects over postMessage; only the boot
 * handshake differs, which is what serverKind selects.
 *
 * opts: { name, serverKind:'clangd'|'pyright', languageId, docUri, rootUri,
 *         workerUrl, logUrl }
 * client: { available, start, isReady, setDiagModel,
 *           didOpen, didChange, didClose, provideCompletion, resolveCompletion }
 * ======================================================================== */
window.LspMonaco = (function () {
  'use strict';

  function create(opts) {
    opts = opts || {};
    var NAME = opts.name || 'lsp';
    var SERVER = opts.serverKind;            // 'clangd' | 'pyright'
    var LANG = opts.languageId;              // Monaco/LSP language id
    var DOC_URI = opts.docUri;
    var ROOT_URI = opts.rootUri || 'file:///home/web_user';

    // ---- per-client state ------------------------------------------------
    var monaco = null;
    var worker = null;
    var bgWorkers = [];
    var ready = false;
    var opened = false;
    var nextId = 1;
    var pending = {};
    var docVersion = 0;
    var lastSentText = null;
    var diagModel = null;
    var diagUrl = opts.logUrl || null;
    var bootTimer = null;
    var KIND = {}, SEVERITY = {};

    // ---- diagnostics relay (to console + optionally the server log) ------
    function diag(msg) {
      try { console.log('[' + NAME + '] ' + msg); } catch (e) {}
      if (!diagUrl) return;
      try {
        fetch(diagUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Acmoj-Is-Csrf': 'no' },
          body: JSON.stringify({ msg: '[' + NAME + '] ' + String(msg) }),
          keepalive: true,
        });
      } catch (e) {}
    }

    function buildEnumTables() {
      var C = monaco.languages.CompletionItemKind;
      KIND = {
        1: C.Text, 2: C.Method, 3: C.Function, 4: C.Constructor, 5: C.Field,
        6: C.Variable, 7: C.Class, 8: C.Interface, 9: C.Module, 10: C.Property,
        11: C.Unit, 12: C.Value, 13: C.Enum, 14: C.Keyword, 15: C.Snippet,
        16: C.Color, 17: C.File, 18: C.Reference, 19: C.Folder,
        20: C.EnumMember, 21: C.Constant, 22: C.Struct, 23: C.Event,
        24: C.Operator, 25: C.TypeParameter,
      };
      var S = monaco.MarkerSeverity;
      SEVERITY = { 1: S.Error, 2: S.Warning, 3: S.Info, 4: S.Hint };
    }

    // ---- JSON-RPC over the worker ---------------------------------------
    function send(obj) { if (worker) worker.postMessage(obj); }
    function notify(method, params) {
      send({ jsonrpc: '2.0', method: method, params: params });
    }
    function request(method, params) {
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        send({ jsonrpc: '2.0', id: id, method: method, params: params });
      });
    }

    function onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      // response to one of our requests
      if (msg.id !== undefined && msg.method === undefined) {
        var p = pending[msg.id];
        if (p) {
          delete pending[msg.id];
          if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
        }
        return;
      }
      // a request from the server -> acknowledge so it isn't left waiting
      if (msg.id !== undefined && msg.method !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, result: null });
        return;
      }
      // a notification
      if (msg.method === 'textDocument/publishDiagnostics') {
        applyDiagnostics(msg.params);
      }
    }

    // ---- diagnostics -----------------------------------------------------
    function applyDiagnostics(params) {
      if (!diagModel || diagModel.isDisposed()) return;
      if (params.uri !== DOC_URI) return;
      var markers = (params.diagnostics || []).map(function (d) {
        return {
          severity: SEVERITY[d.severity] || monaco.MarkerSeverity.Error,
          message: d.message,
          source: d.source || NAME,
          startLineNumber: d.range.start.line + 1,
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
        };
      });
      monaco.editor.setModelMarkers(diagModel, NAME, markers);
    }
    function clearDiagnostics() {
      if (diagModel && !diagModel.isDisposed()) {
        monaco.editor.setModelMarkers(diagModel, NAME, []);
      }
    }

    // ---- document synchronisation ---------------------------------------
    function didOpen(text) {
      if (!ready) return;
      if (opened) { didChange(text); return; }
      opened = true;
      docVersion = 1;
      lastSentText = text;
      notify('textDocument/didOpen', {
        textDocument: {
          uri: DOC_URI, languageId: LANG, version: docVersion, text: text,
        },
      });
    }
    function didChange(text) {
      if (!ready || !opened) return;
      if (text === lastSentText) return;
      lastSentText = text;
      docVersion += 1;
      notify('textDocument/didChange', {
        textDocument: { uri: DOC_URI, version: docVersion },
        contentChanges: [{ text: text }],
      });
    }
    function didClose() {
      if (!ready || !opened) return;
      opened = false;
      lastSentText = null;
      notify('textDocument/didClose', { textDocument: { uri: DOC_URI } });
      clearDiagnostics();
    }

    // ---- coordinate / content helpers -----------------------------------
    function lspPos(position) {
      return { line: position.lineNumber - 1, character: position.column - 1 };
    }
    function monacoRange(r) {
      return {
        startLineNumber: r.start.line + 1, startColumn: r.start.character + 1,
        endLineNumber: r.end.line + 1, endColumn: r.end.character + 1,
      };
    }
    function asMarkdown(v) {
      if (v == null) return undefined;
      if (typeof v === 'string') return { value: v };
      if (Array.isArray(v)) {
        return { value: v.map(function (x) { return asMarkdown(x).value; }).join('\n\n') };
      }
      if (v.kind || v.value !== undefined) return { value: v.value || '' };
      if (v.language) return { value: '```' + v.language + '\n' + v.value + '\n```' };
      return { value: String(v) };
    }

    // ---- completion ------------------------------------------------------
    function toMonacoCompletion(lspItem, defaultRange) {
      var item = {
        label: (lspItem.label || '').replace(/^\s+/, ''),
        kind: KIND[lspItem.kind] || monaco.languages.CompletionItemKind.Text,
        detail: lspItem.detail,
        sortText: lspItem.sortText,
        filterText: lspItem.filterText,
        insertText: lspItem.insertText || lspItem.label,
        range: defaultRange,
        _lsp: lspItem,
      };
      var edit = lspItem.textEdit;
      if (edit) {
        item.insertText = edit.newText;
        var r = edit.range || edit.replace || edit.insert;
        if (r) item.range = monacoRange(r);
      }
      if (lspItem.insertTextFormat === 2) {
        item.insertTextRules =
          monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      }
      if (lspItem.documentation) item.documentation = asMarkdown(lspItem.documentation);
      if (lspItem.additionalTextEdits) {
        item.additionalTextEdits = lspItem.additionalTextEdits.map(function (e) {
          return { range: monacoRange(e.range), text: e.newText };
        });
      }
      if (lspItem.command) item.command = lspItem.command;
      return item;
    }

    function provideCompletion(model, position, context) {
      if (!ready || !opened) return { suggestions: [] };
      didChange(model.getValue());
      var word = model.getWordUntilPosition(position);
      var defaultRange = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: word.startColumn, endColumn: word.endColumn,
      };
      var ctx = { triggerKind: 1 };
      if (context && context.triggerKind === 1) {
        ctx = { triggerKind: 2, triggerCharacter: context.triggerCharacter };
      }
      return request('textDocument/completion', {
        textDocument: { uri: DOC_URI },
        position: lspPos(position),
        context: ctx,
      }).then(function (result) {
        if (!result) return { suggestions: [] };
        var items = Array.isArray(result) ? result : (result.items || []);
        return {
          incomplete: !!result.isIncomplete,
          suggestions: items.map(function (it) {
            return toMonacoCompletion(it, defaultRange);
          }),
        };
      }).catch(function () { return { suggestions: [] }; });
    }

    function resolveCompletion(item) {
      if (!ready || !item._lsp) return item;
      return request('completionItem/resolve', item._lsp).then(function (full) {
        if (full && full.documentation) item.documentation = asMarkdown(full.documentation);
        if (full && full.detail) item.detail = full.detail;
        return item;
      }).catch(function () { return item; });
    }

    // ---- hover -----------------------------------------------------------
    function provideHover(model, position) {
      if (!ready || !opened) return null;
      didChange(model.getValue());
      return request('textDocument/hover', {
        textDocument: { uri: DOC_URI }, position: lspPos(position),
      }).then(function (result) {
        if (!result || !result.contents) return null;
        var md = asMarkdown(result.contents);
        if (!md || !md.value) return null;
        var hover = { contents: [md] };
        if (result.range) hover.range = monacoRange(result.range);
        return hover;
      }).catch(function () { return null; });
    }

    // ---- signature help --------------------------------------------------
    function provideSignatureHelp(model, position) {
      if (!ready || !opened) return null;
      didChange(model.getValue());
      return request('textDocument/signatureHelp', {
        textDocument: { uri: DOC_URI }, position: lspPos(position),
      }).then(function (result) {
        if (!result || !result.signatures || !result.signatures.length) return null;
        return {
          value: {
            signatures: result.signatures.map(function (s) {
              return {
                label: s.label,
                documentation: s.documentation ? asMarkdown(s.documentation) : undefined,
                parameters: (s.parameters || []).map(function (p) {
                  return {
                    label: p.label,
                    documentation: p.documentation ? asMarkdown(p.documentation) : undefined,
                  };
                }),
              };
            }),
            activeSignature: result.activeSignature || 0,
            activeParameter: result.activeParameter || 0,
          },
          dispose: function () {},
        };
      }).catch(function () { return null; });
    }

    // ---- boot ------------------------------------------------------------
    function available() {
      if (typeof Worker === 'undefined') return false;
      // clangd is a wasm pthread build -> needs cross-origin isolation;
      // pyright is pure JS and runs anywhere.
      if (SERVER === 'clangd') return !!window.crossOriginIsolated;
      return true;
    }

    function finishBoot(onReady, onError) {
      request('initialize', {
        processId: null,
        rootUri: ROOT_URI,
        rootPath: ROOT_URI.replace(/^file:\/\//, ''),
        workspaceFolders: [{ uri: ROOT_URI, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            completion: {
              contextSupport: true,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                resolveSupport: { properties: ['documentation', 'detail'] },
              },
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true },
              },
            },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { configuration: false, workspaceFolders: true },
        },
        initializationOptions: opts.initializationOptions || {},
      }).then(function () {
        notify('initialized', {});
        ready = true;
        if (bootTimer) clearTimeout(bootTimer);
        // hover + signature help are LSP-only; completion is registered by
        // problem_ide.js as a hybrid (LSP when ready, static otherwise).
        monaco.languages.registerHoverProvider(LANG, { provideHover: provideHover });
        monaco.languages.registerSignatureHelpProvider(LANG, {
          signatureHelpTriggerCharacters: ['(', ','],
          signatureHelpRetriggerCharacters: [')'],
          provideSignatureHelp: provideSignatureHelp,
        });
        diag('initialized, ready');
        onReady();
      }).catch(function (e) {
        if (bootTimer) clearTimeout(bootTimer);
        onError('初始化失败: ' + (e && e.message ? e.message : JSON.stringify(e)));
      });
    }

    function start(monacoInstance, startOpts) {
      monaco = monacoInstance;
      startOpts = startOpts || {};
      var onProgress = startOpts.onProgress || function () {};
      var rawError = startOpts.onError || function () {};
      var onError = function (m) { diag('ERROR: ' + m); rawError(m); };
      var onReady = startOpts.onReady || function () {};

      diag('start: server=' + SERVER + ' COI=' + window.crossOriginIsolated +
           ' worker=' + (typeof Worker));

      if (!available()) {
        onError(SERVER === 'clangd' ? '当前环境不支持跨源隔离' : '当前浏览器不支持 Web Worker');
        return;
      }
      buildEnumTables();

      bootTimer = setTimeout(function () {
        if (!ready) onError('启动超时（网络过慢或内存不足）');
      }, 240000);

      if (SERVER === 'clangd') {
        startClangd(onReady, onError, onProgress);
      } else {
        startPyright(onReady, onError);
      }
    }

    // clangd: a module worker speaking our control protocol + raw LSP
    function startClangd(onReady, onError, onProgress) {
      try {
        worker = new Worker(opts.workerUrl, { type: 'module', name: 'clangd-server' });
      } catch (e) {
        onError('无法创建 worker: ' + (e && e.message ? e.message : e));
        return;
      }
      worker.onmessage = function (e) {
        var d = e.data;
        if (!d) return;
        if (d.type === 'progress') { onProgress(d.value, d.max); return; }
        if (d.type === 'stage') { diag('stage: ' + d.text); return; }
        if (d.type === 'ready') { diag('worker reports ready'); finishBoot(onReady, onError); return; }
        if (d.type === 'error') {
          if (ready) { diag('post-ready error ignored: ' + d.message); return; }
          if (bootTimer) clearTimeout(bootTimer);
          onError(d.message || 'worker 启动失败');
          return;
        }
        if (d.type === 'aborted') {
          if (ready) { diag('aborted after ready (ignored)'); return; }
          if (bootTimer) clearTimeout(bootTimer);
          onError('clangd 进程已崩溃');
          return;
        }
        onMessage(d);
      };
      worker.onerror = function (e) {
        var m = (e && e.message) ? e.message : 'unknown';
        if (ready) { diag('post-ready worker.onerror ignored: ' + m); return; }
        if (bootTimer) clearTimeout(bootTimer);
        onError('worker 出错: ' + m);
      };
    }

    // pyright: a classic worker; main thread services background-worker
    // creation requests, then plain LSP flows over the foreground worker.
    function startPyright(onReady, onError) {
      try {
        worker = new Worker(opts.workerUrl, { name: 'pyright-foreground' });
      } catch (e) {
        onError('无法创建 worker: ' + (e && e.message ? e.message : e));
        return;
      }
      worker.onmessage = function (e) {
        var d = e.data;
        if (!d) return;
        if (d.type === 'browser/newWorker') {
          // pyright's foreground worker asks the host to spawn a background
          // analysis worker and hand it a MessagePort.
          var bg;
          try {
            bg = new Worker(opts.workerUrl, { name: 'pyright-bg-' + bgWorkers.length });
          } catch (err) { diag('bg worker failed: ' + err); return; }
          bgWorkers.push(bg);
          bg.postMessage({
            type: 'browser/boot', mode: 'background',
            initialData: d.initialData, port: d.port,
          }, [d.port]);
          return;
        }
        onMessage(d);
      };
      worker.onerror = function (e) {
        var m = (e && e.message) ? e.message : 'unknown';
        if (ready) { diag('post-ready worker.onerror ignored: ' + m); return; }
        if (bootTimer) clearTimeout(bootTimer);
        onError('worker 出错: ' + m);
      };
      diag('booting pyright foreground worker');
      worker.postMessage({ type: 'browser/boot', mode: 'foreground' });
      // pyright has no separate "ready" signal — the initialize response is it.
      // The request is buffered by the worker until the connection is live.
      finishBoot(onReady, onError);
    }

    return {
      available: available,
      start: start,
      isReady: function () { return ready; },
      setDiagModel: function (m) { diagModel = m; },
      didOpen: didOpen,
      didChange: didChange,
      didClose: didClose,
      provideCompletion: provideCompletion,
      resolveCompletion: resolveCompletion,
    };
  }

  return { create: create };
})();
