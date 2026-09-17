"""Linux subreaper. Owner metadata is durable before launch; cleanup proof precedes unlock.

A per-operation flock closes the spawn/record race: recovery first writes a cancel
marker, then takes the same lock. A delayed launcher observes the marker and never
spawns. A dead supervisor without cleanup proof remains unresolved until reboot.
"""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def identity(pid):
    try:
        # comm may contain spaces and parentheses; starttime is field 22.
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return fields[19]
    except FileNotFoundError:
        return None


def persist(directory, name, value):
    temporary = directory / (name + f'.{os.getpid()}.tmp')
    with open(temporary, 'x', encoding='utf8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, directory / name)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def result(settled, code, reason):
    return {'settled': settled, 'exitCode': code, 'reason': reason}


def descendants(pid):
    found = []
    try:
        tasks = list(Path(f'/proc/{pid}/task').iterdir())
    except FileNotFoundError:
        return found
    direct = set()
    for task in tasks:
        try:
            direct.update(int(item) for item in (task / 'children').read_text().split())
        except FileNotFoundError:
            pass
    for child in direct:
        stamp = identity(child)
        if stamp is not None:
            found.append((child, stamp))
            found.extend(descendants(child))
    return found


def send_verified(pid, stamp, sig):
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        if identity(pid) == stamp:
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass
    finally:
        os.close(fd)


def run(directory, cwd, command):
    with open(directory / 'guard.lock', 'a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if (directory / 'cancel').exists():
            if not (directory / 'owner.json').exists():
                persist(directory, 'result.json', result(True, None, 'cancelled-before-launch'))
            return
        if (directory / 'owner.json').exists():
            raise RuntimeError('Operation IDs cannot be reused')
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise OSError(ctypes.get_errno(), 'Cannot establish child subreaper')
        persist(directory, 'owner.json', {'pid': os.getpid(), 'start': identity(os.getpid()), 'boot': boot_id()})
        stopping = [None]
        def stop(_sig=None, _frame=None):
            if stopping[0] is None:
                stopping[0] = time.monotonic()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            child = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=sys.stdout, stderr=sys.stderr, start_new_session=True)
        except Exception as error:
            persist(directory, 'result.json', result(True, None, 'launch-failed: ' + str(error)))
            return
        selector = selectors.DefaultSelector()
        os.set_blocking(sys.stdin.fileno(), False)
        os.set_blocking(child.stdin.fileno(), False)
        selector.register(sys.stdin, selectors.EVENT_READ)
        pending = bytearray()
        writer_registered = False
        root_code = None
        try:
            while True:
                # Reap all adopted tools, including setsid/double-fork descendants.
                no_children = False
                while True:
                    try:
                        pid, status = os.waitpid(-1, os.WNOHANG)
                    except ChildProcessError:
                        no_children = True
                        break
                    if pid == 0:
                        break
                    if pid == child.pid:
                        root_code = os.waitstatus_to_exitcode(status)
                        child.returncode = root_code
                        stop()
                if no_children:
                    persist(directory, 'result.json', result(True, root_code, 'kernel-echild'))
                    return
                if (directory / 'cancel').exists():
                    stop()
                if stopping[0] is not None:
                    # RPC abort is the graceful path. Containment cleanup kills parents
                    # before children: terminating a waited-on child first can wake a shell
                    # and run its next command before the shell receives its own signal.
                    for pid, stamp in descendants(os.getpid()):
                        send_verified(pid, stamp, signal.SIGKILL)
                for key, _mask in selector.select(.025):
                    if key.fileobj is sys.stdin:
                        data = os.read(sys.stdin.fileno(), 65536)
                        if not data:
                            selector.unregister(sys.stdin)
                            stop()
                        elif stopping[0] is None:
                            pending.extend(data)
                            if len(pending) > 24 * 1024 * 1024:
                                stop()
                            elif not writer_registered:
                                selector.register(child.stdin, selectors.EVENT_WRITE)
                                writer_registered = True
                    else:
                        try:
                            written = os.write(child.stdin.fileno(), pending)
                            del pending[:written]
                        except BrokenPipeError:
                            pending.clear()
                            stop()
                        if not pending:
                            selector.unregister(child.stdin)
                            writer_registered = False
        finally:
            selector.close()
            child.stdin.close()


def recover(directory):
    # Tombstone before locking: even a launcher delayed before exec cannot write later.
    (directory / 'cancel').touch(exist_ok=True)
    deadline = time.monotonic() + 8
    while True:
        with open(directory / 'guard.lock', 'a') as guard:
            try:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                owner = read_json(directory / 'owner.json')
                if owner and owner['boot'] == boot_id():
                    send_verified(owner['pid'], owner['start'], signal.SIGTERM)
            else:
                proof = read_json(directory / 'result.json')
                if proof:
                    return proof
                owner = read_json(directory / 'owner.json')
                if not owner or owner['boot'] != boot_id():
                    proof = result(True, None, 'no-launch-or-new-boot')
                    persist(directory, 'result.json', proof)
                    return proof
                return result(False, None, 'Supervisor exited without proving child cleanup; workspace remains recovering')
        if time.monotonic() >= deadline:
            return result(False, None, 'Timed out waiting for supervised tools to exit; workspace remains recovering')
        time.sleep(.05)


if __name__ == '__main__':
    os.umask(0o077)
    directory = Path(sys.argv[2])
    if sys.argv[1] == 'run':
        run(directory, sys.argv[3], sys.argv[4:])
    elif sys.argv[1] == 'recover':
        print(json.dumps(recover(directory)))
    else:
        raise ValueError('Unknown supervisor operation')
