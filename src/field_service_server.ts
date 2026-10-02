import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z, ZodError } from "zod";

import { infrai, InfraiError } from "./infrai_client.js";
import { scheduleTechnicianFollowUp } from "./follow_up_scheduler.js";

const port = Number(process.env.PORT ?? 3000);
const workerBaseUrl = process.env.WORKER_BASE_URL ?? `http://localhost:${port}`;

const runQuerySchema = z.object({
  workOrderId: z.string().min(1),
  technicianId: z.string().min(1),
  technicianName: z.string().min(1),
  photoKeys: z.string().min(1),
});

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function completeTechnicianFollowUp(input: z.infer<typeof runQuerySchema>): Promise<void> {
  console.log(
    `Follow-up ready for ${input.technicianName} on ${input.workOrderId} with ${input.photoKeys.split(",").length} photos`,
  );
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", workerBaseUrl);

  if (request.method === "POST" && url.pathname === "/follow-ups") {
    const result = await scheduleTechnicianFollowUp(await jsonBody(request), {
      infrai,
      workerBaseUrl,
      now: () => new Date(),
    });
    send(response, 202, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/internal/follow-ups/run") {
    const query = runQuerySchema.parse(Object.fromEntries(url.searchParams));
    try {
      await completeTechnicianFollowUp(query);
      send(response, 200, { status: "follow_up_ready", workOrderId: query.workOrderId });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      await infrai.errors.capture({
        exception: { name: error.name, message: error.message },
        level: "error",
        context: { workOrderId: query.workOrderId, technicianId: query.technicianId },
        idempotency_key: `follow-up-failure:${query.workOrderId}`,
      });
      send(response, 502, { error: "follow_up_execution_failed" });
    }
    return;
  }

  send(response, 404, { error: "not_found" });
}

const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    if (error instanceof ZodError) {
      send(response, 400, { error: "invalid_request", issues: error.issues });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      send(response, status, { error: error.code, message: error.message });
      return;
    }
    send(response, 500, { error: "internal_error" });
  });
});

server.listen(port, () => {
  console.log(`Field-service follow-up API listening on ${workerBaseUrl}`);
});
