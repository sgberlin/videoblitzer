import assert from "node:assert/strict";
import { alternativePackageDefaults, duplicateUploadCreditPolicy, matchesDuplicateIdentity, packageReusePolicy } from "../src/lib/duplicateDetection";

const original = {
  userId: "user-1",
  fileSha256: "abc123",
  verifiedSizeBytes: 10_000,
  durationSeconds: 120.4,
};

assert.equal(matchesDuplicateIdentity(original, { ...original }), true, "same file upload twice detects duplicate");
assert.equal(matchesDuplicateIdentity(original, { ...original, durationSeconds: 121.2 }), true, "same file different project still detects duplicate when identity matches");
assert.equal(matchesDuplicateIdentity(original, { ...original, fileSha256: "changed" }), false, "changed file does not detect duplicate");
assert.equal(matchesDuplicateIdentity(original, { ...original, durationSeconds: 122 }), false, "duration beyond one second does not detect duplicate");

assert.deepEqual(packageReusePolicy(), { chargeCredits: false, createWorkerJob: false }, "duplicate reuse does not create new worker job or charge credits");
assert.deepEqual(alternativePackageDefaults("analysis-1"), { reuseAnalysis: true, analysisId: "analysis-1" }, "alternative package creates job defaults with reuse_analysis=true");

const customPackageOptions = {
  targetPlatform: "TikTok",
  tonePreset: "high_energy",
  clipDurationPreference: "short",
  numberOfClips: 6,
  includeCaptions: true,
  outputs: ["vertical", "landscape", "square"],
  focusType: "big_plays",
};
assert.equal(customPackageOptions.numberOfClips, 6, "custom package stores package_options");
assert.deepEqual(duplicateUploadCreditPolicy(true), { chargeUploadAnalyze: false, chargeFullAnalysis: false }, "duplicate upload does not double-charge full analysis");
assert.deepEqual(duplicateUploadCreditPolicy(false), { chargeUploadAnalyze: true, chargeFullAnalysis: true }, "new upload charges full analysis");

console.log("Duplicate workflow smoke tests passed.");
