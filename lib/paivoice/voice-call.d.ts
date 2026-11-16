export type PaiVoiceEvent = (payload?: any) => void;

export type PaiVoiceOptions = {
  url: string;
  video?: false;
  pushToTalk?: boolean;
  getAuthTicket: () => Promise<string>;
  on?: {
    state?: (mode: string) => void;
    transcript?: PaiVoiceEvent;
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
  setPushToTalk(pressed: boolean): void;
  setSpeakerMuted(muted: boolean): void;
  sendReply(text: string, turnId: string): boolean;
}
