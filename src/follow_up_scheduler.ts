import { z } from "zod";

import type { InfraiApi } from "./infrai_client.js";

export const followUpRequestSchema = z.object({
  workOrderId: z.string().min(1),
  dispatchStatus: z.literal("dispatched"),
  photos: z.array(z.object({
    objectKey: z.string().min(1),
    capturedAt: z.string().datetime(),
  })).min(1),
  technician: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  followUpDelayHours: z.number().int().min(1).max(168),
});

export type FollowUpRequest = z.infer<typeof followUpRequestSchema>;

export type ScheduledFollowUp = {
  jobId: string;
  workOrderId: string;
  scheduledFor: string;
  dispatchStatus: "follow_up_scheduled";
};

function cronAt(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

function taskUrl(workerBaseUrl: string, input: FollowUpRequest): string {
  const url = new URL("/internal/follow-ups/run", workerBaseUrl);
  url.searchParams.set("workOrderId", input.workOrderId);
  url.searchParams.set("technicianId", input.technician.id);
  url.searchParams.set("technicianName", input.technician.name);
  url.searchParams.set("photoKeys", input.photos.map((photo) => photo.objectKey).join(","));
  return url.toString();
}

export async function scheduleTechnicianFollowUp(
  rawInput: unknown,
  dependencies: { infrai: InfraiApi; workerBaseUrl: string; now: () => Date },
): Promise<ScheduledFollowUp> {
  const input = followUpRequestSchema.parse(rawInput);
  const scheduledFor = new Date(
    dependencies.now().getTime() + input.followUpDelayHours * 60 * 60 * 1_000,
  );
  const result = await dependencies.infrai.cron.create(
    {
      cron_expr: cronAt(scheduledFor),
      task: taskUrl(dependencies.workerBaseUrl, input),
    },
    `follow-up:${input.workOrderId}:${scheduledFor.toISOString()}`,
  );

  return {
    jobId: result.job_id,
    workOrderId: input.workOrderId,
    scheduledFor: scheduledFor.toISOString(),
    dispatchStatus: "follow_up_scheduled",
  };
}
