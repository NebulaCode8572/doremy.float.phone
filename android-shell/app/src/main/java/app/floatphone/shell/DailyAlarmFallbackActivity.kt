package app.floatphone.shell

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** Lock-screen surface for the native fallback alarm. The alarm keeps ringing until Stop is pressed. */
class DailyAlarmFallbackActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        val density = resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(48), dp(28), dp(48))
            setBackgroundColor(Color.rgb(22, 26, 34))
        }
        root.addView(TextView(this).apply {
            text = "AI 闹钟"
            textSize = 32f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        })
        root.addView(TextView(this).apply {
            text = "第二次来电仍未接听，闹钟正在响铃"
            textSize = 16f
            setTextColor(Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(0, dp(18), 0, dp(32))
        })
        root.addView(Button(this).apply {
            text = "停止闹钟"
            setOnClickListener {
                DailyAlarmFallbackScheduler.cancel(this@DailyAlarmFallbackActivity)
                finish()
            }
        }, LinearLayout.LayoutParams(-1, dp(56)))
        setContentView(root)
    }
}
