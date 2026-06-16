import assert from "node:assert/strict";
import { parseFfprobeMetadata } from "../src/lib/mediaProbe";

const audioOnly = parseFfprobeMetadata({
  streams: [{ codec_type: "audio", codec_name: "aac", duration: "12.5" }],
  format: { duration: "12.5" },
});

assert.equal(audioOnly.has_video, false);
assert.equal(audioOnly.has_audio, true);
assert.equal(audioOnly.video_codec, null);
assert.equal(audioOnly.audio_codec, "aac");
assert.equal(audioOnly.duration_seconds, 12.5);
assert.equal(audioOnly.width, null);
assert.equal(audioOnly.height, null);
assert.equal(audioOnly.has_video === true, false, "audio-only media must not be packageable");

const videoWithAudio = parseFfprobeMetadata({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, duration: "65.0" },
    { codec_type: "audio", codec_name: "aac", duration: "65.0" },
  ],
  format: { duration: "65.0" },
});

assert.equal(videoWithAudio.has_video, true);
assert.equal(videoWithAudio.has_audio, true);
assert.equal(videoWithAudio.video_codec, "h264");
assert.equal(videoWithAudio.audio_codec, "aac");
assert.equal(videoWithAudio.duration_seconds, 65);
assert.equal(videoWithAudio.width, 1920);
assert.equal(videoWithAudio.height, 1080);
assert.equal(videoWithAudio.has_video === true, true, "video+audio media should be packageable");

console.log("media validation smoke passed");
