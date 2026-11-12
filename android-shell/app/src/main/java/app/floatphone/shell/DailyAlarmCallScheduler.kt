package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

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

    fun schedule(context: Context, sessionId: String, characterName: String, callTs: Long, alarmInstanceId: String, attempt: Int) {
        if (alarmInstanceId.isBlank() || attempt !in 1..2) return
        val value = JSONObject()
            .put(EXTRA_SESSION_ID, sessionId)
            .put(EXTRA_CHARACTER_NAME, characterName)
            .put(EXTRA_CALL_TS, callTs)
            .put(EXTRA_ALARM_INSTANCE_ID, alarmInstanceId)
            .put(EXTRA_ATTEMPT, attempt)
            .toString()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_PENDING, value).apply()
        val pending = pendingIntent(context)
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val dueAt = System.currentTimeMillis() + CallAlert.TIMEOUT_MS
        runCatching {
            if (Build.VERSION.SDK_INT >= 23) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending)
            else manager.setExact(AlarmManager.RTC_WAKEUP, dueAt, pending)
        }.onFailure { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending) }
    }

    fun cancel(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_PENDING).apply()
        runCatching { (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pendingIntent(context)) }
    }

    internal fun onTimeout(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_PENDING, "").orEmpty()
        if (raw.isBlank()) return
        prefs.edit().remove(KEY_PENDING).apply()
        val item = runCatching { JSONObject(raw) }.getOrNull() ?: return
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
            runCatching {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(retry) else context.startService(retry)
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

    fun restore(context: Context) {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PENDING, "").orEmpty()
        if (raw.isBlank()) return
        val item = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val attempt = item.optInt(EXTRA_ATTEMPT, 1)
        if (attempt !in 1..2) return
        val pending = pendingIntent(context)
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val dueAt = System.currentTimeMillis() + 5_000L
        runCatching {
            if (Build.VERSION.SDK_INT >= 23) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending)
            else manager.setExact(AlarmManager.RTC_WAKEUP, dueAt, pending)
        }.onFailure { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pending) }
    }

    private fun pendingIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context, REQUEST_CODE, Intent(context, DailyAlarmCallTimeoutReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

class DailyAlarmCallTimeoutReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) { DailyAlarmCallScheduler.onTimeout(context) }
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
