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
