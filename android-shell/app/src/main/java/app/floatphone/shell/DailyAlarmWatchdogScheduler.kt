package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * Local safety net for a daily alarm whose server push never reaches this device.
 * The server gets a short delivery window; if no call attempt is persisted by then,
 * the shell starts the first incoming-call attempt locally.
 */
object DailyAlarmWatchdogScheduler {
    private const val PREFS = "daily_alarm_watchdog"
    private const val KEY_CONFIG = "config"
    private const val KEY_PENDING = "pending"
    private const val REQUEST_CODE = 4205
    private const val DELIVERY_GRACE_MS = 45_000L

    @Synchronized
    fun schedule(context: Context, id: String, sessionId: String, characterName: String, localTime: String, timeZone: String): Boolean {
        if (id.isBlank() || sessionId.isBlank() || characterName.isBlank()) return false
        val zone = runCatching { ZoneId.of(timeZone) }.getOrNull() ?: return false
        val time = runCatching { LocalTime.parse(localTime) }.getOrNull() ?: return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val oldConfig = runCatching { JSONObject(prefs.getString(KEY_CONFIG, "").orEmpty()) }.getOrNull()
        val oldId = oldConfig?.optString("id").orEmpty()
        if (oldId.isNotBlank() && oldId != id) {
            runCatching { (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pendingIntent(context, oldId)) }
            DailyAlarmCallScheduler.cancelForConfig(context, oldId)
            DailyAlarmFallbackScheduler.cancelForConfig(context, oldId)
        }
        val config = JSONObject()
            .put("id", id)
            .put("session_id", sessionId)
            .put("character_name", characterName)
            .put("local_time", time.toString())
            .put("time_zone", zone.id)
            .toString()
        if (!prefs.edit().putString(KEY_CONFIG, config).commit()) return false
        val existing = runCatching { JSONObject(prefs.getString(KEY_PENDING, "").orEmpty()) }.getOrNull()
        val existingFireAt = existing?.optLong("fire_at", 0L) ?: 0L
        if (existing?.optString("config_id") == id && existingFireAt > System.currentTimeMillis()) {
            return arm(context, id, existingFireAt)
        }
        return scheduleNext(context, JSONObject(config))
    }

    @Synchronized
    fun cancel(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val config = runCatching { JSONObject(prefs.getString(KEY_CONFIG, "").orEmpty()) }.getOrNull()
        val id = config?.optString("id").orEmpty()
        if (id.isNotBlank()) {
            runCatching { (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pendingIntent(context, id)) }
            DailyAlarmCallScheduler.cancelForConfig(context, id)
            DailyAlarmFallbackScheduler.cancelForConfig(context, id)
        }
        prefs.edit().remove(KEY_CONFIG).remove(KEY_PENDING).commit()
    }

    @Synchronized
    fun restore(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val config = runCatching { JSONObject(prefs.getString(KEY_CONFIG, "").orEmpty()) }.getOrNull() ?: return
        val pending = runCatching { JSONObject(prefs.getString(KEY_PENDING, "").orEmpty()) }.getOrNull()
        if (pending == null || pending.optString("config_id") != config.optString("id")) {
            scheduleNext(context, config)
            return
        }
        val fireAt = pending.optLong("fire_at", 0L)
        if (fireAt <= System.currentTimeMillis()) {
            // Do not ring a stale occurrence after a long shutdown; restore the next future day.
            scheduleNext(context, config)
            return
        }
        arm(context, config.optString("id"), fireAt)
    }

    @Synchronized
    internal fun onFire(context: Context, intent: Intent?) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val config = runCatching { JSONObject(prefs.getString(KEY_CONFIG, "").orEmpty()) }.getOrNull() ?: return
        val pending = runCatching { JSONObject(prefs.getString(KEY_PENDING, "").orEmpty()) }.getOrNull() ?: return
        val id = config.optString("id")
        if (pending.optString("config_id") != id) return
        val firedId = intent?.data?.lastPathSegment.orEmpty()
        if (firedId.isNotBlank() && firedId != id) return
        val instanceId = pending.optString("instance_id")
        // Arm the next local day first; today's attempt must not block recurrence.
        scheduleNext(context, config)
        if (instanceId.isBlank() || DailyAlarmCallScheduler.hasPendingInstance(context, instanceId)
            || DailyAlarmCallScheduler.isTerminalInstance(context, instanceId)) return
        val sessionId = config.optString("session_id")
        val name = config.optString("character_name").ifBlank { "角色" }
        val started = PushService.startDailyAlarmCall(context, sessionId, name, instanceId, 1)
        if (!started) DailyAlarmCallScheduler.onDeliveryFailure(context, sessionId, name, instanceId, 1)
    }

    private fun scheduleNext(context: Context, config: JSONObject): Boolean {
        val id = config.optString("id")
        val zone = runCatching { ZoneId.of(config.optString("time_zone")) }.getOrNull() ?: return false
        val time = runCatching { LocalTime.parse(config.optString("local_time")) }.getOrNull() ?: return false
        val now = ZonedDateTime.now(zone)
        var next = now.toLocalDate().atTime(time).atZone(zone)
        if (!next.isAfter(now)) next = now.toLocalDate().plusDays(1).atTime(time).atZone(zone)
        val dateKey = next.toLocalDate().format(DateTimeFormatter.ISO_LOCAL_DATE)
        val instanceId = "$id:$dateKey"
        val fireAt = next.toInstant().toEpochMilli() + DELIVERY_GRACE_MS
        val pending = JSONObject()
            .put("config_id", id)
            .put("instance_id", instanceId)
            .put("fire_at", fireAt)
            .toString()
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_PENDING, pending).commit()) return false
        return arm(context, id, fireAt)
    }

    private fun arm(context: Context, id: String, fireAt: Long): Boolean {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val operation = pendingIntent(context, id)
        return runCatching {
            if (Build.VERSION.SDK_INT >= 23) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, operation)
            else manager.setExact(AlarmManager.RTC_WAKEUP, fireAt, operation)
            true
        }.getOrElse {
            runCatching { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, operation); true }.getOrDefault(false)
        }
    }

    private fun pendingIntent(context: Context, id: String): PendingIntent = PendingIntent.getBroadcast(
        context, REQUEST_CODE,
        Intent(context, DailyAlarmWatchdogReceiver::class.java).setData(Uri.parse("floatshell://daily-alarm-watchdog/${Uri.encode(id)}")),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

class DailyAlarmWatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) { DailyAlarmWatchdogScheduler.onFire(context, intent) }
}
