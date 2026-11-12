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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** 微信风格的原生全屏来电页；接听/拒接仍走原有来电状态机。 */
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
        fun dp(value: Int) = (value * density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(26), dp(28), dp(22))
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.rgb(34, 34, 35), Color.rgb(57, 57, 58), Color.rgb(45, 45, 46)),
            )
        }

        // 保留系统状态栏，整体观感接近微信原生来电页。
        root.addView(View(this), LinearLayout.LayoutParams(1, dp(18)))
        root.addView(View(this), LinearLayout.LayoutParams(1, 0, 1f))

        val identity = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }
        val avatar = ImageView(this).apply {
            setImageResource(android.R.drawable.ic_menu_myplaces)
            setColorFilter(Color.rgb(185, 185, 185))
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            setPadding(dp(24), dp(24), dp(24), dp(24))
            background = GradientDrawable().apply {
                setColor(Color.rgb(245, 245, 245))
                cornerRadius = dp(12).toFloat()
            }
        }
        identity.addView(avatar, LinearLayout.LayoutParams(dp(116), dp(116)))
        identity.addView(TextView(this).apply {
            text = characterName
            textSize = 25f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            maxLines = 2
            setPadding(0, dp(24), 0, 0)
        }, LinearLayout.LayoutParams(-1, -2))
        root.addView(identity, LinearLayout.LayoutParams(-1, -2))

        root.addView(View(this), LinearLayout.LayoutParams(1, 0, 0.72f))
        root.addView(TextView(this).apply {
            text = "邀请你语音通话..."
            textSize = 16f
            setTextColor(Color.rgb(190, 190, 190))
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, -2))
        root.addView(View(this), LinearLayout.LayoutParams(1, 0, 1f))

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        fun action(label: String, symbol: String, color: Int, rotation: Float, description: String, onClick: () -> Unit): View {
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
                textSize = 35f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                rotation = rotation
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                }
                elevation = dp(3).toFloat()
            }
            column.addView(circle, LinearLayout.LayoutParams(dp(78), dp(78)))
            column.addView(TextView(this).apply {
                text = label
                textSize = 15f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                setPadding(0, dp(12), 0, 0)
            }, LinearLayout.LayoutParams(-1, -2))
            return column
        }

        actions.addView(
            action("拒绝", "☎", Color.rgb(250, 76, 86), 135f, "拒绝语音来电") {
                finishCall(alarmInstanceId)
            },
            LinearLayout.LayoutParams(dp(116), -2).apply { marginEnd = dp(28) },
        )
        actions.addView(
            action("接听", "☎", Color.rgb(7, 190, 96), 0f, "接听语音来电") {
                answer(sessionId, callTs, alarmInstanceId)
            },
            LinearLayout.LayoutParams(dp(116), -2).apply { marginStart = dp(28) },
        )
        root.addView(actions, LinearLayout.LayoutParams(-1, -2))
        root.addView(View(this), LinearLayout.LayoutParams(1, dp(36)))
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
        window.statusBarColor = Color.rgb(34, 34, 35)
        window.navigationBarColor = Color.rgb(34, 34, 35)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
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
