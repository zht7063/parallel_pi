// Fixture assertions use canonical roots. Tests of aliases create them explicitly.
// macOS commonly exposes the same temp directory through /var and /private/var.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
process.env.TMPDIR = realpathSync(tmpdir());
