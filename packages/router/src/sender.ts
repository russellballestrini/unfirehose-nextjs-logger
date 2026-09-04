import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { URL } from 'url';

interface SendResult {
  accepted: number;
  errors: number;
  statusCode: number;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

export async function sendBatch(
  endpoint: string,
  apiKey: string,
  lines: string[]
): Promise<SendResult> {
  const body = lines.join('\n');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await doPost(endpoint, apiKey, body);
      if (result.statusCode >= 200 && result.statusCode < 300) {
        return result;
      }
      if (result.statusCode === 401) {
        // Bad key — don't retry
        return result;
      }
    } catch {
      // Network error — retry
    }

    if (attempt < MAX_RETRIES - 1) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return { accepted: 0, errors: lines.length, statusCode: 0 };
}

function doPost(
  endpoint: string,
  apiKey: string,
  body: string
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const doReq = isHttps ? httpsRequest : httpRequest;

    const req = doReq(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              accepted: parsed.accepted ?? 0,
              errors: parsed.errors ?? 0,
              statusCode: res.statusCode ?? 0,
            });
          } catch {
            resolve({ accepted: 0, errors: 0, statusCode: res.statusCode ?? 0 });
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}
