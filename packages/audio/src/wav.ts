/** Minimal PCM → WAV writer (no native deps). */

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

/** Wrap raw little-endian PCM in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, fmt: WavFormat): Buffer {
  const blockAlign = (fmt.channels * fmt.bitDepth) / 8;
  const byteRate = fmt.sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(fmt.bitDepth, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Duration in seconds of a PCM buffer for a given format. */
export function pcmDurationSeconds(pcm: Buffer, fmt: WavFormat): number {
  const bytesPerSample = (fmt.channels * fmt.bitDepth) / 8;
  if (bytesPerSample === 0) return 0;
  return pcm.length / bytesPerSample / fmt.sampleRate;
}
