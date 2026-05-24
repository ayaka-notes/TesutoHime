"""Custom-run service.

A small HTTP service that runs inside the judger container. It compiles and
runs user-supplied code inside the *same* nsjail sandbox used for judging, so
the "self-test / custom run" feature on the web IDE is as isolated as a real
submission. It is intentionally separate from the judge task queue: custom
runs are interactive and must not compete with or block real judging.
"""
__import__('judger2.logging_')

from asyncio import Semaphore, wait_for
from logging import getLogger
from os import chmod
from pathlib import PosixPath

from aiohttp.web import Application, Request, json_response, run_app

# importing judger2.sandbox also configures commons.util.TempDir
from commons.task_typing import ResourceUsage
from commons.util import TempDir
from judger2.config import cxxflags
from judger2.sandbox import run_with_limits

logger = getLogger(__name__)

HOST = '0.0.0.0'
PORT = 5200

MAX_CODE_BYTES = 256 * 1024
MAX_INPUT_BYTES = 1024 * 1024
MAX_OUTPUT_CHARS = 64 * 1024
REQUEST_TIMEOUT_SECS = 60
# Custom runs are interactive; cap concurrency so they cannot exhaust the host.
CONCURRENCY = 3

compile_limits = ResourceUsage(
    time_msecs=20000, memory_bytes=1024 ** 3, file_count=-1, file_size_bytes=-1,
)
run_limits = ResourceUsage(
    time_msecs=5000, memory_bytes=256 * 1024 * 1024, file_count=-1, file_size_bytes=-1,
)

semaphore = Semaphore(CONCURRENCY)


def _truncate(text: str) -> str:
    if len(text) > MAX_OUTPUT_CHARS:
        return text[:MAX_OUTPUT_CHARS] + '\n…（输出过长，已截断）'
    return text


def _result_payload(res, output: str) -> dict:
    usage = res.resource_usage
    return {
        'status': 'ok' if res.error is None else res.error,
        'output': _truncate(output),
        'stderr': _truncate(res.message or ''),
        'time_msecs': usage.time_msecs if usage is not None else None,
        'memory_bytes': usage.memory_bytes if usage is not None else None,
    }


async def _sandbox_run(profile, argv, exe_path: PosixPath, stdin_text: str) -> dict:
    """Run a prepared program in the sandbox, feeding stdin_text, capturing stdout."""
    with TempDir() as run_cwd, TempDir() as io_dir:
        infile_path = io_dir / 'stdin'
        infile_path.write_text(stdin_text)
        infile_path.chmod(0o644)
        outfile_path = io_dir / 'stdout'
        outfile_path.touch()
        outfile_path.chmod(0o660)
        with open(infile_path, 'r') as inf, open(outfile_path, 'w') as ouf:
            res = await run_with_limits(
                profile, argv, run_cwd, run_limits,
                infile=inf, outfile=ouf,
                supplementary_paths=[str(exe_path)],
                disable_stderr=False,
            )
        output = outfile_path.read_text(errors='replace')
    return _result_payload(res, output)


def _write_file(cwd: PosixPath, name: str, content: str) -> PosixPath:
    """Write a file under cwd, rejecting absolute paths and path traversal."""
    if not name or name.startswith('/') or '..' in name.split('/'):
        raise ValueError(f'非法文件名：{name}')
    path = cwd / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o644)
    return path


async def _run_cpp(code, stdin_text, extra_files, code_filename, compile_target) -> dict:
    # For a classic problem the user's code IS the program. For a core-code
    # (hpp) problem the user's code is a fragment written to src.hpp and the
    # injected driver main.cpp is what gets compiled.
    code_filename = code_filename or 'main.cpp'
    compile_target = compile_target or code_filename
    with TempDir() as cwd:
        _write_file(cwd, code_filename, code)
        for name, content in extra_files.items():
            _write_file(cwd, name, str(content))
        target = cwd / compile_target
        if not target.exists():
            return {
                'status': 'compile_error',
                'compile_message': f'找不到编译目标文件：{compile_target}',
            }
        exe = cwd / 'code'
        compile_res = await run_with_limits(
            'std',
            ['/bin/g++'] + cxxflags + [str(target), '-o', str(exe)],
            cwd, compile_limits,
        )
        if compile_res.error is not None or not exe.exists():
            return {
                'status': 'compile_error',
                'compile_message': compile_res.message or '编译失败，未产生可执行文件。',
            }
        chmod(exe, 0o550)
        return await _sandbox_run('libc', [str(exe)], exe, stdin_text)


async def _run_python(code, stdin_text, extra_files, code_filename, compile_target) -> dict:
    # core-code mode is C++-only; a Python custom run always executes the file
    # the user wrote, as a standalone program.
    with TempDir() as cwd:
        src = _write_file(cwd, code_filename or 'main.py', code)
        return await _sandbox_run('python', ['/bin/python3', str(src)], src, stdin_text)


RUNNERS = {'cpp': _run_cpp, 'python': _run_python}


async def handle_run(request: Request):
    try:
        data = await request.json()
    except Exception:
        return json_response({'error': '请求体不是合法的 JSON。'}, status=400)

    language = data.get('language')
    code = data.get('code') or ''
    stdin_text = data.get('input') or ''
    extra_files = data.get('extra_files')
    if not isinstance(extra_files, dict):
        extra_files = {}
    code_filename = data.get('code_filename')
    compile_target = data.get('compile_target')

    if language not in RUNNERS:
        return json_response({'error': f'自测运行暂不支持该语言：{language}'}, status=400)
    if not code.strip():
        return json_response({'error': '代码为空。'}, status=400)
    if len(code.encode('utf-8', 'ignore')) > MAX_CODE_BYTES:
        return json_response({'error': '代码超过长度上限。'}, status=400)
    if len(stdin_text.encode('utf-8', 'ignore')) > MAX_INPUT_BYTES:
        return json_response({'error': '自测输入超过大小上限。'}, status=400)
    extra_total = sum(len(str(v).encode('utf-8', 'ignore')) for v in extra_files.values())
    if extra_total > 4 * MAX_CODE_BYTES:
        return json_response({'error': '附加文件过大。'}, status=400)

    async with semaphore:
        try:
            result = await wait_for(
                RUNNERS[language](code, stdin_text, extra_files,
                                  code_filename, compile_target),
                REQUEST_TIMEOUT_SECS)
        except Exception as e:
            logger.error('custom run failed: %(error)s', {'error': e}, 'customrun:error')
            return json_response({'error': f'运行服务内部错误：{e}'}, status=500)
    return json_response(result)


async def handle_health(_request: Request):
    return json_response({'status': 'ok'})


def main():
    app = Application(client_max_size=2 * 1024 * 1024)
    app.router.add_post('/run', handle_run)
    app.router.add_get('/health', handle_health)
    logger.info('custom-run service listening on %(host)s:%(port)s',
                {'host': HOST, 'port': PORT}, 'customrun:start')
    run_app(app, host=HOST, port=PORT, print=None)


if __name__ == '__main__':
    main()
