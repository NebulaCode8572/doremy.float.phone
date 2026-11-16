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
3. PaiVoice keeps the microphone active during a call and uses client-side VAD to detect speech start/end automatically. Browser capture requests echo cancellation, noise suppression, and automatic gain control; the mic mute control stops the audio track.
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

## Verification still required

This code has not yet been verified on a real Android device or against a deployed PaiVoice service. Before treating it as ready, test:

- App ticket issuance with a real logged-in account and matching server secret.
- WSS connection, microphone permission, ASR, TTS, and character reply generation.
- Automatic VAD turn detection, mic mute/unmute, speaker mute, and interruption while the character is speaking or thinking. Echo cancellation and noise suppression depend on browser/device support and should be tested with both headphones and speaker playback.
- Reconnect during a network change and ensuring a fresh ticket is issued.
- Transcript persistence after hangup and after reopening the chat.
- Android background/lock-screen behavior. Browser/PWA background microphone and audio behavior is constrained by the operating system.

The mock ASR/TTS providers only verify protocol flow; mock ASR returns no transcript and mock TTS returns no audio.
