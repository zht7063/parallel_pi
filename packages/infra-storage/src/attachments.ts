import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AttachmentStore, ImageInput } from '@parallel-pi/application';

export function createAttachmentStore(directory: string): AttachmentStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    put(image) {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      )
        throw new Error('Select a PNG, JPEG or WebP image');
      const bytes = Buffer.from(image.data, 'base64');
      if (
        bytes.length === 0 ||
        bytes.length > 10 * 1024 * 1024 ||
        bytes.toString('base64') !== image.data
      )
        throw new Error('Image must be valid base64 and at most 10 MiB');
      const valid =
        image.mimeType === 'image/png'
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : image.mimeType === 'image/jpeg'
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP';
      if (!valid) throw new Error('Image contents do not match its file type');
      const id = randomUUID();
      const temp = join(directory, `${id}.tmp`);
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(image));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, join(directory, `${id}.json`));
      const directoryFd = openSync(directory, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
      return { id, mimeType: image.mimeType, size: bytes.length };
    },
    get(id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid attachment ID');
      return JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8')) as ImageInput;
    },
  };
}
