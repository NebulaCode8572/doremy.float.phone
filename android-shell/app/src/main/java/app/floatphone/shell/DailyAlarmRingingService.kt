package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * Keeps the native fallback ringtone alive after the alarm receiver returns.
 * The persistent state remains owned by DailyAlarmFallbackScheduler so the alarm
 * can be restored after a reboot or a sticky service restart.
 */
class DailyAlarmRingingService : Service() {
    companion object {
        const val ACTION_START = "app.floatphone.shell.START_DAILY_ALARM_RINGING"
        private const val CHANNEL_ID = "shell_calls"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val raw = getSharedPreferences("daily_alarm_native_fallback", Context.MODE_PRIVATE)
            .getString("pending", "").orEmpty()
        if (raw.isBlank()) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val item = runCatching { JSONObject(raw) }.getOrNull()
        if (item == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val sessionId = item.optString(DailyAlarmCallScheduler.EXTRA_SESSION_ID)
        val name = item.optString(DailyAlarmCallScheduler.EXTRA_CHARACTER_NAME).ifBlank { "角色" }

        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "角色来电与闹钟", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "AI 闹钟连续两次未接后的原生响铃"
                    setSound(null, null)
                },
            )
        }
        val dismiss = PendingIntent.getBroadcast(
            this,
            4203,
            Intent(this, CallActionReceiver::class.java).setAction(CallActionReceiver.ACTION_DISMISS_ALARM),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val open = PendingIntent.getActivity(
            this,
            4204,
            Intent(this, DailyAlarmFallbackActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("AI 闹钟")
            .setContentText("$name 的第二次来电仍未接听，闹钟正在响铃")
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .addAction(0, "停止闹钟", dismiss)
            .build()

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                DailyAlarmFallbackScheduler.NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(DailyAlarmFallbackScheduler.NOTIFICATION_ID, notification)
        }
        CallAlert.start(this, sessionId, name, timeoutMs = 0L)
        return START_STICKY
    }

    override fun onDestroy() {
        CallAlert.stop(this, cancelNotification = false)
        super.onDestroy()
    }
}
