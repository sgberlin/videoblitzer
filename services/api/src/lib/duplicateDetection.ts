export type VideoIdentity = {
  userId: string;
  fileSha256?: string | null;
  verifiedSizeBytes?: number | null;
  durationSeconds?: number | null;
};

export function matchesDuplicateIdentity(original: VideoIdentity, candidate: VideoIdentity) {
  if (original.userId !== candidate.userId) return false;
  if (!original.fileSha256 || !candidate.fileSha256 || original.fileSha256 !== candidate.fileSha256) return false;
  if (original.verifiedSizeBytes === null || original.verifiedSizeBytes === undefined || candidate.verifiedSizeBytes === null || candidate.verifiedSizeBytes === undefined) return false;
  if (original.verifiedSizeBytes !== candidate.verifiedSizeBytes) return false;
  if (original.durationSeconds === null || original.durationSeconds === undefined || candidate.durationSeconds === null || candidate.durationSeconds === undefined) return false;
  return Math.abs(original.durationSeconds - candidate.durationSeconds) <= 1;
}

export function duplicateUploadCreditPolicy(duplicateDetected: boolean) {
  return {
    chargeUploadAnalyze: !duplicateDetected,
    chargeFullAnalysis: !duplicateDetected,
  };
}

export function packageReusePolicy() {
  return {
    chargeCredits: false,
    createWorkerJob: false,
  };
}

export function alternativePackageDefaults(analysisId?: string | null) {
  return {
    reuseAnalysis: Boolean(analysisId),
    analysisId: analysisId ?? null,
  };
}
