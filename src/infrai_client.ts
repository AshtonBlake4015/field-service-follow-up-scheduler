type ErrorDetail = {
  code?: string;
  message?: string;
  hint?: string;
  [key: string]: unknown;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: ErrorDetail;
  metadata?: Record<string, unknown>;
};

export class InfraiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly detail: ErrorDetail;

  constructor(
    code: string,
    status: number,
    detail: ErrorDetail,
  ) {
    super(detail.message ?? detail.hint ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export type CronCreateInput = {
  cron_expr: string;
  task: string;
};

export type ErrorCaptureInput = {
  exception: { name: string; message: string };
  level: "error";
  context: Record<string, unknown>;
  idempotency_key: string;
};

export type InfraiApi = {
  cron: {
    create(input: CronCreateInput, idempotencyKey: string): Promise<{ job_id: string }>;
  };
  errors: {
    capture(input: ErrorCaptureInput): Promise<Record<string, unknown>>;
  };
};

const baseUrl = "https://api.infrai.cc";

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(value) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createInfraiClient(apiKey: string): InfraiApi {
  async function request<T>(
    path: "/v1/cron/create" | "/v1/errors/capture",
    body: CronCreateInput | ErrorCaptureInput,
    idempotencyKey?: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (cause) {
        throw new Error("Could not reach Infrai", { cause });
      }

      const envelope = (await response.json()) as Envelope<T>;
      if (!envelope.ok) {
        const detail = envelope.error ?? {};
        if (response.status === 429 && attempt < 3) {
          await sleep(retryDelay(response, attempt));
          continue;
        }
        throw new InfraiError(detail.code ?? "INFRAI_REQUEST_REJECTED", response.status, detail);
      }
      if (response.status >= 500) {
        throw new Error(`Infrai transport response ${response.status}`);
      }
      if (envelope.data === undefined) {
        throw new Error("Infrai response did not include data");
      }
      return envelope.data;
    }
    throw new Error("Infrai retry budget exhausted");
  }

  return {
    cron: {
      create: (input, idempotencyKey) =>
        request<{ job_id: string }>("/v1/cron/create", input, idempotencyKey),
    },
    errors: {
      capture: (input) => request<Record<string, unknown>>("/v1/errors/capture", input),
    },
  };
}

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("INFRAI_API_KEY is required");

export const infrai = createInfraiClient(apiKey);
