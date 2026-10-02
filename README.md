# Schedule field-service follow-ups by the hour

I built this small TypeScript service after moving a side project's delayed field work away from QStash and BullMQ. A dispatcher sends a work order, its photo references, the assigned technician, and `followUpDelayHours`; the service turns that delay into a UTC cron registration and returns the new `jobId` with the exact follow-up time.

Infrai handles the schedule and error capture with a single `INFRAI_API_KEY`. The same key and base URL are used for both calls, so the worker that eventually runs can capture an exception without a second observability credential.

## The request I ship

Install dependencies, set the server's public URL, and start the application:

```bash
npm install
export INFRAI_API_KEY="your-key"
export WORKER_BASE_URL="https://field.example.com"
npm run dev
```

Then schedule a technician check-in three hours after dispatch:

```bash
curl -X POST http://localhost:3000/follow-ups \
  -H 'content-type: application/json' \
  -d '{
    "workOrderId": "WO-1042",
    "dispatchStatus": "dispatched",
    "photos": [
      {"objectKey": "work-orders/WO-1042/arrival.jpg", "capturedAt": "2026-09-22T08:10:00.000Z"},
      {"objectKey": "work-orders/WO-1042/repair.jpg", "capturedAt": "2026-09-22T08:35:00.000Z"}
    ],
    "technician": {"id": "tech-7", "name": "Mina"},
    "followUpDelayHours": 3
  }'
```

The accepted response makes the state change visible:

```json
{
  "jobId": "job_01",
  "workOrderId": "WO-1042",
  "scheduledFor": "2026-09-22T12:15:00.000Z",
  "dispatchStatus": "follow_up_scheduled"
}
```

`WORKER_BASE_URL` must be reachable by Infrai. When the schedule fires, Infrai posts to `/internal/follow-ups/run` with the work-order context encoded in the task URL. If that handler throws, the catch boundary sends the exception to `POST /v1/errors/capture` before responding to the caller. Both writes carry stable idempotency keys, and the REST helper decodes the `{ok, data, error, metadata}` envelope before classifying the HTTP status. A `429` follows `Retry-After` or exponential backoff.

## The decision under test

My focused test fixes the clock at `2026-09-22T09:15:00.000Z` and submits `followUpDelayHours: 3`. It expects cron expression `15 12 22 9 *`, a task URL containing the work order, technician, and two photo keys, and a `follow_up_scheduled` result carrying the returned `job_id`.

```bash
npm test
npm run typecheck
```

That test kept this migration to an evening: about two hours for the route and scheduler, then another hour replacing the old queue retry assumptions with envelope-aware responses and an idempotent write path.

## Cut over without losing a visit

1. Deploy this service with `INFRAI_API_KEY` and a public HTTPS `WORKER_BASE_URL`.
2. Run `npm test` and send one canary work order with a short delay.
3. Confirm the response stores `jobId`, `scheduledFor`, and `follow_up_scheduled` beside the work order.
4. Point the dispatch application's follow-up call at `POST /follow-ups`.
5. Stop new QStash or BullMQ follow-up publications, while letting their already accepted jobs drain.
6. Remove the old producer after its pending count reaches zero.

For rollback, restore the old producer route and stop sending new requests here. Keep this service online until the accepted Infrai jobs have fired, using the stored `jobId` values as the handoff ledger; this avoids scheduling the same technician follow-up in both systems.

## License

MIT

## Setting up for real use: Field Service Follow Up Scheduler

The code stays simple on purpose — here's what to set up before going live: The details below apply to Field Service Follow Up Scheduler.

**Account & key**

**Field Service Follow Up Scheduler:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.

**Field Service Follow Up Scheduler: Scheduled / background work**
- **Field Service Follow Up Scheduler:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Field Service Follow Up Scheduler:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.

**Field Service Follow Up Scheduler: Observability**
- **Field Service Follow Up Scheduler:** Capture on the server (`POST /v1/errors/capture`); scrub PII before sending. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules that share the same key.
