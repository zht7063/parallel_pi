"""Desktop macOS supervision via a private launchd coalition.

The pipe bridge passes credentials in memory, never in the launchd plist. The
worker holds the operation lock until a kernel count proves no tools remain.
If the worker dies without that proof, recovery refuses to unlock until reboot.
"""
import base64
import ctypes
import fcntl
import json
import os
from pathlib import Path
import plistlib
import selectors
import signal
import socket
import subprocess
import sys
import time
import uuid

from supervisor import persist, read_json, result


def bindings():
    if sys.platform != 'darwin':
        raise RuntimeError('Darwin supervision requires macOS')
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    lib.proc_listpids.restype = ctypes.c_int
    lib.coalition_info_resource_usage.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]
    lib.coalition_info_resource_usage.restype = ctypes.c_int
    lib.__proc_info.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.__proc_info.restype = ctypes.c_int
    return lib


def boot_id():
    return subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], text=True).strip()


def identity(lib, pid):
    stamp = ctypes.create_string_buffer(56)
    group = (ctypes.c_uint64 * 5)()
    for flavor, buffer in [(17, stamp), (20, group)]:
        size = ctypes.sizeof(buffer)
        if lib.proc_pidinfo(pid, flavor, 0, buffer, size) != size:
            raise OSError(ctypes.get_errno(), 'Cannot query process identity')
    return {'pid': pid, 'pidversion': int.from_bytes(stamp.raw[32:36], sys.byteorder), 'coalition': group[0]}


def active(lib, coalition):
    counts = (ctypes.c_uint64 * 2)()
    if lib.coalition_info_resource_usage(coalition, counts, ctypes.sizeof(counts)) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot query coalition count')
    if counts[1] > counts[0]:
        raise RuntimeError('Invalid coalition counters')
    return counts[0] - counts[1]


def send(lib, owner, sig):
    token = (ctypes.c_uint32 * 8)()
    token[5], token[7] = owner['pid'], owner['pidversion']
    if lib.__proc_info(0x11, 0, sig, 0, token, ctypes.sizeof(token)) != 0:
        raise OSError(ctypes.get_errno(), 'audit-token signal failed')


def members(lib, coalition):
    # Enumeration only finds candidates. It never proves cleanup. The kernel
    # count below is the sole authority; each signal checks the process generation.
    size = lib.proc_listpids(1, 0, None, 0)
    if size <= 0:
        raise RuntimeError('Cannot enumerate processes')
    pids = (ctypes.c_int * (size // 4 + 1024))()
    used = lib.proc_listpids(1, 0, pids, ctypes.sizeof(pids))
    if used <= 0 or used >= ctypes.sizeof(pids):
        raise RuntimeError('Incomplete process enumeration')
    found = []
    for pid in pids[:used // 4]:
        if pid <= 0 or pid == os.getpid():
            continue
        try:
            owner = identity(lib, pid)
        except OSError:
            continue  # Count cannot reach one while an inaccessible member survives.
        if owner['coalition'] == coalition:
            found.append(owner)
    return found


def stopped(lib, owner):
    # PROC_PIDTBSDINFO.pbi_status == SSTOP. A delivered SIGSTOP alone does
    # not prove that the target has stopped running yet. Recheck generation.
    status = ctypes.create_string_buffer(136)
    if lib.proc_pidinfo(owner['pid'], 3, 0, status, ctypes.sizeof(status)) != ctypes.sizeof(status):
        return False
    try:
        same = identity(lib, owner['pid']) == owner
    except OSError:
        return False
    return same and int.from_bytes(status.raw[4:8], sys.byteorder) == 4


def cleanup(lib, coalition, child):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        child.poll()  # Reap our direct child before checking kernel accounting.
        if active(lib, coalition) == 1:
            return True
        # Freeze candidates before killing: killing a waited-on child must not
        # wake its still-running parent into another command. Repeat until every
        # kernel-counted tool is represented, including forks during enumeration.
        frozen = members(lib, coalition)
        for owner in frozen:
            try:
                send(lib, owner, signal.SIGSTOP)
            except ProcessLookupError:
                pass
        child.poll()
        live = members(lib, coalition)
        frozen_ids = {(p['pid'], p['pidversion']) for p in frozen}
        if (all((p['pid'], p['pidversion']) in frozen_ids and stopped(lib, p) for p in live)
                and active(lib, coalition) == len(live) + 1):
            for owner in live:
                try:
                    send(lib, owner, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        time.sleep(.025)
    return False


def retire(directory, proof):
    intent = read_json(directory / 'launch.json')
    if intent:
        try:
            subprocess.run(['/bin/launchctl', 'bootout', f"{intent['domain']}/{intent['label']}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            # A retained, non-restarting registration is not evidence of live tools.
            # The next recovery retries removal; the kernel proof remains valid.
            pass
    (directory / 'bridge.sock').unlink(missing_ok=True)
    return proof


def recover(directory):
    (directory / 'cancel').touch(exist_ok=True)
    deadline = time.monotonic() + 8
    while True:
        with open(directory / 'guard.lock', 'a') as guard:
            try:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass  # Worker polls cancel; never signal a possibly reused PID.
            else:
                proof = read_json(directory / 'result.json')
                if proof:
                    return retire(directory, proof) if proof['settled'] else proof
                owner = read_json(directory / 'owner.json')
                if not owner or owner['boot'] != boot_id():
                    proof = result(True, None, 'no-launch-or-new-boot')
                    persist(directory, 'result.json', proof)
                    return retire(directory, proof)
                return result(False, None, 'Supervisor exited without proving child cleanup; workspace remains recovering')
        if time.monotonic() >= deadline:
            return result(False, None, 'Timed out waiting for supervised tools to exit; workspace remains recovering')
        time.sleep(.05)


def worker(directory):
    lib = bindings()
    with open(directory / 'guard.lock', 'a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if (directory / 'cancel').exists():
            return
        if (directory / 'owner.json').exists():
            raise RuntimeError('Operation IDs cannot be reused')
        intent = read_json(directory / 'launch.json')
        owner = identity(lib, os.getpid())
        group = owner['coalition']
        if not group or group == intent['bridgeCoalition'] or active(lib, group) != 1:
            raise RuntimeError('launchd did not provide an exclusive resource coalition')
        # SIGCONT is harmless for this running worker. Signal zero is invalid here.
        send(lib, owner, signal.SIGCONT)
        stale = {**owner, 'pidversion': owner['pidversion'] ^ 0x80000000}
        try:
            send(lib, stale, signal.SIGCONT)
        except ProcessLookupError:
            pass
        else:
            raise RuntimeError('Kernel accepted wrong process generation')
        with socket.socket(socket.AF_UNIX) as channel:
            channel.settimeout(10)
            os.chdir(directory)
            channel.connect('bridge.sock')
            header = bytearray()
            while not header.endswith(b'\n'):
                item = channel.recv(1)
                if not item or len(header) > 2 * 1024 * 1024:
                    raise RuntimeError('Invalid launch envelope')
                header.extend(item)
            spec = json.loads(header)
            if (directory / 'cancel').exists():
                return
            owner['boot'] = boot_id()
            persist(directory, 'owner.json', owner)
            stopping = [False]
            def stop(_sig=None, _frame=None):
                stopping[0] = True
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            try:
                child = subprocess.Popen(spec['command'], cwd=spec['cwd'], env=spec['env'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            except Exception as error:
                persist(directory, 'result.json', result(True, None, 'launch-failed: ' + str(error)))
                return
            channel.settimeout(1)
            pending = bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(channel, selectors.EVENT_READ, 'input')
                for stream, name in [(child.stdout, 'stdout'), (child.stderr, 'stderr')]:
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, name)
                os.set_blocking(child.stdin.fileno(), False)
                try:
                    while not stopping[0]:
                        if (directory / 'cancel').exists() or child.poll() is not None:
                            break
                        for key, _ in selector.select(.025):
                            if key.data == 'input':
                                data = channel.recv(65536)
                                if not data:
                                    stopping[0] = True
                                else:
                                    pending.extend(data)
                                    if len(pending) > 24 * 1024 * 1024:
                                        raise RuntimeError('Input buffer limit exceeded')
                            else:
                                data = os.read(key.fd, 65536)
                                if data:
                                    channel.sendall(json.dumps([key.data, base64.b64encode(data).decode()]).encode() + b'\n')
                                else:
                                    selector.unregister(key.fileobj)
                        if pending:
                            try:
                                count = os.write(child.stdin.fileno(), pending)
                                del pending[:count]
                            except BlockingIOError:
                                pass
                finally:
                    code = child.poll()
                    if cleanup(lib, group, child):
                        # All writers are now dead. Drain finite output before closing.
                        for stream, name in [(child.stdout, 'stdout'), (child.stderr, 'stderr')]:
                            while True:
                                data = stream.read(65536)
                                if not data:
                                    break
                                try:
                                    channel.sendall(json.dumps([name, base64.b64encode(data).decode()]).encode() + b'\n')
                                except OSError:
                                    break
                        persist(directory, 'result.json', result(True, code if code is not None else child.returncode, 'kernel-coalition-empty'))
                    child.stdin.close()
                    child.stdout.close()
                    child.stderr.close()


def run(directory, cwd, command):
    lib = bindings()
    address = str(directory / 'bridge.sock')
    # Relative AF_UNIX names avoid sockaddr_un's short path limit on macOS.
    # Both peers resolve this name inside the same private operation directory.
    cwd = str(Path(cwd).resolve())
    os.chdir(directory)
    domain = f'gui/{os.getuid()}'
    label = 'org.parallel-pi.run.' + uuid.uuid4().hex
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind('bridge.sock')
        listener.listen(1)
        listener.settimeout(10)
        with open(directory / 'guard.lock', 'a') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            if (directory / 'cancel').exists():
                return
            if (directory / 'owner.json').exists() or (directory / 'launch.json').exists():
                raise RuntimeError('Operation IDs cannot be reused')
            persist(directory, 'launch.json', {'label': label, 'domain': domain, 'bridgeCoalition': identity(lib, os.getpid())['coalition']})
            spec = directory / 'job.plist'
            spec.write_bytes(plistlib.dumps({
                'Label': label,
                'ProgramArguments': [sys.executable, str(Path(__file__).resolve()), 'worker', str(directory)],
                'RunAtLoad': True,
                'KeepAlive': False,
                'ProcessType': 'Background',
                'StandardErrorPath': str(directory / 'worker.stderr'),
            }))
            subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(spec)], check=True, timeout=10)
        try:
            channel, _ = listener.accept()
            with channel, selectors.DefaultSelector() as selector:
                channel.sendall(json.dumps({'cwd': cwd, 'command': command, 'env': dict(os.environ)}).encode() + b'\n')
                selector.register(channel, selectors.EVENT_READ, 'output')
                selector.register(sys.stdin, selectors.EVENT_READ, 'input')
                buffered = bytearray()
                while True:
                    for key, _ in selector.select(.1):
                        data = os.read(key.fd, 65536)
                        if key.data == 'input':
                            if not data:
                                selector.unregister(sys.stdin)
                                channel.shutdown(socket.SHUT_WR)
                            else:
                                channel.sendall(data)
                        else:
                            if not data:
                                return
                            buffered.extend(data)
                            while b'\n' in buffered:
                                line, _, rest = buffered.partition(b'\n')
                                buffered = bytearray(rest)
                                name, payload = json.loads(line)
                                stream = sys.stdout.buffer if name == 'stdout' else sys.stderr.buffer
                                stream.write(base64.b64decode(payload, validate=True))
                                stream.flush()
        finally:
            recover(directory)
            log = directory / 'worker.stderr'
            if log.exists():
                sys.stderr.write(log.read_text())
            Path(address).unlink(missing_ok=True)


if __name__ == '__main__':
    os.umask(0o077)
    bindings()
    directory = Path(sys.argv[2]).resolve()
    if sys.argv[1] == 'run':
        run(directory, sys.argv[3], sys.argv[4:])
    elif sys.argv[1] == 'worker':
        worker(directory)
    elif sys.argv[1] == 'recover':
        print(json.dumps(recover(directory)))
    else:
        raise ValueError('Unknown supervisor operation')
