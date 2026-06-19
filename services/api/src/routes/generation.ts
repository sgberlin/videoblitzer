import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { AI_SYSTEM_INSTRUCTION } from "@videoblitzer/prompts";
import { thumbnailQualityChecklist, thumbnailTemplates } from "@videoblitzer/thumbnail-engine";

export const generationRouter = Router();

generationRouter.post("/social-pack/generate", requireAuth, (req, res) => {
  return res.json({
    systemInstruction: AI_SYSTEM_INSTRUCTION,
    package: {
      titleVariants: ["Match highlights built from confirmed moments", "Key plays and turning points"],
      youtubeDescription: "A publish-ready description will be generated from confirmed match data only.",
      chapters: "Chapters appear after timeline moments are confirmed.",
      pinnedComment: "Which moment changed the match?",
      tiktokCaption: "Confirmed highlights, ready for vertical edits.",
      instagramCaption: "Match story, clips, and key moments prepared for posting.",
      xPost: "Highlights and key moments packaged for fast publishing.",
      hashtags: ["#VideoBlitzer", "#Highlights", "#MatchDay"],
      thumbnailTextOptions: ["ALL GOALS", "MATCH HIGHLIGHTS", "LAST-MINUTE DRAMA"],
      postingStrategy: "Publish the master highlight first, then schedule Shorts from the strongest confirmed moments.",
      languages: ["English", "Spanish", "Portuguese", "Turkish", "German", "French", "Arabic"],
    },
  });
});

generationRouter.post("/thumbnail/generate", requireAuth, (req, res) => {
  return res.json({ templates: thumbnailTemplates, checklist: thumbnailQualityChecklist, identity: "Team colors + initials + player/game frames" });
});
