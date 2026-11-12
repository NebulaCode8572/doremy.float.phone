package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject
import android.net.Uri
import java.util.UUID

/** Persists the unanswered-call timeout so process recreation does not lose the second attempt. */
object DailyAlarmCallScheduler {
    private const val PREFS = "daily_alarm_call_retry"
    private const val KEY_PENDING = "pending"
    private const val REQUEST_CODE = 4201
    const val EXTRA_ALARM_INSTANCE_ID = "daily_alarm_instance_id"
    const val EXTRA_ATTEMPT = "daily_alarm_attempt"
    const val EXTRA_SESSION_ID = "daily_alarm_session_id"
    const val EXTRA_CHARACTER_NAME = "daily_alarm_character_name"
    const val EXTRA_CALL_TS = "daily_alarm_call_ts"

    @Synchronized
    fun schedule(context: Context, sessionId: String, characterName: String, callTs: Long, alarmInstanceId: String, attempt: Int) {
        if (alarmInstanceId.isBlank() || attempt !in 1..2) return
        val dueAt = System.currentTimeMillis() + CallAlert.TIMEOUT_MS
        val value = JSONObject()
            .put(EXTRA_SESSION_ID, sessionId)
            .put(EXTRA_CHARACTER_NAME, characterName)
            .put(EXTRA_CALL_TS, callTs)
            .put(EXTRA_ALARM_INSTANCE_ID, alarmInstanceId)
            .put(EXTRA_ATTEMPT, attempt)
            .put("token", UUID.randomUUID().toString())
            .put("due_at", dueAt)
            .toString()
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // Cancel the previous attempt's distinct PendingIntent before replacing its token.
        val previousRaw = prefs.getString(KEY_PENDING, "").orEmpty()
        val previousToken = runCatching { JSONObject(previousRaw).optString("token") }.getOrDefault("")
        if (previousToken.isNotBlank()) {
            runCatching {
                (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
                    .cancel(pendingIntent(context, previousToken))
            }
        }
        if (!prefs.edit().putString(KEY_PENDING, value).commit()) return
        val pending = pendingIntent(context, JSONObject(value).optString("token"))
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        runCatching {
            if (Build.VERSION.SDK_INT >= 23) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending)
            else manager.setExact(AlarmManager.RTC_WAKEUP, dueAt, pending)
        }.onFailure { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending) }
    }

    @Synchronized
    fun cancel(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_PENDING, "").orEmpty()
        val token = runCatching { JSONObject(raw).optString("token") }.getOrDefault("")
        prefs.edit().remove(KEY_PENDING).commit()
        runCatching { (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pendingIntent(context, token)) }
    }

    /** Retry once when Android cannot present the first incoming-call notification. */
    internal fun onDeliveryFailure(context: Context, sessionId: String, characterName: String, alarmInstanceId: String, attempt: Int) {
        if (alarmInstanceId.isBlank()) return
        if (attempt <= 1) {
            val retry = Intent(context, PushService::class.java)
                .setAction(PushService.ACTION_DAILY_ALARM_RETRY)
                .putExtra(EXTRA_SESSION_ID, sessionId)
                .putExtra(EXTRA_CHARACTER_NAME, characterName)
                .putExtra(EXTRA_CALL_TS, System.currentTimeMillis())
                .putExtra(EXTRA_ALARM_INSTANCE_ID, alarmInstanceId)
                .putExtra(EXTRA_ATTEMPT, 2)
            val started = runCatching {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(retry) else context.startService(retry)
            }.isSuccess
            if (started) return
        }
        DailyAlarmFallbackScheduler.schedule(context, sessionId, characterName, alarmInstanceId)
    }

    @Synchronized
    internal fun onTimeout(context: Context, intent: Intent?) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_PENDING, "").orEmpty()
        if (raw.isBlank()) return
        val item = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val savedToken = item.optString("token")
        val firedToken = intent?.data?.lastPathSegment.orEmpty().takeUnless { it == "legacy" }.orEmpty()
        // Ignore a stale timeout that was already delivered while a newer call replaced it.
        if (savedToken.isNotBlank() && savedToken != firedToken) return
        prefs.edit().remove(KEY_PENDING).commit()
        CallAlert.stop(context)
        val attempt = item.optInt(EXTRA_ATTEMPT, 1)
        if (attempt == 1) {
            val retry = Intent(context, PushService::class.java)
                .setAction(PushService.ACTION_DAILY_ALARM_RETRY)
                .putExtra(EXTRA_SESSION_ID, item.optString(EXTRA_SESSION_ID))
                .putExtra(EXTRA_CHARACTER_NAME, item.optString(EXTRA_CHARACTER_NAME))
                .putExtra(EXTRA_CALL_TS, System.currentTimeMillis())
                .putExtra(EXTRA_ALARM_INSTANCE_ID, item.optString(EXTRA_ALARM_INSTANCE_ID))
                .putExtra(EXTRA_ATTEMPT, 2)
            val started = runCatching {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(retry) else context.startService(retry)
            }.isSuccess
            if (!started) {
                DailyAlarmFallbackScheduler.schedule(
                    context,
                    item.optString(EXTRA_SESSION_ID),
                    item.optString(EXTRA_CHARACTER_NAME),
                    item.optString(EXTRA_ALARM_INSTANCE_ID),
                )
            }
        } else {
            DailyAlarmFallbackScheduler.schedule(
                context,
                item.optString(EXTRA_SESSION_ID),
                item.optString(EXTRA_CHARACTER_NAME),
                item.optString(EXTRA_ALARM_INSTANCE_ID),
            )
        }
    }

    @Synchronized
    fun restore(context: Context) {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PENDING, "").orEmpty()
        if (raw.isBlank()) return
        val item = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val attempt = item.optInt(EXTRA_ATTEMPT, 1)
        if (attempt !in 1..2) return
        val pending = pendingIntent(context, item.optString("token"))
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Preserve the remaining timeout across reboot; if it already elapsed while powered off,
        // fire immediately rather than granting another full unanswered-call window.
        val savedDueAt = item.optLong("due_at", 0L)
        val dueAt = if (savedDueAt > 0L) maxOf(System.currentTimeMillis(), savedDueAt)
            else System.currentTimeMillis() + 5_000L
        runCatching {
            if (Build.VERSION.SDK_INT >= 23) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending)
            else manager.setExact(AlarmManager.RTC_WAKEUP, dueAt, pending)
        }.onFailure { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending) }
    }

    private fun pendingIntent(context: Context, token: String): PendingIntent = PendingIntent.getBroadcast(
        context, REQUEST_CODE,
        Intent(context, DailyAlarmCallTimeoutReceiver::class.java).setData(
            Uri.parse("floatshell://daily-alarm-timeout/${token.ifBlank { "legacy" }}"),
        ),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

class DailyAlarmCallTimeoutReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) { DailyAlarmCallScheduler.onTimeout(context, intent) }
}

/** Persistent native ringing fallback after both AI call attempts go unanswered. */
object DailyAlarmFallbackScheduler {
    private const val PREFS = "daily_alarm_native_fallback"
    private const val KEY_PENDING = "pending"
    private const val REQUEST_CODE = 4202
    const val NOTIFICATION_ID = 4202

    fun schedule(context: Context, sessionId: String, characterName: String, alarmInstanceId: String) {
        val value = JSONObject()
            .put(DailyAlarmCallScheduler.EXTRA_SESSION_ID, sessionId)
            .put(DailyAlarmCallScheduler.EXTRA_CHARACTER_NAME, characterName)
            .put(DailyAlarmCallScheduler.EXTRA_ALARM_INSTANCE_ID, alarmInstanceId)
            .toString()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_PENDING, value).apply()
        val pending = fallbackPendingIntent(context)
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val dueAt = System.currentTimeMillis() + 1_000L
        runCatching {
            if (Build.VERSION.SDK_INT >= 23) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending)
            else manager.setExact(AlarmManager.RTC_WAKEUP, dueAt, pending)
        }.onFailure { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending) }
    }

    fun cancel(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_PENDING).apply()
        runCatching { (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(fallbackPendingIntent(context)) }
        runCatching { context.getSystemService(android.app.NotificationManager::class.java).cancel(NOTIFICATION_ID) }
        runCatching { context.stopService(Intent(context, DailyAlarmRingingService::class.java)) }
        CallAlert.stop(context)
    }

    fun restore(context: Context) {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PENDING, "").orEmpty()
        if (raw.isBlank()) return
        val pending = fallbackPendingIntent(context)
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val dueAt = System.currentTimeMillis() + 1_000L
        runCatching {
            if (Build.VERSION.SDK_INT >= 23) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending)
            else manager.setExact(AlarmManager.RTC_WAKEUP, dueAt, pending)
        }.onFailure { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending) }
    }

    internal fun fire(context: Context) {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PENDING, "").orEmpty()
        if (raw.isBlank()) return
        val service = Intent(context, DailyAlarmRingingService::class.java).setAction(DailyAlarmRingingService.ACTION_START)
        runCatching {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service) else context.startService(service)
        }.onFailure {
            // If Android refuses the foreground service start, retain the previous direct-notification path.
            runCatching { fireDirect(context, raw) }
        }
    }

    /** Best-effort fallback used only if the foreground ringing service cannot be started. */
    private fun fireDirect(context: Context, raw: String) {
        val item = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val sessionId = item.optString(DailyAlarmCallScheduler.EXTRA_SESSION_ID)
        val name = item.optString(DailyAlarmCallScheduler.EXTRA_CHARACTER_NAME).ifBlank { "角色" }
        CallAlert.start(context, sessionId, name, timeoutMs = 0L)
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
            android.app.NotificationChannel("shell_calls", "角色来电与闹钟", android.app.NotificationManager.IMPORTANCE_HIGH).apply {
                description = "AI 闹钟连续两次未接后的原生响铃"
                setSound(null, null)
            },
        )
        val dismiss = PendingIntent.getBroadcast(
            context, 4203, Intent(context, CallActionReceiver::class.java).setAction(CallActionReceiver.ACTION_DISMISS_ALARM),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val open = PendingIntent.getActivity(
            context, 4204, Intent(context, DailyAlarmFallbackActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = androidx.core.app.NotificationCompat.Builder(context, "shell_calls")
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("AI 闹钟")
            .setContentText("$name 的第二次来电仍未接听，闹钟正在响铃")
            .setCategory(androidx.core.app.NotificationCompat.CATEGORY_ALARM)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .addAction(0, "停止闹钟", dismiss)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun fallbackPendingIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context, REQUEST_CODE, Intent(context, DailyAlarmFallbackReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

class DailyAlarmFallbackReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) { DailyAlarmFallbackScheduler.fire(context) }
}
