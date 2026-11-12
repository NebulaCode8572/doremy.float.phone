package app.floatphone.shell

import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.PowerManager

/**
 * 来电提示的共享状态：角色铃声循环 + 振动循环 + 超时未接。
 * 音频从 Android 私有缓存读取；缺失或静音时仍保留振动提醒。
 * 任何一方（接听/拒接/超时/新来电顶替）调用 stop 即全部收场。
 */
object CallAlert {
    const val NOTIF_CALL_ID = 60
    const val NOTIF_MISSED_ID = 61
    const val TIMEOUT_MS = 55_000L

    private var vibrator: Vibrator? = null
    private var ringtonePlayer: MediaPlayer? = null
    private var playbackGeneration = 0
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null
    /** 当前振铃中的会话（IncomingCallActivity 读取；空表示没有活动来电） */
    @Volatile var activeSessionId: String = ""
    @Volatile var activeCharacterName: String = ""

    private fun systemVibrator(context: Context): Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }.getOrNull()

    /** 开始来电：循环振动 + 挂超时。已有来电时先收掉旧的。 */
    fun start(context: Context, sessionId: String, characterName: String, timeoutMs: Long = TIMEOUT_MS, onTimeout: () -> Unit = {}) {
        stop(context, cancelNotification = false)
        activeSessionId = sessionId
        activeCharacterName = characterName
        startRingtone(context.applicationContext, sessionId)
        val pattern = longArrayOf(0, 500, 250, 500, 1400)
        vibrator = systemVibrator(context)?.also { v ->
            runCatching {
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(VibrationEffect.createWaveform(pattern, 1))
                } else {
                    @Suppress("DEPRECATION")
                    v.vibrate(pattern, 1)
                }
            }
        }
        if (timeoutMs > 0L) {
            val runnable = Runnable {
                timeoutRunnable = null
                runCatching { onTimeout() }
            }
            timeoutRunnable = runnable
            handler.postDelayed(runnable, timeoutMs)
        }
    }

    /** 使用已同步到 Android 私有目录的角色来电铃声；缺失或静音时保持振动兜底。 */
    private fun startRingtone(context: Context, sessionId: String) {
        val file = CallRingtoneStore.resolve(context, sessionId) ?: return
        val generation = ++playbackGeneration
        runCatching {
            MediaPlayer().also { player ->
                ringtonePlayer = player
                // Keep the audio pipeline alive while the screen is off, especially for
                // the persistent native alarm fallback running under a foreground service.
                player.setWakeMode(context, PowerManager.PARTIAL_WAKE_LOCK)
                player.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                )
                player.isLooping = true
                player.setDataSource(file.absolutePath)
                player.setOnPreparedListener {
                    if (generation == playbackGeneration && ringtonePlayer === player) {
                        runCatching { player.start() }
                    } else {
                        runCatching { player.release() }
                    }
                }
                player.setOnErrorListener { failed, _, _ ->
                    if (ringtonePlayer === failed) ringtonePlayer = null
                    runCatching { failed.release() }
                    true
                }
                player.prepareAsync()
            }
        }.onFailure {
            ringtonePlayer?.let { runCatching { it.release() } }
            ringtonePlayer = null
        }
    }

    /** 收场：停音频、停振动、撤超时，可选把来电通知一并撤下。 */
    fun stop(context: Context, cancelNotification: Boolean = true) {
        activeSessionId = ""
        activeCharacterName = ""
        playbackGeneration++
        ringtonePlayer?.let { player ->
            runCatching { if (player.isPlaying) player.stop() }
            runCatching { player.reset() }
            runCatching { player.release() }
        }
        ringtonePlayer = null
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        runCatching { vibrator?.cancel() }
        vibrator = null
        if (cancelNotification) {
            runCatching {
                context.getSystemService(NotificationManager::class.java).cancel(NOTIF_CALL_ID)
            }
        }
    }
}
