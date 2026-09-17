import { body, command, projectSnapshot, subscribe } from './workspace.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { Application, Harness, EngineEvent, Configuration } from '@parallel-pi/application';
import type { ServiceStatus } from '@parallel-pi/contracts';

export function createHttpServer(
  application: Application,
  webRoot: string,
  workspace?: Harness,
  configuration?: Configuration,
) {
  // Restart rotates the local browser session. No token is placed in a URL or localStorage.
  const token = randomBytes(32).toString('hex');
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.headersSent) response.destroy();
      else
        json(response, 400, {
          error: {
            code: 'REQUEST',
            message: error instanceof Error ? error.message : 'Request failed',
          },
        });
    });
  });
  function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const address = server.address();
    if (!address || typeof address === 'string') return response.end();
    const host = `127.0.0.1:${address.port}`;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      request.headers.host !== host ||
      (request.headers.origin && request.headers.origin !== `http://${host}`) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      return json(response, 403, {
        error: { code: 'ORIGIN', message: 'Open the local application address directly' },
      });
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname === '/api/session' && request.method === 'GET') {
      response.setHeader('Set-Cookie', `parallel_pi=${token}; HttpOnly; SameSite=Strict; Path=/`);
      return json(response, 200, { authenticated: true });
    }
    if (url.pathname.startsWith('/api/')) {
      const cookie =
        request.headers.cookie
          ?.split(';')
          .map((value) => value.trim())
          .find((value) => value.startsWith('parallel_pi='))
          ?.slice(12) ?? '';
      if (
        !/^[a-f0-9]{64}$/.test(cookie) ||
        !timingSafeEqual(Buffer.from(cookie), Buffer.from(token))
      ) {
        return json(response, 401, {
          error: { code: 'SESSION', message: 'Reconnect to the local application' },
        });
      }
      if (configuration && url.pathname === '/api/models' && request.method === 'GET')
        return json(response, 200, await configuration.models());
      if (configuration && url.pathname === '/api/configuration') {
        if (request.method === 'GET') return json(response, 200, configuration.read());
        if (request.method === 'POST')
          return json(response, 200, configuration.update(await body(request)));
      }
      if (workspace) {
        if (url.pathname === '/api/attachment' && request.method === 'GET') {
          const image = workspace.attachment(url.searchParams.get('id') ?? '');
          response.writeHead(200, {
            'Content-Type': image.mimeType,
            'Cache-Control': 'private, max-age=3600',
          });
          response.end(Buffer.from(image.data, 'base64'));
          return;
        }
        if (url.pathname === '/api/activity' && request.method === 'GET') {
          const runId = url.searchParams.get('runId');
          if (!workspace.snapshot().state.runs.some((run) => run.id === runId))
            throw new Error('Run not found');
          const after = Number(url.searchParams.get('after') ?? 0);
          const events = workspace.events(after);
          const activity = events
            .filter((item) => item.type === 'run.output')
            .flatMap((item) => {
              const data = item.data as { runId: string; event: EngineEvent };
              if (data.runId !== runId) return [];
              const event = data.event;
              return [
                {
                  cursor: item.cursor,
                  runId,
                  kind: event.type,
                  text: event.type === 'question' ? event.question.title : event.text,
                  ...(event.type === 'tool' ? { phase: event.phase, name: event.name } : {}),
                },
              ];
            });
          return json(response, 200, {
            cursor: events.at(-1)?.cursor ?? after,
            activity,
            more: events.length === 500,
          });
        }

        if (url.pathname === '/api/history' && request.method === 'GET')
          return json(
            response,
            200,
            workspace.history(
              url.searchParams.get('sessionId') ?? '',
              url.searchParams.get('before') ?? undefined,
              Number(url.searchParams.get('limit') ?? 40),
            ),
          );
        if (url.pathname === '/api/snapshot' && request.method === 'GET')
          return json(response, 200, projectSnapshot(workspace));
        if (url.pathname === '/api/command' && request.method === 'POST')
          return json(response, 200, await command(workspace, await body(request)));
        if (url.pathname === '/api/events' && request.method === 'GET')
          return subscribe(workspace, request, response, url);
      }
      if (url.pathname === '/api/status' && request.method === 'GET') {
        const status: ServiceStatus = {
          service: 'parallel_pi',
          protocolVersion: 1,
          ...application.status(),
        };
        return json(response, 200, status);
      }
      return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown operation' } });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return json(response, 405, { error: { code: 'METHOD', message: 'Method not allowed' } });
    try {
      const root = resolve(webRoot);
      const file = resolve(
        root,
        `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`,
      );
      if (!file.startsWith(root + sep))
        return json(response, 404, { error: { code: 'NOT_FOUND', message: 'File not found' } });
      const data = await readFile(file);
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
      };
      response.writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      json(response, 404, {
        error: { code: 'NOT_FOUND', message: 'Build the web application with npm run build' },
      });
    }
  }
  return server;
}
