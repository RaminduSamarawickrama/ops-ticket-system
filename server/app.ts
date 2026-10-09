import { MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_UPLOAD_BYTES, PRIORITIES, STATUSES } from '../shared/constants.js';
import { fieldErrors, loginSchema, statusUpdateSchema, ticketInputSchema } from '../shared/validation.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSession,
  requireAdmin,
  sessionCookie,
  verifyCredentials,
} from './auth.js';
import type { Deps } from './deps.js';
import { assertSameOrigin, clientIp, errorResponse, HttpError, json, readJson } from './http.js';
import { safeDisplayName, sniffImageType } from './images.js';
import { deliverNotification } from './notifications.js';
import { hit, LIMITS, peek } from './rateLimit.js';
import {
  changeStatus,
  createTicket,
  getSummary,
  getTicketDetail,
  listTickets,
  type TicketListFilters,
  type UploadedImage,
} from './tickets.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Leave room for form fields and multipart overhead inside Vercel's 4.5 MB request limit.
const MAX_REQUEST_BYTES = MAX_TOTAL_UPLOAD_BYTES + 256 * 1024;

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

/** Build the API request handler. Each route checks its own authorization. */
export function createApp(deps: Deps): (req: Request) => Promise<Response> {
  const { db, config } = deps;
  const secureCookies = config.isProduction;

  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    routes.push({ method, pattern, keys, handler });
  };

  // --- Public ---------------------------------------------------------------------------------

  route('GET', '/health', async () => json({ ok: true }));

  route('POST', '/tickets', async (req) => {
    const length = Number(req.headers.get('content-length') ?? '0');
    if (length > MAX_REQUEST_BYTES) {
      throw new HttpError(413, 'The upload is too large. Remove some screenshots or use smaller images.');
    }

    const ip = clientIp(req);
    if ((await hit(db, 'submit', ip, 3600)) > LIMITS.submitPerIpPerHour) {
      throw new HttpError(429, 'Too many tickets have been submitted from your network. Please wait and try again later.');
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, 'The form could not be read. Please try again.');
    }

    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === 'string' ? v : undefined;
    };
    const parsed = ticketInputSchema.safeParse({
      subject: str('subject'),
      priority: str('priority'),
      reporterEmail: str('reporterEmail'),
      description: str('description'),
      incidentDate: str('incidentDate'),
      incidentTime: str('incidentTime'),
      affectedSystem: str('affectedSystem'),
    });
    if (!parsed.success) {
      throw new HttpError(422, 'Please correct the highlighted fields.', fieldErrors(parsed.error));
    }

    const submissionId = str('submissionId') ?? null;
    if (submissionId !== null && !UUID_RE.test(submissionId)) {
      throw new HttpError(400, 'Invalid submission id.');
    }

    // Validate screenshots on the server: count, size, and real file type from the file's bytes.
    const rawFiles = form.getAll('screenshots').filter((v): v is File => typeof v !== 'string' && v.size > 0);
    if (rawFiles.length > MAX_FILES) {
      throw new HttpError(422, `You can attach up to ${MAX_FILES} screenshots.`, { screenshots: `Up to ${MAX_FILES} screenshots.` });
    }
    let total = 0;
    const files: UploadedImage[] = [];
    for (const f of rawFiles) {
      if (f.size > MAX_FILE_BYTES) {
        throw new HttpError(422, `"${safeDisplayName(f.name)}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`, {
          screenshots: 'One of the screenshots is too large.',
        });
      }
      total += f.size;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const type = sniffImageType(bytes);
      if (!type) {
        throw new HttpError(422, `"${safeDisplayName(f.name)}" is not a PNG, JPG or WebP image.`, {
          screenshots: 'Only PNG, JPG and WebP images are accepted.',
        });
      }
      files.push({ bytes, contentType: type, originalName: safeDisplayName(f.name) });
    }
    if (total > MAX_TOTAL_UPLOAD_BYTES) {
      throw new HttpError(413, 'The screenshots are too large in total. Remove some or use smaller images.');
    }

    const result = await createTicket(deps, parsed.data, files, submissionId);
    // Reporters only get their own reference back; there is no public way to read tickets.
    return json({ reference: result.reference }, { status: result.duplicate ? 200 : 201 });
  });

  // --- Authentication ---------------------------------------------------------------------------

  route('POST', '/auth/login', async (req) => {
    assertSameOrigin(req);
    const parsed = loginSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(422, 'Enter your username and password.', fieldErrors(parsed.error));
    const { username, password } = parsed.data;
    const userKey = username.toLowerCase();

    const ip = clientIp(req);
    const ipCount = await hit(db, 'login-ip', ip, 900);
    const userFailures = await peek(db, 'login-fail', userKey, 900);
    if (ipCount > LIMITS.loginPerIpPer15Min || userFailures >= LIMITS.loginFailuresPerUserPer15Min) {
      throw new HttpError(429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
    }

    const admin = await verifyCredentials(db, username, password);
    if (!admin) {
      await hit(db, 'login-fail', userKey, 900);
      throw new HttpError(401, 'Incorrect username or password.');
    }
    const session = await createSession(db, admin.id, config.sessionTtlHours);
    return json(
      { username: admin.username },
      { headers: { 'Set-Cookie': sessionCookie(session.token, session.expiresAt, secureCookies) } },
    );
  });

  route('POST', '/auth/logout', async (req) => {
    assertSameOrigin(req);
    await destroySession(db, req);
    return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(secureCookies) } });
  });

  route('GET', '/auth/me', async (req) => {
    const session = await getSession(db, req);
    if (!session) throw new HttpError(401, 'Not signed in.');
    return json({ username: session.username });
  });

  // --- Admin (every handler calls requireAdmin) ---------------------------------------------------

  route('GET', '/admin/summary', async (req) => {
    await requireAdmin(db, req);
    return json({ ...(await getSummary(db)), configWarnings: config.warnings });
  });

  route('GET', '/admin/tickets', async (req) => {
    await requireAdmin(db, req);
    const sp = new URL(req.url).searchParams;
    const priority = sp.get('priority') ?? undefined;
    const status = sp.get('status') ?? undefined;
    const sort = sp.get('sort') ?? undefined;
    const filters: TicketListFilters = {
      q: sp.get('q')?.trim().slice(0, 200) || undefined,
      priority: PRIORITIES.includes(priority as never) ? (priority as TicketListFilters['priority']) : undefined,
      status: STATUSES.includes(status as never) ? (status as TicketListFilters['status']) : undefined,
      sort: ['default', 'newest', 'oldest', 'priority'].includes(sort ?? '') ? (sort as TicketListFilters['sort']) : 'default',
      page: Number(sp.get('page')) || 1,
      pageSize: 20,
    };
    return json(await listTickets(db, filters));
  });

  route('GET', '/admin/tickets/:id', async (req, { id }) => {
    await requireAdmin(db, req);
    if (!UUID_RE.test(id)) throw new HttpError(404, 'Ticket not found.');
    const ticket = await getTicketDetail(db, id);
    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    return json(ticket);
  });

  route('PATCH', '/admin/tickets/:id/status', async (req, { id }) => {
    assertSameOrigin(req);
    const admin = await requireAdmin(db, req);
    if (!UUID_RE.test(id)) throw new HttpError(404, 'Ticket not found.');
    const parsed = statusUpdateSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(422, 'Choose a valid status.');
    return json(await changeStatus(deps, id, parsed.data.status, admin));
  });

  route('POST', '/admin/notifications/:id/retry', async (req, { id }) => {
    assertSameOrigin(req);
    const admin = await requireAdmin(db, req);
    if (!UUID_RE.test(id)) throw new HttpError(404, 'Notification not found.');
    const outcome = await deliverNotification(deps, id, 'retry', admin);
    if (!outcome) throw new HttpError(409, 'This email has already been sent or is being sent right now.');
    return json(outcome);
  });

  route('GET', '/admin/attachments/:id', async (req, { id }) => {
    // Auth is checked right here, next to the file read, not in middleware.
    await requireAdmin(db, req);
    if (!UUID_RE.test(id)) throw new HttpError(404, 'Attachment not found.');
    const a = await db.query<{ storage_key: string; content_type: string }>(
      'SELECT storage_key, content_type FROM attachments WHERE id = $1',
      [id],
    );
    if (!a.rows[0]) throw new HttpError(404, 'Attachment not found.');
    const file = await deps.storage.get(a.rows[0].storage_key);
    if (!file) throw new HttpError(404, 'The screenshot file could not be found in storage.');
    return new Response(file.body as BodyInit, {
      headers: {
        'Content-Type': a.rows[0].content_type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      },
    });
  });

  return async function handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      // On Vercel, /api/* is rewritten to /api/index?__path=*; locally the path is used directly.
      const rewritten = url.searchParams.get('__path');
      const path = '/' + (rewritten ?? url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+/, '');
      let pathMatched = false;
      for (const r of routes) {
        const m = r.pattern.exec(path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        const params: Record<string, string> = {};
        try {
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        } catch {
          throw new HttpError(404, 'Not found.');
        }
        return await r.handler(req, params);
      }
      throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed.' : 'Not found.');
    } catch (err) {
      return errorResponse(err);
    }
  };
}
