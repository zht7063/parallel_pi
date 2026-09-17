#!/usr/bin/env python3
"""Bundle an already-built Linux checkout; never includes application data or Git metadata."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parent.parent


def git(directory, *args):
    return subprocess.check_output(['git', '-C', str(directory), *args])


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def package(output, development=False):
    subprocess.run(['node', 'scripts/runtime.mjs', '--check'], cwd=ROOT, check=True)
    versions = json.loads((ROOT / 'probes/versions.json').read_text())
    repositories = [ROOT, ROOT / 'vendor/pi', ROOT / 'probes/.cache/mwf-source']
    for directory, expected in zip(repositories[1:], (versions['pi']['commit'], versions['mwf']['commit'])):
        if git(directory, 'rev-parse', 'HEAD').decode().strip() != expected:
            raise ValueError(f'Unexpected native dependency revision: {directory}')
    dirty = any(git(directory, 'status', '--porcelain', '--untracked-files=no').strip() for directory in repositories)
    if dirty and not development:
        raise ValueError('Commit reviewed source changes before packaging, or use --development for a test candidate')
    files = set()
    for directory in repositories:
        for raw in git(directory, 'ls-files', '-z').split(b'\0'):
            if raw:
                path = directory / os.fsdecode(raw)
                if not path.is_dir():
                    files.add(path)
    generated = [ROOT / 'node_modules', ROOT / 'apps/web/dist', ROOT / 'vendor/pi/node_modules', ROOT / 'probes/.cache/mwf-source/packages/mwf/dist', ROOT / 'probes/.cache/mwf-source/packages/mwf/node_modules']
    generated.extend((ROOT / 'vendor/pi/packages').glob('*/dist'))
    generated.extend((ROOT / 'vendor/pi/packages').glob('*/node_modules'))
    for directory in generated:
        if not directory.is_dir():
            raise ValueError(f'Missing built directory: {directory}')
        for parent, directories, names in os.walk(directory, followlinks=False):
            for name in directories + names:
                path = Path(parent) / name
                if path.is_symlink() or path.is_file():
                    files.add(path)
    manifest = {
        'format': 1, 'platform': 'linux',
        'arch': subprocess.check_output(['node', '-p', 'process.arch'], text=True).strip(),
        'applicationCommit': git(ROOT, 'rev-parse', 'HEAD').decode().strip(),
        'development': dirty, 'versions': versions, 'files': {},
    }
    for path in sorted(files):
        relative = str(path.relative_to(ROOT))
        if path.is_symlink():
            link = os.readlink(path)
            if Path(link).is_absolute() or not path.resolve().is_relative_to(ROOT) or not path.exists():
                raise ValueError(f'Nonportable dependency link: {relative}')
            manifest['files'][relative] = {'link': link}
        else:
            manifest['files'][relative] = {'sha256': digest(path)}
    output = output.expanduser().resolve()
    if output.is_relative_to(ROOT):
        raise ValueError('Choose an output directory outside the source checkout')
    output.mkdir(mode=0o700)
    try:
        archive = output / 'parallel-pi-linux.tar.gz'
        with tarfile.open(archive, 'w:gz', dereference=False) as tar:
            for path in sorted(files):
                tar.add(path, arcname='parallel-pi/' + str(path.relative_to(ROOT)), recursive=False)
            body = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
            info = tarfile.TarInfo('parallel-pi/runtime-manifest.json')
            info.size = len(body)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(body))
        (output / 'SHA256SUMS').write_text(digest(archive) + '  ' + archive.name + '\n')
        print(json.dumps({'archive': str(archive), 'files': len(files), 'development': dirty}))
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--development', action='store_true', help='Explicitly permit a dirty candidate, marked in its manifest')
    args = parser.parse_args()
    try:
        package(args.output, args.development)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Packaging refused: {error}', file=sys.stderr)
        sys.exit(1)
