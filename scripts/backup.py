#!/usr/bin/env python3
"""Offline, same-machine backup. Never restores or overwrites a workspace."""
import argparse
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import subprocess
import tarfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def contained(path, roots):
    return any(path == root or root in path.parents for root in roots)


def inventory(roots):
    """Do not follow links: preserve them and require their targets in the backup."""
    result = {}
    for root in roots:
        paths = [root]
        if root.is_dir():
            for parent, directories, files in os.walk(root, followlinks=False):
                paths.extend(Path(parent) / name for name in directories + files)
        for path in paths:
            stat = path.lstat()
            if path.is_symlink():
                target = path.resolve()
                if target.exists() and not contained(target, roots):
                    raise ValueError(f'External symlink target needs --include: {target}')
            elif not path.is_dir() and not path.is_file():
                raise ValueError(f'Unsupported socket/device/FIFO in backup: {path}')
            result[str(path)] = (stat.st_mode, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    return result


def verify(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('format') != 1 or manifest.get('complete') is not True:
        raise ValueError('Incomplete or unsupported backup')
    archive = directory / 'files.tar.gz'
    if digest(archive) != manifest['sha256']:
        raise ValueError('Backup checksum mismatch')
    with tarfile.open(archive, 'r:gz') as tar:
        names = []
        for member in tar:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('Unsafe archive path')
            names.append(member.name)
        if not set(manifest['requiredFiles']).issubset(names):
            raise ValueError('Backup is missing referenced session/attachment files')
        if names != manifest['entries']:
            raise ValueError('Backup entry list mismatch')
    return manifest


def backup(args):
    data = args.data_dir.expanduser().resolve(strict=True)
    if not (data / 'app.sqlite').is_file() or not (data / 'instance.sqlite').is_file():
        raise ValueError('Not an initialized application data directory')
    output = args.output.expanduser().resolve()
    with ExitStack() as stack:
        lock = sqlite3.connect(data / 'instance.sqlite', timeout=0)
        stack.callback(lock.close)
        try:
            lock.execute('BEGIN EXCLUSIVE')
        except sqlite3.OperationalError as error:
            raise ValueError('Stop the backend before backing up') from error
        db = sqlite3.connect((data / 'app.sqlite').as_uri() + '?mode=ro', uri=True)
        stack.callback(db.close)
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Application database integrity check failed')
        schema = db.execute('PRAGMA user_version').fetchone()[0]
        if schema != 1:
            raise ValueError('Unsupported application database schema')
        state = json.loads(db.execute('SELECT payload FROM app_state WHERE id=1').fetchone()[0])
        terminal = {'succeeded', 'failed', 'cancelled', 'interrupted'}
        if any(run['state'] not in terminal for run in state['runs']):
            raise ValueError('Finish/cancel queued runs and recover interrupted work before backup')
        if any(run.get('handoff', {}).get('state') in {'pending', 'failed'} for run in state['runs']):
            raise ValueError('Resolve pending handoff saves before backup')
        if any(op['state'] in {'pending', 'uncertain'} for op in state['operations']):
            raise ValueError('Reconcile pending operations before backup')
        if any(lane['state'] == 'recovering' for lane in state['lanes']):
            raise ValueError('Reconcile recovering branches before backup')
        for key in ('memorySaves', 'memoryChanges', 'gitCommits'):
            unresolved = {'pending', 'uncertain'} if key == 'gitCommits' else {'pending', 'failed'}
            if any(job['state'] in unresolved for job in state.get(key, [])):
                raise ValueError(f'Resolve {key} before backup')
        supervision = data / 'supervision'
        if supervision.exists():
            for operation in supervision.iterdir():
                guard = stack.enter_context(open(operation / 'guard.lock', 'rb'))
                try:
                    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise ValueError('A supervised worker is still alive; recover in the app first') from error
                proof = json.loads((operation / 'result.json').read_text())
                if proof.get('settled') is not True:
                    raise ValueError('Process cleanup is unproven; recover in the app first')
        agent = args.agent_dir.expanduser().resolve()
        requested = [data, *[path.expanduser().resolve(strict=True) for path in args.include]]
        if agent.exists():
            requested.append(agent)
        for project in state['projects']:
            requested.extend(Path(project[key]).resolve(strict=True) for key in ('directory', 'repository'))
        requested.extend(Path(lane['directory']).resolve(strict=True)
                         for lane in state['lanes'] if lane['directory'])
        roots = []
        for path in sorted(set(requested), key=lambda item: len(item.parts)):
            if not contained(path, roots):
                roots.append(path)
        if any(contained(output, [root]) or contained(root, [output]) for root in roots):
            raise ValueError('Backup destination must be separate from every source')
        required = [Path(session['nativeRef']) for session in state['sessions'] if session['state'] == 'ready']
        required.extend(data / 'attachments' / (item['id'] + '.json') for item in state['attachments'])
        required.extend(data / 'handoffs' / (run['id'] + '.json') for run in state['runs']
                        if run.get('handoff', {}).get('state') == 'saved')
        for path in required:
            if not path.is_file() or not contained(path.resolve(), roots):
                raise ValueError(f'Missing or external session/attachment reference: {path}')
        before = inventory(roots)
        # Local copies are intentionally complete, including ignored/untracked files.
        # ponytail: O(all source bytes); incremental retention is outside the MVP.
        output.mkdir(mode=0o700)
        try:
            archive = output / 'files.tar.gz'
            with tarfile.open(archive, 'w:gz', dereference=False) as tar:
                for root in roots:
                    tar.add(root, arcname=str(root).lstrip('/'), recursive=True)
                entries = [member.name for member in tar.getmembers()]
            if inventory(roots) != before:
                raise ValueError('Source changed during backup; stop external writers and retry')
            manifest = {
                'format': 1, 'complete': True,
                'createdAt': datetime.now(timezone.utc).isoformat(),
                'dataDirectory': str(data), 'agentDirectory': str(agent),
                'agentDirectoryExists': agent.exists(),
                'roots': [str(root) for root in roots],
                'databaseSchema': schema,
                'versions': (json.loads((ROOT / 'build-info.json').read_text())['versions']
                             if (ROOT / 'build-info.json').exists()
                             else json.loads((ROOT / 'probes/versions.json').read_text())),
                'applicationCommit': (json.loads((ROOT / 'runtime-manifest.json').read_text())['applicationCommit']
                                      if (ROOT / 'runtime-manifest.json').exists()
                                      else json.loads((ROOT / 'build-info.json').read_text())['applicationCommit']
                                      if (ROOT / 'build-info.json').exists()
                                      else subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()),
                'dependencyLockSha256': (json.loads((ROOT / 'build-info.json').read_text())['dependencyLockSha256']
                                         if (ROOT / 'build-info.json').exists()
                                         else digest(ROOT / 'package-lock.json')),
                'entries': entries, 'requiredFiles': [str(path).lstrip('/') for path in required],
                'sha256': digest(archive),
            }
            with open(output / 'manifest.json', 'x') as stream:
                json.dump(manifest, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
            verify(output)
            for path in (archive, output / 'manifest.json'):
                with open(path, 'rb') as stream:
                    os.fsync(stream.fileno())
            for path in (output, output.parent):
                directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            return manifest
        except BaseException:
            shutil.rmtree(output)
            raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('create', help='Backend and external writers must be stopped')
    create.add_argument('output', type=Path, help='New directory, outside all backup sources')
    default_data = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'parallel_pi'
    create.add_argument('--data-dir', type=Path, default=Path(os.environ.get('PARALLEL_PI_DATA_DIR', default_data)))
    create.add_argument('--agent-dir', type=Path, default=Path(os.environ.get('PARALLEL_PI_AGENT_DIR', os.environ.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent')))))
    create.add_argument('--include', type=Path, action='append', default=[], help='Additional external config/resource directory (repeatable)')
    check = commands.add_parser('verify')
    check.add_argument('directory', type=Path)
    args = parser.parse_args()
    try:
        result = backup(args) if args.command == 'create' else verify(args.directory)
        print(json.dumps({'complete': True, 'roots': result['roots'], 'sha256': result['sha256']}, ensure_ascii=False))
    except (OSError, ValueError, sqlite3.Error, tarfile.TarError) as error:
        print(f'Backup refused: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
