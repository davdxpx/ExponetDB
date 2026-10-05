import { createHash, createHmac } from 'node:crypto'
import type { CheckpointDocument, CheckpointExporter, ExportedCheckpoint } from '../checkpoints.ts'
import { CheckpointExportError, checkpointBytes, checkpointKey } from './document.ts'

/**
 * Exports checkpoints to S3-compatible object storage (Hetzner Object
 * Storage in V1) with AWS Signature Version 4, without an SDK.
 *
 * - One object per checkpoint, never overwritten: `If-None-Match: *` (a
 *   conditional write) refuses an existing key; an existing object counts as
 *   exported only after a read shows the same bytes.
 * - Optional object lock (`COMPLIANCE` or `GOVERNANCE` with a retention
 *   period) so that even the bucket's own credentials cannot delete it before
 *   the period ends; requires a bucket created with object lock.
 * - Credentials stay in memory; errors carry the HTTP status only.
 */
export interface S3ExporterOptions {
  /** `https://fsn1.your-objectstorage.com` or a local test endpoint. */
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly prefix?: string
  readonly objectLock?: { readonly mode: 'COMPLIANCE' | 'GOVERNANCE'; readonly days: number }
  readonly timeoutMs?: number
  /** Injectable clock for signing (tests); defaults to the system clock. */
  readonly now?: () => Date
  readonly fetch?: typeof fetch
}

const hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Uint8Array, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest()

/** RFC 3986 percent-encoding as SigV4 requires (`encodeURIComponent` leaves `!'()*`). */
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

function encodePath(path: string): string {
  return path.split('/').map(uriEncode).join('/')
}

export interface SignedRequest {
  readonly url: string
  readonly headers: Record<string, string>
}

/** Signs a request with SigV4 (exported for tests against published examples). */
export function signS3Request(input: {
  readonly method: string
  readonly url: URL
  readonly headers: Record<string, string>
  readonly payload: Uint8Array
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly date: Date
}): SignedRequest {
  const amzDate = input.date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const payloadHash = hex(input.payload)
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  }
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('')
  const signedHeaders = names.join(';')
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]): [string, string] => [uriEncode(k), uriEncode(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${day}/${input.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${input.secretAccessKey}`, day)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  return {
    url: input.url.toString(),
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

export function s3CheckpointExporter(options: S3ExporterOptions): CheckpointExporter {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
    throw new Error('invalid bucket name')
  }
  const endpoint = new URL(options.endpoint)
  if (
    endpoint.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  ) {
    throw new Error(
      'object storage endpoints must use https (plain http only for a local test server)',
    )
  }
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())

  async function send(
    method: 'PUT' | 'GET',
    key: string,
    payload: Uint8Array,
    extra: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(endpoint.toString())
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodePath(`${options.bucket}/${key}`)}`
    const signed = signS3Request({
      method,
      url,
      headers: extra,
      payload,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      date: now(),
    })
    const { host: _host, ...headers } = signed.headers
    return doFetch(signed.url, {
      method,
      headers,
      ...(method === 'PUT' ? { body: payload } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      redirect: 'error',
    })
  }

  return {
    sink: `s3.${options.bucket}`.slice(0, 64),
    async export(document: CheckpointDocument): Promise<ExportedCheckpoint> {
      const key = checkpointKey(document, options.prefix)
      const body = checkpointBytes(document)
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-md5': createHash('md5').update(body).digest('base64'),
        'if-none-match': '*',
      }
      if (options.objectLock !== undefined) {
        const until = new Date(now().getTime() + options.objectLock.days * 86_400_000)
        headers['x-amz-object-lock-mode'] = options.objectLock.mode
        headers['x-amz-object-lock-retain-until-date'] = until
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z')
      }
      let response: Response
      try {
        response = await send('PUT', key, body, headers)
      } catch {
        throw new CheckpointExportError('network')
      }
      await response.arrayBuffer().catch(() => undefined)
      if (response.ok) {
        return { location: `s3://${options.bucket}/${key}` }
      }
      if (response.status === 412 || response.status === 409) {
        // Already there: exported only if it holds exactly this checkpoint.
        const existing = await send('GET', key, new Uint8Array(), {}).catch(() => undefined)
        const bytes =
          existing?.ok === true ? new Uint8Array(await existing.arrayBuffer()) : undefined
        if (bytes !== undefined && Buffer.compare(bytes, body) === 0) {
          return { location: `s3://${options.bucket}/${key}` }
        }
        throw new CheckpointExportError('conflict')
      }
      throw new CheckpointExportError(`http_${response.status}`)
    },
  }
}
