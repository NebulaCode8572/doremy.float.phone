package app.floatphone.shell

import android.content.Context
import android.util.Base64
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * Native cache for the web app's incoming-call ringtone.
 *
 * Files are keyed by chat session ID (or the reserved "global" key). Uploads
 * are chunked so WebView never has to pass a multi-megabyte string in one call.
 */
object CallRingtoneStore {
    private const val MAX_BYTES = 8 * 1024 * 1024
    private const val PREFS = "call_ringtone_settings"
    private const val DIR = "call-ringtones"

    private fun safeKey(key: String): String {
        require(key.isNotBlank() && key.length <= 256)
        return MessageDigest.getInstance("SHA-256")
            .digest(key.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    private fun directory(context: Context): File =
        File(context.filesDir, DIR).apply { mkdirs() }

    private fun target(context: Context, key: String): File =
        File(directory(context), "${safeKey(key)}.audio")

    private fun temp(context: Context, key: String): File =
        File(directory(context), "${safeKey(key)}.upload")

    fun beginUpload(context: Context, key: String, mimeType: String, expectedBytes: Int): Boolean = runCatching {
        require(mimeType.lowercase().startsWith("audio/"))
        require(expectedBytes in 1..MAX_BYTES)
        val file = temp(context, key)
        file.parentFile?.mkdirs()
        FileOutputStream(file, false).use { }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt("expected:${safeKey(key)}", expectedBytes)
            .putString("mime:${safeKey(key)}", mimeType.lowercase())
            .apply()
        true
    }.getOrDefault(false)

    fun appendChunk(context: Context, key: String, base64Chunk: String): Boolean = runCatching {
        require(base64Chunk.length <= 96 * 1024)
        val bytes = Base64.decode(base64Chunk, Base64.DEFAULT)
        val file = temp(context, key)
        require(file.exists())
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val expected = prefs.getInt("expected:${safeKey(key)}", 0)
        require(expected > 0 && file.length() + bytes.size <= expected && file.length() + bytes.size <= MAX_BYTES)
        FileOutputStream(file, true).use { it.write(bytes) }
        true
    }.getOrDefault(false)

    fun finishUpload(context: Context, key: String): Boolean = runCatching {
        val hash = safeKey(key)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val expected = prefs.getInt("expected:$hash", 0)
        val source = temp(context, key)
        require(expected > 0 && source.exists() && source.length() == expected.toLong())
        val destination = target(context, key)
        if (destination.exists()) destination.delete()
        require(source.renameTo(destination))
        prefs.edit().remove("expected:$hash").apply()
        true
    }.getOrDefault(false)

    fun setMuted(context: Context, key: String, muted: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("muted:${safeKey(key)}", muted).apply()
    }

    fun delete(context: Context, key: String) {
        runCatching { target(context, key).delete() }
        runCatching { temp(context, key).delete() }
        val hash = safeKey(key)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove("expected:$hash")
            .remove("mime:$hash")
            .remove("muted:$hash")
            .apply()
    }

    /** null means explicitly muted or no cached ringtone. */
    fun resolve(context: Context, sessionId: String): File? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val sessionHash = runCatching { safeKey(sessionId) }.getOrNull()
        if (sessionHash != null && prefs.getBoolean("muted:$sessionHash", false)) return null
        val sessionFile = runCatching { target(context, sessionId) }.getOrNull()
        if (sessionFile?.isFile == true && sessionFile.length() > 0L) return sessionFile

        val globalHash = safeKey("global")
        if (prefs.getBoolean("muted:$globalHash", false)) return null
        return target(context, "global").takeIf { it.isFile && it.length() > 0L }
    }
}
