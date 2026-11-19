export type PaiVoiceEvent = (payload?: any) => void;

export type PaiVoiceTtsConfig = {
  model?: string;
  voice_id?: string;
  speed?: number;
  pitch?: number;
  language_boost?: string;
};

export type PaiVoiceOptions = {
  url: string;
  /** Non-secret voice settings copied from the selected Float character configuration. */
  ttsConfig?: PaiVoiceTtsConfig | null;
  video?: false;
  pushToTalk?: boolean;
  getAuthTicket: () => Promise<string>;
  on?: {
    state?: (mode: string) => void;
    vadStatus?: (mode: 'silero' | 'rms-fallback') => void;
    transcript?: PaiVoiceEvent;
    proactiveTurn?: PaiVoiceEvent;
    reply?: PaiVoiceEvent;
    playing?: (playing: boolean) => void;
    speech?: (speaking: boolean) => void;
    reconnecting?: () => void;
    resumed?: () => void;
    closed?: PaiVoiceEvent;
    error?: (message: string) => void;
    nothingHeard?: PaiVoiceEvent;
    replyTimeout?: PaiVoiceEvent;
  };
};

export class VoiceCall {
  constructor(options: PaiVoiceOptions);
  readonly mode: string;
  readonly speaking: boolean;
  readonly playing: boolean;
  start(): Promise<void>;
  hangup(): void;
  setMuted(muted: boolean): Promise<void>;
  setRecitationMode(enabled: boolean): boolean;
  setPushToTalk(pressed: boolean): void;
  setSpeakerMuted(muted: boolean): void;
  sendReply(text: string, turnId: string): boolean;
  startProactiveTurn(): boolean;
}
