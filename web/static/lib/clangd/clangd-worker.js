/* ===========================================================================
 * clangd-worker.js — boots clangd (LLVM/Clang) compiled to WebAssembly and
 * bridges its stdio to the main thread as plain LSP JSON-RPC objects.
 *
 * Ported from guyutongxue/clangd-in-browser's main.worker.ts, with the Vite
 * build-magic and the vscode-languageserver dependency removed so it runs as a
 * plain ES-module Web Worker — no bundler. The clangd.wasm it loads embeds a
 * full C++ sysroot (libc++ + WASI libc) at /usr/include.
 *
 * Messages:
 *   worker -> main : {type:'progress', value, max}  wasm download progress
 *                    {type:'stage', text}          boot progress (for debug)
 *                    {type:'ready'}                 clangd started
 *                    {type:'error', message}       boot failed
 *                    {type:'aborted'}              clangd crashed
 *                    <object>                       an LSP JSON-RPC message
 *   main -> worker : <object>                       an LSP JSON-RPC message
 * ======================================================================== */

// Report any error that escapes the boot sequence (parse-time, async, etc.)
self.addEventListener('error', function (e) {
  self.postMessage({ type: 'error', message: 'worker error: ' + (e.message || e) });
});
self.addEventListener('unhandledrejection', function (e) {
  var r = e.reason;
  self.postMessage({
    type: 'error',
    message: 'worker rejection: ' + (r && (r.stack || r.message) ? (r.stack || r.message) : r),
  });
});
function stage(text) {
  try { self.postMessage({ type: 'stage', text: text }); } catch (e) {}
}

const WORKSPACE_PATH = '/home/web_user';
const FILE_PATH = '/home/web_user/main.cpp';

// Compile flags clangd applies to main.cpp. The wasm targets wasm32-wasi and
// carries its standard headers at these -isystem paths; -I/shim adds our
// <bits/stdc++.h> stand-in.
const FLAGS = [
  '-xc++', '-std=gnu++17', '-Wall',
  '--target=wasm32-wasi',
  '-isystem/usr/include/c++/v1',
  '-isystem/usr/include/wasm32-wasi/c++/v1',
  '-isystem/usr/include',
  '-isystem/usr/include/wasm32-wasi',
  '-I/shim',
  // Force-include a prologue so a bare core-code snippet (e.g. a LeetCode-style
  // `class Solution`) resolves `vector` etc. without the user writing includes
  // — mirrors what the hpp judge driver does before #include "src.hpp".
  '-include', '/shim/prologue.h',
];

// A self-contained <bits/stdc++.h>: the WASI/libc++ sysroot has no such GNU
// header, but competitive C++ expects it. Every include is __has_include-
// guarded so the shim is harmless whatever the standard library provides.
const STD_HEADERS = ('algorithm any array atomic bitset charconv chrono cmath ' +
  'complex condition_variable deque exception execution filesystem ' +
  'forward_list fstream functional future initializer_list iomanip ios ' +
  'iosfwd iostream istream iterator limits list locale map memory ' +
  'memory_resource mutex new numeric optional ostream queue random ratio ' +
  'regex scoped_allocator set shared_mutex sstream stack stdexcept ' +
  'streambuf string string_view system_error thread tuple type_traits ' +
  'typeindex typeinfo unordered_map unordered_set utility valarray variant ' +
  'vector cassert cctype cerrno cfenv cfloat cinttypes climits clocale ' +
  'csetjmp csignal cstdarg cstddef cstdint cstdio cstdlib cstring ctime ' +
  'cuchar cwchar cwctype').split(' ');
const STDCXX_SHIM = '#pragma once\n' + STD_HEADERS.map(function (h) {
  return '#if __has_include(<' + h + '>)\n#include <' + h + '>\n#endif';
}).join('\n') + '\n';

/* ---- JsonStream: reassemble clangd's stdout byte stream into whole JSON ----
 * objects by brace-counting. Verbatim from clangd-in-browser/src/json_stream.ts
 */
const QUOT = 34, LBRACE = 123, RBRACE = 125, BACKSLASH = 92;
class JsonStream {
  #inJson = false;
  #rawText = [];
  #unbalancedBraces = 0;
  #inString = false;
  #inEscape = 0;
  #textDecoder = new TextDecoder();
  insert(charCode) {
    if (!this.#inJson && charCode === LBRACE) {
      this.#inJson = true;
      this.#rawText = [];
    }
    if (!this.#inJson) return null;
    this.#rawText.push(charCode);
    if (this.#inString) {
      if (this.#inEscape) {
        if (charCode === 75) this.#inEscape += 4;
        this.#inEscape--;
      } else {
        if (charCode === BACKSLASH) this.#inEscape = 1;
        else if (charCode === QUOT) this.#inString = false;
      }
    } else {
      if (charCode === LBRACE) {
        this.#unbalancedBraces++;
      } else if (charCode === RBRACE) {
        this.#unbalancedBraces--;
        if (this.#unbalancedBraces === 0) {
          this.#inJson = false;
          return this.#textDecoder.decode(new Uint8Array(this.#rawText));
        }
      } else if (charCode === QUOT) {
        this.#inString = true;
      }
    }
    return null;
  }
}

try {
  stage('worker started');

  // ---- locate sibling artifacts (served next to this worker) -------------
  const wasmUrl = new URL('./clangd.wasm', import.meta.url).href;
  const jsUrl = new URL('./clangd.js', import.meta.url).href;

  // ---- pre-fetch the wasm, streaming download progress to the main thread -
  stage('fetching clangd.wasm');
  const wasmResponse = await fetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error('clangd.wasm fetch failed: HTTP ' + wasmResponse.status);
  }
  const wasmSize = Number(wasmResponse.headers.get('Content-Length')) || 0;
  const bodyReader = wasmResponse.body.getReader();
  let received = 0;
  const wasmChunks = [];
  for (;;) {
    const { done, value } = await bodyReader.read();
    if (done) break;
    if (value) {
      wasmChunks.push(value);
      received += value.length;
      self.postMessage({ type: 'progress', value: received, max: wasmSize });
    }
  }
  const wasmBlobUrl = URL.createObjectURL(
    new Blob(wasmChunks, { type: 'application/wasm' }));

  stage('importing clangd.js');
  const clangdModule = await import(jsUrl);
  const Clangd = clangdModule.default;
  if (typeof Clangd !== 'function') {
    throw new Error('clangd.js did not export a module factory');
  }

  // ---- stdio plumbing between clangd and the LSP message channel ---------
  const textEncoder = new TextEncoder();
  let resolveStdinReady = () => {};
  const stdinChunks = [];          // pending pieces of clangd's stdin (strings)
  const currentStdinChunk = [];    // the piece currently being drained (bytes)

  // clangd reads stdin one byte at a time; a trailing null marks "chunk done".
  const stdin = () => {
    if (currentStdinChunk.length === 0) {
      if (stdinChunks.length === 0) return null;
      const next = stdinChunks.shift();
      for (const b of textEncoder.encode(next)) currentStdinChunk.push(b);
      currentStdinChunk.push(null);
    }
    return currentStdinChunk.shift();
  };
  // ASYNCIFY hook: when stdin is empty, block until the main thread sends more.
  const stdinReady = async () => {
    if (stdinChunks.length === 0) {
      return new Promise((r) => { resolveStdinReady = r; });
    }
  };

  const jsonStream = new JsonStream();
  const stdout = (charCode) => {
    const json = jsonStream.insert(charCode);
    if (json !== null) {
      try { self.postMessage(JSON.parse(json)); } catch (e) {}
    }
  };
  const stderr = () => {};         // clangd diagnostics go through LSP

  const onAbort = () => { self.postMessage({ type: 'aborted' }); };

  stage('instantiating wasm');
  const clangd = await Clangd({
    thisProgram: '/usr/bin/clangd',
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? wasmBlobUrl : (prefix + path),
    stdinReady, stdin, stdout, stderr,
    onExit: onAbort,
    onAbort,
  });
  if (!clangd || !clangd.FS || typeof clangd.callMain !== 'function') {
    throw new Error('clangd module missing FS/callMain exports');
  }

  // ---- prepare the workspace --------------------------------------------
  stage('preparing workspace');
  clangd.FS.writeFile(FILE_PATH, '');
  clangd.FS.writeFile(WORKSPACE_PATH + '/.clangd',
    JSON.stringify({
      CompileFlags: { Add: FLAGS },
      // Competitive C++ pulls in whole headers (e.g. <bits/stdc++.h>); silence
      // clangd's include-cleaner "unused/missing header" nags.
      Diagnostics: { UnusedIncludes: 'None', MissingIncludes: 'None' },
    }));
  try { clangd.FS.mkdir('/shim'); } catch (e) {}
  try { clangd.FS.mkdir('/shim/bits'); } catch (e) {}
  try { clangd.FS.writeFile('/shim/bits/stdc++.h', STDCXX_SHIM); } catch (e) {}
  // force-included prologue (see FLAGS): brings the whole standard library,
  // `using namespace std`, AND the LeetCode-style helper types
  // (ListNode, TreeNode, Node) into scope so a bare core-code snippet
  // — like ``ListNode* mergeTwoLists(ListNode* a, ListNode* b)`` —
  // type-checks without the editor showing "Unknown type name 'ListNode'".
  // The student never sees this file; LeetCode itself does the same
  // trick on their server side. Each declaration uses ``inline`` so
  // separate compilation units (one per problem in our setup) don't
  // produce ODR conflicts if anything ever links them together.
  try {
    clangd.FS.writeFile('/shim/prologue.h',
      '#include <bits/stdc++.h>\n' +
      'using namespace std;\n' +
      '\n' +
      '// ---- LeetCode helper types (mirrors LC\'s implicit prelude) ----\n' +
      '#ifndef TESUTOHIME_LC_PRELUDE\n' +
      '#define TESUTOHIME_LC_PRELUDE\n' +
      '\n' +
      'struct ListNode {\n' +
      '    int val;\n' +
      '    ListNode *next;\n' +
      '    ListNode() : val(0), next(nullptr) {}\n' +
      '    ListNode(int x) : val(x), next(nullptr) {}\n' +
      '    ListNode(int x, ListNode *next) : val(x), next(next) {}\n' +
      '};\n' +
      '\n' +
      'struct TreeNode {\n' +
      '    int val;\n' +
      '    TreeNode *left;\n' +
      '    TreeNode *right;\n' +
      '    TreeNode() : val(0), left(nullptr), right(nullptr) {}\n' +
      '    TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}\n' +
      '    TreeNode(int x, TreeNode *left_, TreeNode *right_)\n' +
      '        : val(x), left(left_), right(right_) {}\n' +
      '};\n' +
      '\n' +
      '// LC reuses class name `Node` across multiple problem shapes\n' +
      '// (graph / random-pointer linked list / N-ary tree /\n' +
      '// level-next pointer). We define the graph flavour by default\n' +
      '// since it\'s the most common Hot-100 occurrence (#133 Clone\n' +
      '// Graph). Problems that need a different shape can shadow this\n' +
      '// with their own struct inside the .cpp file.\n' +
      'class Node {\n' +
      'public:\n' +
      '    int val;\n' +
      '    std::vector<Node*> neighbors;\n' +
      '    Node* next;\n' +
      '    Node* random;\n' +
      '    Node* left;\n' +
      '    Node* right;\n' +
      '    std::vector<Node*> children;\n' +
      '    Node() : val(0), next(nullptr), random(nullptr),\n' +
      '             left(nullptr), right(nullptr) {}\n' +
      '    Node(int _val) : val(_val), next(nullptr), random(nullptr),\n' +
      '             left(nullptr), right(nullptr) {}\n' +
      '    Node(int _val, std::vector<Node*> _neighbors)\n' +
      '        : val(_val), neighbors(_neighbors), next(nullptr),\n' +
      '          random(nullptr), left(nullptr), right(nullptr) {}\n' +
      '};\n' +
      '\n' +
      '#endif  // TESUTOHIME_LC_PRELUDE\n');
  } catch (e) {}

  // ---- start clangd's main loop -----------------------------------------
  stage('starting clangd');
  clangd.callMain([]);
  self.postMessage({ type: 'ready' });

  // ---- forward LSP messages from the main thread into clangd's stdin ----
  self.onmessage = (e) => {
    const data = e.data;
    if (data == null || typeof data !== 'object' || data.type) return;
    // non-ASCII would corrupt the byte-length Content-Length; escape it
    const body = JSON.stringify(data).replace(/[\u007F-\uFFFF]/g, (ch) =>
      '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0'));
    stdinChunks.push('Content-Length: ' + body.length + '\r\n', '\r\n', body);
    resolveStdinReady();
  };
} catch (err) {
  self.postMessage({
    type: 'error',
    message: String(err && (err.stack || err.message) ? (err.stack || err.message) : err),
  });
}
