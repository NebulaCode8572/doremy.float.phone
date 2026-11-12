package app.floatphone.shell

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Native incoming-call screen.
 *
 * This file owns presentation only. Delivery, notification construction, and
 * ringtone/vibration lifecycle remain in PushService and CallAlert unchanged.
 */
class IncomingCallActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_CHARACTER_NAME = "character_name"
        const val EXTRA_CALL_TS = "call_ts"
        const val EXTRA_ALARM_INSTANCE_ID = "daily_alarm_instance_id"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prepareCallWindow()

        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        val characterName = intent.getStringExtra(EXTRA_CHARACTER_NAME).orEmpty().ifEmpty { "对方" }
        val callTs = intent.getLongExtra(EXTRA_CALL_TS, 0L)
        val alarmInstanceId = intent.getStringExtra(EXTRA_ALARM_INSTANCE_ID).orEmpty()

        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(36), dp(28), dp(28))
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.rgb(24, 31, 48), Color.rgb(12, 16, 26)),
            )
        }

        // Top status
        root.addView(TextView(this).apply {
            text = "来 电"
            textSize = 12f
            letterSpacing = 0.34f
            setTextColor(Color.rgb(160, 174, 198))
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, dp(28)))

        // Flexible space keeps the caller identity centered on different screens.
        root.addView(View(this), LinearLayout.LayoutParams(1, 0, 1f))

        val avatar = TextView(this).apply {
            text = characterName.take(1)
            textSize = 42f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.rgb(104, 133, 190), Color.rgb(76, 91, 151)),
            ).apply {
                shape = GradientDrawable.OVAL
                setStroke(dp(2), Color.argb(90, 255, 255, 255))
            }
            elevation = dp(8).toFloat()
        }
        root.addView(avatar, LinearLayout.LayoutParams(dp(112), dp(112)))

        root.addView(TextView(this).apply {
            text = characterName
            textSize = 29f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            maxLines = 2
            setPadding(0, dp(24), 0, 0)
        }, LinearLayout.LayoutParams(-1, -2))

        root.addView(TextView(this).apply {
            text = "邀请你进行语音通话"
            textSize = 15f
            setTextColor(Color.rgb(166, 178, 199))
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, 0)
        }, LinearLayout.LayoutParams(-1, -2))

        root.addView(View(this), LinearLayout.LayoutParams(1, 0, 1f))

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }

        fun action(label: String, symbol: String, color: Int, description: String, onClick: () -> Unit): View {
            val column = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                isClickable = true
                isFocusable = true
                contentDescription = description
                setOnClickListener { onClick() }
            }
            val circle = TextView(this).apply {
                text = symbol
                textSize = 29f
                typeface = Typeface.DEFAULT
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                }
                elevation = dp(5).toFloat()
            }
            column.addView(circle, LinearLayout.LayoutParams(dp(72), dp(72)))
            column.addView(TextView(this).apply {
                text = label
                textSize = 14f
                setTextColor(Color.rgb(224, 230, 240))
                gravity = Gravity.CENTER
                setPadding(0, dp(12), 0, 0)
            }, LinearLayout.LayoutParams(-1, -2))
            return column
        }

        actions.addView(
            action("拒接", "×", Color.rgb(220, 73, 82), "拒绝语音来电") {
                finishCall(alarmInstanceId)
            },
            LinearLayout.LayoutParams(dp(112), -2).apply { marginEnd = dp(36) },
        )
        actions.addView(
            action("接听", "✓", Color.rgb(42, 166, 112), "接听语音来电") {
                answer(sessionId, callTs, alarmInstanceId)
            },
            LinearLayout.LayoutParams(dp(112), -2).apply { marginStart = dp(36) },
        )
        root.addView(actions, LinearLayout.LayoutParams(-1, -2))
        root.addView(View(this), LinearLayout.LayoutParams(1, dp(28)))

        setContentView(root)
    }

    @Suppress("DEPRECATION")
    private fun prepareCallWindow() {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    @Deprecated("Use the visible decline action; retained so system Back also counts as an explicit decline.")
    override fun onBackPressed() {
        finishCall(intent.getStringExtra(EXTRA_ALARM_INSTANCE_ID).orEmpty())
    }

    private fun answer(sessionId: String, callTs: Long, alarmInstanceId: String) {
        val ts = if (callTs > 0) callTs else System.currentTimeMillis()
        val target = "${MainActivity.SITE_URL}/#incoming-call=${android.net.Uri.encode(sessionId)}&rt=$ts&answered=1"
        val launch = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(MainActivity.EXTRA_OPEN_URL, target)
        }
        if (Build.VERSION.SDK_INT >= 26) {
            val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            if (keyguard.isKeyguardLocked) {
                keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                    override fun onDismissSucceeded() { launchAcceptedCall(launch, alarmInstanceId) }
                    override fun onDismissCancelled() { /* Keep ringing; unanswered timeout remains armed. */ }
                })
                return
            }
        }
        launchAcceptedCall(launch, alarmInstanceId)
    }

    private fun launchAcceptedCall(launch: Intent, alarmInstanceId: String) {
        if (alarmInstanceId.isNotBlank()) DailyAlarmCallScheduler.cancel(this, alarmInstanceId)
        CallAlert.stop(this)
        runCatching { startActivity(launch) }
        finish()
    }

    private fun finishCall(alarmInstanceId: String) {
        if (alarmInstanceId.isNotBlank()) DailyAlarmCallScheduler.cancel(this, alarmInstanceId)
        CallAlert.stop(this)
        finish()
    }
}
