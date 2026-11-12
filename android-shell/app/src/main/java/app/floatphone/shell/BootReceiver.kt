package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restore persisted native reminders after boot, clock changes, or an app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_DATE_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED -> {
                runCatching { CheckInAlarmScheduler.restore(context) }
                runCatching { DailyAlarmWatchdogScheduler.restore(context) }
                runCatching { DailyAlarmCallScheduler.restore(context) }
                if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
                    runCatching { DailyAlarmFallbackScheduler.restore(context) }
                    runCatching { PushService.start(context) }
                }
            }
        }
    }
}
