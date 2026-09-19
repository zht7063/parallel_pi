#!/usr/bin/env python3
"""macOS-only capability probe; does not enable the production Darwin adapter.

Creates one temporary user launchd job and a bounded detached double-fork child.
Uses only stdlib. No sudo, installation, project changes or persistent service.
See docs/darwin-supervision.md for the kernel-source basis and limitations.
"""
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
import uuid


def bindings():
    if sys.platform != 'darwin':
        raise RuntimeError('This capability probe requires an actual macOS host')
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    lib.coalition_info_resource_usage.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]
    lib.coalition_info_resource_usage.restype = ctypes.c_int
    lib.__proc_info.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.__proc_info.restype = ctypes.c_int
    return lib


def information(lib, pid):
    # PROC_PIDUNIQIDENTIFIERINFO and PROC_PIDCOALITIONINFO, from Apple headers.
    identity = ctypes.create_string_buffer(56)
    coalitions = (ctypes.c_uint64 * 5)()
    for flavor, buffer in [(17, identity), (20, coalitions)]:
        size = ctypes.sizeof(buffer)
        if lib.proc_pidinfo(pid, flavor, 0, buffer, size) != size:
            code = ctypes.get_errno()
            raise OSError(code, f'proc_pidinfo({pid}, {flavor}): {os.strerror(code)}')
    return {
        'pid': pid,
        'pidversion': int.from_bytes(identity.raw[32:36], sys.byteorder),
        'coalition': coalitions[0],
    }


def active(lib, coalition):
    # Read only the stable tasks_started/tasks_exited prefix of resource usage.
    counters = (ctypes.c_uint64 * 2)()
    if lib.coalition_info_resource_usage(coalition, counters, ctypes.sizeof(counters)) != 0:
        code = ctypes.get_errno()
        raise OSError(code, f'coalition_info_resource_usage: {os.strerror(code)}')
    return counters[0] - counters[1]


def send(lib, info, sig, wrong_generation=False):
    token = (ctypes.c_uint32 * 8)()
    token[5] = info['pid']
    token[7] = info['pidversion'] ^ (0x80000000 if wrong_generation else 0)
    # PROC_INFO_CALL_SIGNAL_AUDITTOKEN validates pidversion in the kernel.
    if lib.__proc_info(0x11, 0, sig, 0, token, ctypes.sizeof(token)) != 0:
        code = ctypes.get_errno()
        raise OSError(code, f'audit-token signal: {os.strerror(code)}')


def wait_until(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.025)
    raise TimeoutError('Capability probe timed out')


def publish(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def worker(directory):
    lib = bindings()
    publish(directory / 'ready.json', information(lib, os.getpid()))
    wait_until(lambda: (directory / 'start').exists() or (directory / 'release').exists())
    if (directory / 'release').exists():
        return
    intermediate = os.fork()
    if intermediate == 0:
        os.setsid()
        if os.fork() != 0:
            os._exit(0)
        try:
            publish(directory / 'detached.json', information(lib, os.getpid()))
            wait_until(lambda: (directory / 'release').exists(), 30)
        finally:
            os._exit(0)
    os.waitpid(intermediate, 0)
    wait_until(lambda: (directory / 'release').exists(), 40)


def probe():
    lib = bindings()
    own = information(lib, os.getpid())
    label = 'org.parallel-pi.probe.' + uuid.uuid4().hex
    domain = f'user/{os.getuid()}'
    cache = Path(__file__).resolve().parent / '.cache' / 'darwin-supervision'
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='run-', dir=cache) as temporary:
        directory = Path(temporary)
        for name in ('TMPDIR', 'TMP', 'TEMP'):
            os.environ[name] = temporary
        spec = directory / 'job.plist'
        spec.write_bytes(plistlib.dumps({
            'Label': label,
            'ProgramArguments': [sys.executable, str(Path(__file__).resolve()), '--worker', temporary],
            'EnvironmentVariables': {name: temporary for name in ('TMPDIR', 'TMP', 'TEMP')},
            'RunAtLoad': True,
            'KeepAlive': False,
            'ProcessType': 'Background',
            'StandardOutPath': str(directory / 'stdout'),
            'StandardErrorPath': str(directory / 'stderr'),
        }))
        try:
            subprocess.run(['launchctl', 'bootstrap', domain, str(spec)], check=True, timeout=10)
            wait_until(lambda: (directory / 'ready.json').exists())
            supervisor = json.loads((directory / 'ready.json').read_text())
            coalition = supervisor['coalition']
            if not coalition or coalition == own['coalition'] or active(lib, coalition) != 1:
                raise RuntimeError('launchd did not provide an exclusive resource coalition')
            send(lib, supervisor, 0)
            try:
                send(lib, supervisor, 0, wrong_generation=True)
            except OSError as error:
                if error.errno != errno.ESRCH:
                    raise
            else:
                raise RuntimeError('Kernel did not reject the wrong process generation')
            (directory / 'start').touch()
            wait_until(lambda: (directory / 'detached.json').exists())
            detached = json.loads((directory / 'detached.json').read_text())
            if detached['coalition'] != coalition:
                raise RuntimeError('Double-fork child escaped the resource coalition')
            wait_until(lambda: active(lib, coalition) == 2)
            send(lib, detached, signal.SIGKILL)
            wait_until(lambda: active(lib, coalition) == 1)
            print(json.dumps({
                'platform': platform.platform(),
                'python': platform.python_version(),
                'exclusiveCoalition': True,
                'doubleForkRetainsCoalition': True,
                'kernelGenerationRejection': True,
                'kernelCountAfterCleanup': 1,
                'productionAdapterVerified': False,
            }, indent=2))
        finally:
            (directory / 'release').touch()
            subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            # Let the bounded detached child observe release even after a failed capability check.
            time.sleep(.1)
            error_log = directory / 'stderr'
            if error_log.exists() and error_log.stat().st_size:
                print(error_log.read_text(), file=sys.stderr)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--worker':
            worker(Path(sys.argv[2]))
        elif len(sys.argv) == 1:
            probe()
        else:
            raise ValueError('Usage: python3 probes/darwin-supervision.py')
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Darwin probe failed: {error}', file=sys.stderr)
        sys.exit(1)
