import assert from "node:assert/strict";
import test from "node:test";

import { scheduleTechnicianFollowUp } from "../src/follow_up_scheduler.js";
import type { CronCreateInput, InfraiApi } from "../src/infrai_client.js";

test("a dispatched work order schedules its technician follow-up by the requested hours", async () => {
  let captured: { input: CronCreateInput; idempotencyKey: string } | undefined;
  const fakeInfrai: InfraiApi = {
    cron: {
      create: async (input, idempotencyKey) => {
        captured = { input, idempotencyKey };
        return { job_id: "job_field_42" };
      },
    },
    errors: { capture: async () => ({}) },
  };

  const result = await scheduleTechnicianFollowUp(
    {
      workOrderId: "WO-1042",
      dispatchStatus: "dispatched",
      photos: [
        { objectKey: "work-orders/WO-1042/arrival.jpg", capturedAt: "2026-09-22T08:10:00.000Z" },
        { objectKey: "work-orders/WO-1042/repair.jpg", capturedAt: "2026-09-22T08:35:00.000Z" },
      ],
      technician: { id: "tech-7", name: "Mina" },
      followUpDelayHours: 3,
    },
    {
      infrai: fakeInfrai,
      workerBaseUrl: "https://field.example.com",
      now: () => new Date("2026-09-22T09:15:00.000Z"),
    },
  );

  assert.equal(captured?.input.cron_expr, "15 12 22 9 *");
  const task = new URL(captured?.input.task ?? "https://invalid.example");
  assert.equal(task.searchParams.get("workOrderId"), "WO-1042");
  assert.equal(task.searchParams.get("technicianName"), "Mina");
  assert.equal(
    task.searchParams.get("photoKeys"),
    "work-orders/WO-1042/arrival.jpg,work-orders/WO-1042/repair.jpg",
  );
  assert.equal(captured?.idempotencyKey, "follow-up:WO-1042:2026-09-22T12:15:00.000Z");
  assert.deepEqual(result, {
    jobId: "job_field_42",
    workOrderId: "WO-1042",
    scheduledFor: "2026-09-22T12:15:00.000Z",
    dispatchStatus: "follow_up_scheduled",
  });
});
