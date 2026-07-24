import "@resound/audio";
import "@resound/core";
import "@resound/transcribers";

export {};

declare module "@resound/audio" {
  interface Recorder {
    readonly id?: string;
    readonly mode: "mock" | "local-capture" | "discord-native" | "system" | "discord";
    preflight?: (context: {
      sessionDir: string;
      outputDir?: string;
      strictConsent?: boolean;
    }) => Promise<{
      status: "pass" | "warning" | "fail";
      summary: string;
      warnings: string[];
      errors: string[];
      remediation: string[];
      dependencies: Array<{ name: string; ok: boolean; detail: string }>;
    }>;
    getHealth?: () => {
      summary: string;
    };
  }
}

declare module "@resound/transcribers" {
  interface Transcriber {
    preflight?: () => Promise<{
      status: "pass" | "warning" | "fail";
      provider: string;
      model: string;
      warnings: string[];
      errors: string[];
      remediation: string[];
    }>;
  }
}

declare module "@resound/core" {
  interface SessionManifest {
    status: string;
    requested_capture_mode: string;
    selected_capture_mode: string;
    recorder: { id: string; mode: string };
    audio_files: Record<string, string | undefined>;
    audio_health: string[];
    warnings: string[];
  }

  interface CreateManifestOptions {
    requestedCaptureMode?: string;
    selectedCaptureMode?: string;
    recorderId?: string;
  }
}
