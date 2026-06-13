export const creditCosts = {
  upload_analyze_video: 10,
  video_conversion_mp4: 5,
  export_job: 15,
  highlight_export_3_min: 20,
  shorts_export: 15,
  commentary_cut: 25,
  thumbnail_pack: 5,
  social_content_pack: 5,
  caption_generation: 10,
} as const;

export type CreditAction = keyof typeof creditCosts;

export function validateCredits(isUnlimited: boolean, balance: number, action: CreditAction) {
  if (isUnlimited) return { ok: true, cost: 0, balanceAfter: balance };
  const cost = creditCosts[action];
  return { ok: balance >= cost, cost, balanceAfter: balance - cost };
}
