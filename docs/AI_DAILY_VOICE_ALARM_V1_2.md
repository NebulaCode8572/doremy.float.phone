# AI Daily Voice Alarm and Proactive Call — v1.2

This document is the implementation baseline for branch `feature/ai-daily-voice-alarm`.
It does not claim that the features are implemented; each checklist item must be verified before release.

## Product decisions

### Daily AI alarm
- Recurs daily at the user's configured local time.
- Sends exactly one morning message and starts an AI voice call.
- If the first call times out without an answer or is not delivered, retry the call once after 30 seconds. Do not resend the morning message.
- If the second call times out without an answer or is not delivered, immediately fire the Android native fallback alarm.
- A call counts as answered only after the call session is accepted/connected, not merely after a push is delivered.
- An explicit user rejection/cancellation stops this alarm instance and does not trigger another call or fallback.
- The fallback uses the same character-specific incoming-call ringtone resolution as the call: character override first, otherwise global setting; explicit character sound-off remains silent. Keep vibration behavior.
- The fallback is pre-registered locally before the scheduled time. Successful answer or explicit cancellation cancels it. No network is required at fallback time.
- After device reboot, restore future daily schedules and any still-valid pending fallback. Expired instances must be reconciled and must not ring late.

### Character-scheduled proactive call
- Add a separate character action/setting for “call me after a delay”; do not repurpose or break the existing delayed proactive-message behavior.
- Use the same scheduling/confirmation interaction pattern as existing delayed proactive contact:
  1. Chat system event indicates the character is arranging a delayed call.
  2. On successful scheduling, a chat system event records the delay and planned call.
  3. The character's natural-language confirmation is stored in chat history.
- Persist a distinct task type and idempotency key, including task ID, session ID, character ID, created time, and fire time.
- At fire time, generate/dispatch a true voice-call event, not a message-only push.
- Character call scheduling and proactive-message scheduling are independent. A new user interaction resets the idle timer according to existing product semantics.
- Prevent duplicate/overlapping calls; honor existing quiet hours and call permissions. Do not make repeated calls if a proactive call is missed unless the user explicitly configures that behavior later.

## Shared call/audio behavior
- Keep the current web ringtone settings UI and data model.
- Resolve incoming-call audio using existing per-session/global precedence.
- The Android shell must receive/cache the selected audio safely in app-private storage; do not pass an entire 8 MB Base64 payload in one Binder transaction. Use bounded chunks or a verified file transfer mechanism.
- Native call audio playback must be lifecycle-bound to the active call and stop on answer, reject, timeout, cancellation, replacement by another call, and service shutdown.
- Preserve vibration. Missing/invalid audio degrades to vibration-only.
- Do not rely on NotificationChannel sound as the primary custom audio mechanism.

## State and idempotency
- Every daily occurrence has an immutable `alarmInstanceId`.
- Track message delivery, call attempt 1, call attempt 2, answer/reject/timeout, and fallback independently.
- Every call attempt has a stable attempt number and unique event ID.
- Repeated push delivery must not create duplicate incoming-call UI or restart a completed alarm.
- Delivery acknowledgement means Android displayed/accepted the incoming-call event; it does not mean the user answered.
- Answer and explicit reject are separate terminal events.
- The server and device reconcile state monotonically; stale retries cannot override an answered/cancelled instance.

## Implementation phases
1. Audit existing delayed-contact action, chat system-event rendering, Android JS bridge, notification/call lifecycle, alarm permissions, and persistence.
2. Implement ringtone transfer/cache and native looping playback.
3. Implement the distinct delayed proactive-call action and chat timeline events, reusing the existing delayed-task scheduling path where possible.
4. Implement daily recurrence, message-once semantics, call timeout/retry state machine, and idempotency.
5. Implement local fallback registration, cancellation, reboot restoration, and permission-state handling.
6. Run TypeScript/lint/build and Android Gradle checks where the environment permits; then perform real-device tests for locked screen, reboot, denied permissions, offline mode, timeout, answer, and rejection.

## Release constraints
- Work only on `feature/ai-daily-voice-alarm` until verified.
- Do not merge to `main` or claim deployment without explicit release approval.
- Do not claim Android behavior is reliable until tested on the target device and Android version.


## Phase 2 implementation status — ringtone bridge

Implemented on `feature/ai-daily-voice-alarm`:
- Android private ringtone cache keyed by chat session ID, with a global fallback key.
- Chunked WebView bridge transfer (48 KiB binary chunks; native per-chunk Base64 input limit).
- Web-side synchronization for global and per-session `incomingCall` settings.
- Startup synchronization after chat IndexedDB hydration.
- Native looping MediaPlayer playback alongside the existing vibration pattern.
- Explicit per-session mute takes precedence over the global ringtone; absent session override inherits global.
- Clearing/disabling a configured ringtone removes the cached per-key file and records the mute/inherit state.

Not yet verified:
- Android Gradle compilation and TypeScript/Next.js build.
- Real-device playback, lock-screen behavior, audio focus/volume/DND interaction, and reboot behavior.
- Cross-origin ringtone URLs may fail browser fetch due to CORS; local uploaded audio assets are the reliable path.
- No deployment or merge to `main` has occurred.


## Phase 3A/3B implementation status — delayed proactive call

Implemented on `feature/ai-daily-voice-alarm`:
- Added a separate `proactive-call-storage` keyspace; it does not replace or mutate existing delayed-message schedules.
- Added the `稍后主动来电` internal action under the existing delayed-contact capability gate.
- Added a dedicated server-side timed task with a stable `proactivecall:<scheduleId>` trigger key.
- On successful server scheduling, appends a compact system event to the chat timeline with the planned time and call intent; the actual generated opening line is persisted through the normal push outbox.
- Added an explicit `proactiveCall: true` task marker. `push-generate` now treats that marker as a call dispatch instruction, so the scheduled task does not depend on the model emitting a call marker.
- The generation prompt asks the character for the opening line to use after the call connects.

Verification still pending:
- GitHub Actions Web Typecheck and Android APK build for this commit.
- Confirm that the new action is exposed in both native-tool and text-action prompt modes.
- Confirm on-device that the compact schedule event and the eventual call opening line both appear in the chat timeline as intended.
- Verify delivery and lock-screen call behavior on a real Android device.

This phase does not yet implement daily recurrence, retry/fallback state transitions, or reboot restoration. No merge or deployment has occurred.


## Phase 3C implementation status — daily alarm scheduling

Implemented on `feature/ai-daily-voice-alarm`:
- Added a Daily AI Alarm settings page: select a chat character, choose a local wall-clock time, enable/update/disable.
- Persisted a distinct daily alarm config with an IANA timezone; each config update gets a new ID and cancels the old server-side task prefix.
- Added a daily alarm task builder. It prepares one LLM snapshot for the selected chat and marks the generated result as a deterministic incoming call. The generated assistant text is stored once through the existing outbox path, while the same event dispatches the call.
- Added server-side recurrence: each occurrence arms the next local calendar day before generating, so provider failure does not silently stop future recurrence. The next occurrence uses a stable date-scoped trigger key and accounts for timezone/DST changes.
- Added startup/foreground scheduled-task refresh for an enabled daily alarm.

Not yet implemented in this phase:
- The two-attempt unanswered-call state machine and explicit rejection handling.
- Pre-registered Android native fallback alarm, fallback cancellation, and reboot restoration.
- On-device verification of actual daily delivery and timezone behavior.

Release remains blocked on CI and real-device verification. No merge or deployment has occurred.

### Phase 3C — native missed-call retry and fallback (implementation added)

- Daily alarm identity and date-scoped instance ID are now attached to the native shell incoming-call broadcast.
- Android persists a 55-second timeout for each daily-alarm call attempt using AlarmManager, rather than relying only on an in-process timer.
- If attempt 1 times out without user action, Android stops the first ring and presents attempt 2. The morning message is not regenerated or resent.
- If attempt 2 times out, Android schedules an immediate native alarm notification and plays the selected character's cached ringtone with looping vibration.
- The native fallback remains persisted until the user presses Stop alarm; BootReceiver restores pending retry/fallback timers after a reboot.
- Answer and explicit decline both cancel the pending retry. Explicit decline is treated as a deliberate user action, not as an unanswered timeout; only no-answer timeout triggers retry.

Verification still required:
- GitHub Actions Web TypeScript/production build and Android APK build for the latest commit.
- Real-device tests for full-screen intent, exact-alarm permission behavior, audio focus, notification permission, Do Not Disturb, OEM background restrictions, reboot restoration, and stop-action behavior.
- This implementation is Android-shell specific; browser-only web push does not have the native retry/fallback state machine.
- No merge or Netlify deployment has occurred.
### Incoming-call first greeting

- Character-initiated voice calls now generate the character's first spoken turn immediately after the user accepts, without waiting for user speech and without relying on the optional auto-chat feature.
- The greeting uses the normal chat-message persistence, subtitle, TTS synthesis, and playback pipeline; its one-time instruction is ephemeral and is not stored in chat history.
- The Android lock-screen answer flag is now carried through the deep-link event, active-call store, and call layer, so a call already accepted on the lock screen opens directly in the connected state and triggers the greeting once.
- Normal incoming calls still require an explicit user answer in the call UI; this change does not auto-answer calls.
### Retry persistence and explicit decline

- The native unanswered-call timeout now persists its absolute due time. After reboot, the remaining timeout is restored; if it elapsed while the device was powered off, the retry/fallback path runs immediately rather than receiving a fresh 5-second timeout.
- Explicitly declining or closing the lock-screen incoming-call activity cancels the daily-alarm retry, matching the notification-action decline behavior. A deliberate decline does not trigger a second call or native fallback.