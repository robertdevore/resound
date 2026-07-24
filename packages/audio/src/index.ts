export * from "./types.js";
export { MockRecorder } from "./mock-recorder.js";
export { DiscordRecorder, type DiscordRecorderOptions, type VoiceConnectionLike } from "./discord-recorder.js";
export { PycordDiscordRecorder, type PycordDiscordRecorderOptions } from "./pycord-discord-recorder.js";
export {
  SystemRecorder,
  buildSystemFfmpegArgs,
  isCleanSystemRecorderClose,
  type SystemRecorderOptions
} from "./system-recorder.js";
export { pcmToWav, pcmDurationSeconds, type WavFormat } from "./wav.js";
