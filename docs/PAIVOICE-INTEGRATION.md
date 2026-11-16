# PaiVoice App integration

This branch connects the App's user-initiated one-to-one voice call button to the PaiVoice realtime core. It does not change `main` and does not deploy either service.

## Environment

Set these variables in the App's server/build environment:

- `NEXT_PUBLIC_PAIVOICE_ENABLED=true`: explicitly enables PaiVoice routing. It defaults to `false`, so the existing call screen remains the fallback until the service is configured and verified.
- `NEXT_PUBLIC_PAIVOICE_WS_URL`: the public PaiVoice WebSocket endpoint, using `wss://` in production. This value is intentionally public.
- `PAIVOICE_AUTH_SECRET`: the same random secret configured on the PaiVoice service. Keep it server-only; do not add the `NEXT_PUBLIC_` prefix.

The App issues a 120-second, single-use HMAC ticket at `POST /api/paivoice/ticket`. The route validates the App's existing account session before signing. It does not use Supabase Auth directly because this App currently uses its own account-session cookie.

## Conversation flow

1. The user starts a one-to-one voice call from the chat page.
2. The user taps **开始通话** in the call screen. This deliberate second tap lets the browser request microphone permission and unlock audio playback from a user gesture.
3. PaiVoice keeps the microphone active during a call and uses Silero VAD v5 through ONNX Runtime Web to classify speech locally in the browser. Only accepted speech frames (plus a short pre-roll) are sent to the PaiVoice call service; raw microphone audio is not sent to the VAD asset host. Browser capture requests echo cancellation, noise suppression, and automatic gain control; the mic mute control stops the audio track. If the model/runtime cannot load, the client reports `rms-fallback` and retains the previous RMS detector so calls remain usable.
4. PaiVoice transcribes the turn and sends a `transcript` event to the App.
5. The App runs its existing browser-side `generateChatCompletion` with the current chat session and message history. This preserves the App's existing character configuration, prompt assembly, and locally configured provider credentials.
6. The App sends the generated text back over the same WebSocket as `client_reply`. PaiVoice synthesizes the reply and streams audio back.
7. User and assistant text are saved to the existing chat history with `origin: "call"`. No audio-message bubbles are created.

The App aborts a voice reply generation after 100 seconds and sends a short timeout response, leaving a margin before PaiVoice's 120-second browser-reply deadline. If PaiVoice reaches its deadline first, it sends a `reply_timeout` event so the App can cancel late generation instead of saving a reply that can no longer be spoken. PaiVoice can fall back to the optional server-side `ADAPTER_URL` if one is configured. Without either reply path, the call reports an error rather than inventing a character response.

## Current scope

- PaiVoice is used for user-initiated and character-initiated one-to-one voice calls when enabled.
- The service allows one active PaiVoice call per authenticated account; reconnecting resumes the existing call.
- Group calls and video calls remain on the legacy engine. Existing incoming-call notification, ringtone, vibration, and accept/reject UI are retained; the connected one-to-one call uses PaiVoice.
- Video, camera, and screen sharing are not enabled by this integration. The character can end a call by speaking a normal goodbye and emitting the private `[结束通话]` control marker; user interruption cancels that pending hangup. Explicit `设置定时醒来` tasks force a voice call and schedule up to three retries, two minutes apart.
- The microphone stays active during connected calls and uses automatic VAD listening.
- After a character-initiated one-to-one call is accepted, the character gets the first turn through a server-mediated proactive-turn event. User-initiated calls still wait for the user to speak first.
- For explicit wake-call schedules, the character speaks first; if no recognized user response arrives within 30 seconds after the greeting, the call ends and the next retry is queued two minutes later. At most three retries are queued. A recognized response or an explicit decline/hangup cancels the remaining retries.
- PaiVoice calls skip the legacy post-hangup background reply, because each conversational turn has already been generated and saved during the call.
- The speaker control mutes/unmutes received audio; actual output routing remains controlled by Android/browser audio routing.

## Local speech detection

- The browser loads the `@ricky0123/vad-web` browser bundle and ONNX Runtime Web from version-pinned jsDelivr URLs. Model inference runs on the device; the CDN supplies JavaScript/WASM/model assets only and does not receive microphone audio.
- Silero VAD v5 probabilities gate PCM transmission. The client retains a short in-memory pre-roll to avoid clipping the first syllable, uses a higher confidence threshold and sustained duration before interrupting character playback, and closes a user turn after a sustained non-speech interval.
- No voiceprint, speaker embedding, voice identity template, or audio recording is created or persisted. VAD distinguishes speech-like activity from non-speech; it does not verify who is speaking and cannot perfectly reject music with vocals.
- If the browser blocks the CDN scripts, ONNX initialization fails, or the model cannot run in the WebView, the client falls back to the legacy RMS gate. This fallback is functional but less reliable against music.

## Verification still required

This code has not yet been verified on a real Android device or against a deployed PaiVoice service. Before treating it as ready, test:

- App ticket issuance with a real logged-in account and matching server secret.
- WSS connection, microphone permission, ASR, TTS, and character reply generation.
- Silero VAD model loading and inference in the target Android WebView, speech start/end, music-only and music-with-vocals false-trigger rates, first-syllable pre-roll, mic mute/unmute, and interruption while the character is speaking. Verify the `vadStatus` event reports `silero` rather than `rms-fallback`. Echo cancellation and noise suppression depend on browser/device support and should be tested with both headphones and speaker playback.
- Reconnect during a network change and ensuring a fresh ticket is issued.
- Transcript persistence after hangup and after reopening the chat.
- Android background/lock-screen behavior. Browser/PWA background microphone and audio behavior is constrained by the operating system.

The mock ASR/TTS providers only verify protocol flow; mock ASR returns no transcript and mock TTS returns no audio.

## Proactive interaction controls

- The existing microphone control only controls microphone capture and speech recognition.
- The existing speaker control keeps its original icon and “扬声器已开/已关” label, but its behavior is a per-session proactive-contact permission. Turning it off does not mute ordinary call replies; it blocks unsolicited proactive voice and text messages and cancels queued ordinary follow-ups where the client controls them.
- Explicit user messages still receive normal replies while proactive contact is disabled.
- User status is inferred from natural-language messages rather than exact command phrases. Busy/study expressions switch to low-frequency companionship; finishing-study/free-time expressions restore normal interaction; sleep expressions suppress ordinary proactive contact; explicit requests not to be reminded pause proactive contact.
- Scheduled wake-up calls remain a special user-requested event and may run during sleep mode, but still respect the master proactive permission toggle.
- Study-mode follow-ups are delayed and generated with a short instruction to keep reminders infrequent, gentle, and non-interruptive.
- During an active PaiVoice call, idle proactive turns wait about 4 minutes in normal mode and 15 minutes in study mode; the timer is reset by user speech and character playback.
- These controls are client-side policy. Pending server-side push jobs and Android background behavior still require end-to-end verification before production use.
