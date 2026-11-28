import { AsyncLocalStorage } from 'node:async_hooks';
import { openAsBlob } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, extname, sep } from 'node:path';

export const API_BASE = 'https://api-v2.hearthis.at';
export const XHR_BASE = 'https://xhr.hearthis.at';

const TIMEOUT_MS = 30_000;
const MAX_AUTO_WAIT_S = 20;
const MAX_OUTPUT_CHARS = 60_000;

export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.aif', '.aiff', '.wma', '.opus'];
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The tool call a request belongs to: its abort signal (the client cancelled the call). */
export const requestContext = new AsyncLocalStorage<{ signal?: AbortSignal }>();

const MAX_REDIRECTS = 5;

export type Params = Record<string, string | number | boolean | undefined | null>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export interface Account {
  id: number;
  permalink: string;
  username: string;
  premium: boolean;
  /** What a personal API key may do (read, social, write) - undefined for the key pair, which is the whole account. */
  scopes?: string[];
}

/** A personal API key as hearthis.at issues it (settings, API keys). */
export const API_KEY_PATTERN = /^htp_[A-Za-z0-9_-]{40}$/;
export const API_KEYS_URL = 'https://studio.hearthis.at/channel/#account';

/**
 * How the server signs in: the account's key pair (everything the account can do), or a personal API key - sent as a
 * Bearer token, limited to its scopes (read, social, write, messages) and never open to deleting a conversation.
 */
export type Credentials = { kind: 'pair'; key: string; secret: string } | { kind: 'token'; token: string } | { kind: 'none'; reason: string };

/** Which tools a personal API key reaches: a scope it must hold, or 'pair' for what no key may do. */
export type Access = 'read' | 'social' | 'write' | 'messages' | 'pair';

const NOT_CONFIGURED =
  'No hearthis.at credentials are set. Run "npx hearthis-mcp login" and add HEARTHIS_API_KEY (or HEARTHIS_KEY and HEARTHIS_SECRET) to the MCP client configuration.';

/** The credentials from the environment: a personal API key wins over the key pair. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv): Credentials {
  const key = env.HEARTHIS_KEY?.trim() ?? '';
  const secret = env.HEARTHIS_SECRET?.trim() ?? '';
  // A key pasted into HEARTHIS_KEY is still a personal API key
  const token = env.HEARTHIS_API_KEY?.trim() || (key.startsWith('htp_') ? key : '');
  if (token !== '') {
    return API_KEY_PATTERN.test(token)
      ? { kind: 'token', token }
      : { kind: 'none', reason: `HEARTHIS_API_KEY is no hearthis.at API key (htp_ and 40 characters). Create one at ${API_KEYS_URL}` };
  }
  return key !== '' && secret !== '' ? { kind: 'pair', key, secret } : { kind: 'none', reason: NOT_CONFIGURED };
}

export class HearthisClient {
  private account: { value: Account; at: number } | null = null;

  constructor(
    private readonly credentials: Credentials,
    private readonly userAgent: string,
  ) {}

  get configured(): boolean {
    return this.credentials.kind !== 'none';
  }

  /** 'token' when a personal API key signs in. */
  get mode(): Credentials['kind'] {
    return this.credentials.kind;
  }

  /** Last line of defence: no credential ever leaves in a text, whatever field or message it came in. */
  scrub(text: string): string {
    let out = text;
    for (const value of this.secrets()) {
      if (value.length >= 8) {
        out = out.split(value).join('[redacted]');
      }
    }
    return out;
  }

  async get(path: string, params: Params = {}, base = API_BASE): Promise<unknown> {
    const url = buildUrl(base, path, { ...params, ...this.pair() });
    return this.send(url, { method: 'GET' });
  }

  async post(path: string, params: Params = {}, query: Params = {}, base = API_BASE): Promise<unknown> {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries({ ...params, ...this.pair() })) {
      if (value !== undefined && value !== null) {
        body.set(name, String(value));
      }
    }
    return this.send(buildUrl(base, path, query), { method: 'POST', body });
  }

  async postFiles(path: string, params: Params, files: Record<string, { path: string; kind: 'audio' | 'image' }>): Promise<unknown> {
    const form = new FormData();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        form.set(name, String(value));
      }
    }
    for (const [field, file] of Object.entries(files)) {
      await checkLocalFile(file.path, file.kind);
      form.set(field, await openAsBlob(file.path), basename(file.path));
    }
    // The key pair in the query: above post_max_size PHP drops the whole body, and without it the API would answer premium_required
    return this.send(buildUrl(XHR_BASE, path, this.pair()), { method: 'POST', body: form }, 0);
  }

  /** The account as the API tells it: /login/ for the key pair, /oauth/userinfo/ for a personal API key (no key may ask /login/). */
  profile(): Promise<unknown> {
    return this.get(this.credentials.kind === 'token' ? '/oauth/userinfo/' : '/login/');
  }

  /** The authenticated account, cached for ten minutes - Premium can end at any time. */
  async whoami(force = false): Promise<Account> {
    if (!force && this.account && Date.now() - this.account.at < 600_000) {
      return this.account.value;
    }
    const data = (await this.profile()) as Record<string, unknown>;
    if (!data || data.success === false || !data.id) {
      throw new ApiError(
        this.credentials.kind === 'token'
          ? `hearthis.at did not accept HEARTHIS_API_KEY. Create a new key at ${API_KEYS_URL}`
          : 'hearthis.at did not accept HEARTHIS_KEY / HEARTHIS_SECRET. Run "npx hearthis-mcp login" to get a fresh pair.',
        401,
        'invalid_credentials',
      );
    }
    // /oauth/userinfo/ names the profile address "username" and the display name "name"
    const token = this.credentials.kind === 'token';
    const value: Account = {
      id: Number(data.id),
      permalink: String((token ? data.username : data.permalink) ?? ''),
      username: String((token ? data.name : data.username) ?? ''),
      premium: data.premium === true,
      ...(token ? { scopes: String(data.scope ?? '').split(/\s+/).filter(Boolean) } : {}),
    };
    this.account = { value, at: Date.now() };
    return value;
  }

  async ensurePremium(): Promise<Account> {
    if (this.credentials.kind === 'none') {
      throw new ApiError(this.credentials.reason, 401, 'not_configured');
    }
    const account = await this.whoami();
    if (!account.premium) {
      throw premiumRequired();
    }
    return account;
  }

  /** Refuses a tool the personal API key cannot use, before any request - with what to do about it. */
  ensureAccess(access: Access, account: Account): void {
    if (this.credentials.kind !== 'token' || access === 'read') {
      return;
    }
    if (access === 'pair') {
      throw notForApiKeys();
    }
    if (!account.scopes?.includes(access)) {
      throw missingScope(access);
    }
  }

  private pair(): Params {
    return this.credentials.kind === 'pair' ? { key: this.credentials.key, secret: this.credentials.secret } : {};
  }

  private secrets(): string[] {
    return this.credentials.kind === 'pair' ? [this.credentials.secret, this.credentials.key] : this.credentials.kind === 'token' ? [this.credentials.token] : [];
  }

  private async send(url: URL, init: RequestInit, timeout = TIMEOUT_MS, attempt = 0): Promise<unknown> {
    const signal = anySignal([timeout > 0 ? AbortSignal.timeout(timeout) : undefined, requestContext.getStore()?.signal]);
    const headers: Record<string, string> = { 'User-Agent': this.userAgent, Accept: 'application/json' };
    if (this.credentials.kind === 'token') {
      headers.Authorization = `Bearer ${this.credentials.token}`;
    }
    const request = (target: URL, method: string | undefined, body: RequestInit['body']) => fetch(target, { method, body, headers, signal, redirect: 'manual' });
    // Redirects only within the same host - the credentials travel in the header, the query and the body
    let response = await request(url, init.method, init.body);
    for (let hop = 0; hop < MAX_REDIRECTS && [301, 302, 303, 307, 308].includes(response.status); hop++) {
      const location = response.headers.get('location');
      if (!location) {
        break;
      }
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        throw new ApiError('hearthis.at redirected to another host - not followed.', 502, 'redirect');
      }
      const keep = response.status === 307 || response.status === 308;
      await response.body?.cancel();
      response = await request(next, keep ? init.method : 'GET', keep ? init.body : undefined);
    }
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      data = text.slice(0, 2000);
    }
    const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;

    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after') ?? body.retry_after);
      const wait = Number.isFinite(header) && header >= 0 ? header : 60;
      if (attempt === 0 && wait <= MAX_AUTO_WAIT_S && !(init.body instanceof FormData)) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        return this.send(url, init, timeout, 1);
      }
      throw new ApiError(`Rate limited by hearthis.at - try again in ${wait} seconds.`, 429, 'rate_limited');
    }
    if (response.status === 403 && body.code === 'premium_required') {
      this.account = null;
      throw premiumRequired();
    }
    // The answers to a personal API key (RFC 6750): unknown or revoked, a right it does not hold, a part no key may use
    if (this.credentials.kind === 'token' && (response.status === 401 || response.status === 403) && typeof body.error === 'string') {
      if (body.error === 'invalid_token') {
        this.account = null;
        throw new ApiError(`hearthis.at did not accept HEARTHIS_API_KEY - it is unknown, expired or was revoked. Create a new key at ${API_KEYS_URL}`, 401, 'invalid_credentials');
      }
      if (body.error === 'insufficient_scope') {
        throw missingScope(typeof body.scope === 'string' ? body.scope : '');
      }
      if (body.error === 'not_available') {
        throw notForApiKeys();
      }
    }
    if (response.ok && typeof data === 'string' && /^\s*</.test(data)) {
      throw new ApiError('hearthis.at answered with a web page instead of data - the item probably does not exist.', 404, 'not_found');
    }
    if (!response.ok) {
      const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : '';
      throw new ApiError(
        `hearthis.at answered ${response.status}${message ? ': ' + message : ''}`,
        response.status,
        typeof body.code === 'string' ? body.code : undefined,
      );
    }
    return data;
  }
}

export function premiumRequired(): ApiError {
  return new ApiError(
    'The hearthis.at MCP server is available for Premium members only. Upgrade at https://hearthis.at/premium/',
    403,
    'premium_required',
  );
}

const SCOPE_NAMES: Record<string, string> = { read: 'Read', social: 'Likes, follows and comments', write: 'Upload and edit', messages: 'Messages' };

export function missingScope(scope: string): ApiError {
  const name = SCOPE_NAMES[scope];
  return new ApiError(
    `The hearthis.at API key of this server does not hold the right ${name ? `"${name}" (${scope})` : 'this needs'}. ` +
      `A key cannot be changed: the user creates a new one with that right at ${API_KEYS_URL} and puts it into the MCP client configuration.`,
    403,
    'insufficient_scope',
  );
}

export function notForApiKeys(): ApiError {
  return new ApiError(
    'Not open to a hearthis.at API key: deleting a conversation needs the sign-in with ' +
      'e-mail and password ("npx hearthis-mcp login", HEARTHIS_KEY and HEARTHIS_SECRET).',
    403,
    'not_available',
  );
}

/** One path segment from user input - never a separator or a dot segment. */
export function segment(value: string | number): string {
  const text = String(value).trim();
  if (text === '' || text === '.' || text === '..' || /[/?#\\]/.test(text)) {
    throw new ApiError(`Invalid path segment: ${JSON.stringify(text)}`, 400, 'invalid_input');
  }
  return encodeURIComponent(text);
}

/* api-v2 routes that are no profile - /login/ would answer with the account's key and secret */
const RESERVED_AUTHORS = [
  'app', 'categories', 'feed', 'group', 'groups', 'login', 'logout', 'login-facebook-v2', 'messages', 'search', 'set', 'sets', 'stories',
  'subscribe', 'api', 'verify', 'upload', 'you', 'purchases', 'invoice', 'points',
];

/** First path segment that must be a profile permalink. */
export function authorSegment(value: string): string {
  const text = String(value).trim().toLowerCase();
  if (RESERVED_AUTHORS.includes(text) || text.endsWith('.php')) {
    throw new ApiError(`"${value}" is no profile permalink.`, 400, 'invalid_input');
  }
  return segment(value);
}

const SECRET_FIELDS = new Set(['secret', 'masterkey', 'masterkeystore', 'verify_code', 'access_token']);

/**
 * Drops credential fields at any depth - no answer may hand the account's key pair to the model. "key" alone is the
 * musical key of a track; it goes only next to a credential field.
 */
export function redact(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map(redact);
  }
  if (data && typeof data === 'object') {
    const entries = Object.entries(data);
    const credentials = entries.some(([name]) => SECRET_FIELDS.has(name));
    return Object.fromEntries(
      entries.filter(([name]) => !SECRET_FIELDS.has(name) && !(credentials && name === 'key')).map(([name, value]) => [name, redact(value)]),
    );
  }
  return data;
}

/** One signal that aborts when any of them does (AbortSignal.any needs Node 20.3). */
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const list = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (list.length < 2) {
    return list[0];
  }
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function buildUrl(base: string, path: string, params: Params): URL {
  const url = new URL(path, base);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
  }
  return url;
}

async function checkLocalFile(path: string, kind: 'audio' | 'image'): Promise<void> {
  const allowed = kind === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS;
  if (!allowed.includes(extname(path).toLowerCase())) {
    throw new ApiError(`Only ${allowed.join(', ')} files can be sent as ${kind}.`, 400, 'invalid_file');
  }
  const refused = new ApiError(`The file cannot be sent: ${basename(path)}`, 400, 'invalid_file');
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile()) {
    throw refused;
  }
  const root = process.env.HEARTHIS_UPLOAD_DIR?.trim();
  if (root) {
    const real = await realpath(path).catch(() => '');
    const base = await realpath(root).catch(() => '');
    if (!real || !base || !real.startsWith(base.endsWith(sep) ? base : base + sep)) {
      throw new ApiError(`Only files inside HEARTHIS_UPLOAD_DIR can be sent.`, 400, 'invalid_file');
    }
  }
  if (kind === 'image') {
    if (info.size > IMAGE_MAX_BYTES) {
      throw new ApiError('Cover images may be 10 MB at most.', 400, 'invalid_file');
    }
    const head = Buffer.alloc(8);
    const handle = await open(path, 'r');
    try {
      await handle.read(head, 0, 8, 0);
    } finally {
      await handle.close();
    }
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!jpeg && !png) {
      throw refused;
    }
  }
}

const TRACK_FIELDS = [
  'id', 'title', 'permalink', 'permalink_url', 'genre', 'genre_slush', 'duration', 'created_at', 'release_date', 'private',
  'downloadable', 'bpm', 'key', 'tags', 'counts', 'liked', 'reshared', 'listen_later', 'is_live', 'artwork_url',
];

function isTrack(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && 'permalink_url' in value && 'duration' in value && 'user' in value;
}

function slimTrack(item: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  for (const field of TRACK_FIELDS) {
    if (item[field] !== undefined && item[field] !== '' && item[field] !== null) {
      slim[field] = item[field];
    }
  }
  const user = item.user as Record<string, unknown> | undefined;
  if (user) {
    slim.user = { id: user.id, permalink: user.permalink, username: user.username };
  }
  if (typeof item.description === 'string' && item.description !== '') {
    slim.description = item.description.length > 300 ? item.description.slice(0, 300) + '…' : item.description;
  }
  return slim;
}

/** Track lists carry ~4 KB per track; lists get the fields a model needs, get_track the full object. */
export function compactTracks(data: unknown): unknown {
  const slimList = (list: unknown[]) => list.map((item) => (isTrack(item) ? slimTrack(item) : item));
  if (Array.isArray(data)) {
    return slimList(data);
  }
  if (data && typeof data === 'object') {
    return Object.fromEntries(Object.entries(data).map(([name, value]) => [name, Array.isArray(value) ? slimList(value) : value]));
  }
  return data;
}

export function toText(data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n[truncated - ${text.length} characters in total; ask for a smaller page or count]`;
}
