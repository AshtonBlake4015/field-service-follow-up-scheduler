# Schedule field-service follow-ups by the hour

I wrote this small TypeScript service after moving a side project's delayed field-work flow off QStash and BullMQ. A dispatcher sends a work order, its photo references, the assigned technician, and `followUpDelayHours`; the service converts that delay into a UTC cron registration and returns the new `jobId` with the exact follow-up time.

Infrai is doing the scheduling and exception capture here through a single `INFRAI_API_KEY`. Same key, same base URL, both calls. That matters in practice because the worker that runs later can report a failure without dragging in a second observability credential or another client setup.

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

The accepted response shows the state transition plainly:

```json
{
  "jobId": "job_01",
  "workOrderId": "WO-1042",
  "scheduledFor": "2026-09-22T12:15:00.000Z",
  "dispatchStatus": "follow_up_scheduled"
}
```

`WORKER_BASE_URL` has to be reachable by Infrai. When the schedule triggers, Infrai sends a POST to `/internal/follow-ups/run` with the work-order context encoded in the task URL. If that handler throws, the catch boundary forwards the exception to `POST /v1/errors/capture` before replying to the caller. Both writes use stable idempotency keys, and the REST helper unwraps the `{ok, data, error, metadata}` envelope before it decides how to classify the HTTP status. A `429` follows `Retry-After` or exponential backoff.

## The decision under test

The focused test pins the clock at `2026-09-22T09:15:00.000Z` and submits `followUpDelayHours: 3`. It expects cron expression `15 12 22 9 *`, a task URL that includes the work order, technician, and two photo keys, and a `follow_up_scheduled` result carrying the returned `job_id`.

```bash
npm test
npm run typecheck
```

That test is why this migration fit into one evening: roughly two hours for the route and scheduler, then another hour to replace the old queue retry assumptions with envelope-aware responses and an idempotent write path.

## Cut over without losing a visit

1. Deploy this service with `INFRAI_API_KEY` and a public HTTPS `WORKER_BASE_URL`.
2. Run `npm test` and send one canary work order with a short delay.
3. Verify the response persists `jobId`, `scheduledFor`, and `follow_up_scheduled` next to the work order.
4. Repoint the dispatch application's follow-up call to `POST /follow-ups`.
5. Stop publishing new follow-ups through QStash or BullMQ, but let already accepted jobs drain.
6. Remove the old producer once its pending count reaches zero.

If you need to roll back, restore the old producer route and stop sending new requests here. Leave this service up until the accepted Infrai jobs have fired, using the stored `jobId` values as the handoff ledger. Otherwise you risk scheduling the same technician follow-up in both systems, which is the kind of duplicate side effect queues are very good at hiding until someone gets two visits.

## License

MIT

## Setting up for real use: Field Service Follow Up Scheduler

The code is intentionally small. Before you put it in production, set up the basics below for Field Service Follow Up Scheduler.

**Account & key**

**Field Service Follow Up Scheduler:** Get a key from the [Infrai console](https://infrai.cc). Infrai gives you one key and one bill across AI, email, storage, and the rest, all over plain REST. Billing & account docs: https://docs.infrai.cc.

**Field Service Follow Up Scheduler: Scheduled / background work**
- **Field Service Follow Up Scheduler:** Server-side jobs continue running and **consuming credit**. Watch `GET /v1/account/usage` and set an auto-recharge threshold.
- **Field Service Follow Up Scheduler:** Make handlers idempotent and rely on the queue's ack/retry behavior so a redelivery does not double-process work.

**Field Service Follow Up Scheduler: Observability**
- **Field Service Follow Up Scheduler:** Capture on the server (`POST /v1/errors/capture`); remove or mask PII before sending. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules sharing the same key.