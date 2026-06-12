import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServiceClient } from "../supabase";

export const clipPlanningRouter = Router();
clipPlanningRouter.use(requireAuth);

const transcriptSegmentSchema = z.object({ id: z.string(), startSeconds: z.number(), endSeconds: z.number(), text: z.string() });

function sentenceBoundaries(segments: Array<z.infer<typeof transcriptSegmentSchema>>) {
  return segments.map((segment) => {
    const sentences = segment.text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [segment.text];
    const segmentDuration = Math.max(0.1, segment.endSeconds - segment.startSeconds);
    const totalChars = sentences.join("").length || 1;
    let cursor = segment.startSeconds;
    return sentences.map((sentence, index) => {
      const fraction = Math.max(0.05, sentence.length / totalChars);
      const duration = index === sentences.length - 1 ? segment.endSeconds - cursor : segmentDuration * fraction;
      const start = cursor;
      const end = Math.min(segment.endSeconds, cursor + duration);
      cursor = end;
      return { id: `${segment.id}-s${index + 1}`, segmentId: segment.id, text: sentence.trim(), startSeconds: start, endSeconds: end };
    });
  }).flat();
}

clipPlanningRouter.post("/transcripts", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), videoId: z.string().uuid().optional(), segments: z.array(transcriptSegmentSchema).max(5000) }).parse(req.body);
  const boundaries = sentenceBoundaries(body.segments);
  const record = { id: crypto.randomUUID(), project_id: body.projectId, video_id: body.videoId, user_id: req.user!.id, segments: body.segments, sentence_boundaries: boundaries, status: "planned" };
  const supabase = createServiceClient();
  if (supabase) {
    const { error } = await supabase.from("transcripts").insert(record);
    if (error) return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ transcript: record, sentenceBoundaries: boundaries });
});

clipPlanningRouter.post("/clips", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), videoId: z.string().uuid().optional(), startSeconds: z.number(), endSeconds: z.number(), markerId: z.string().optional(), sourceSentenceIds: z.array(z.string()).default([]), manualOverride: z.boolean().default(false), metadata: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
  if (body.endSeconds <= body.startSeconds) return res.status(400).json({ error: "Clip end must be after clip start." });
  const clip = { id: crypto.randomUUID(), project_id: body.projectId, video_id: body.videoId, user_id: req.user!.id, start_seconds: body.startSeconds, end_seconds: body.endSeconds, duration_seconds: body.endSeconds - body.startSeconds, marker_id: body.markerId, source_sentence_ids: body.sourceSentenceIds, manual_override: body.manualOverride, metadata: body.metadata ?? {}, status: "planned" };
  const supabase = createServiceClient();
  if (supabase) {
    const { error } = await supabase.from("clip_jobs").insert(clip);
    if (error) return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ clip, warning: body.manualOverride ? "This cut may interrupt a sentence." : null });
});
