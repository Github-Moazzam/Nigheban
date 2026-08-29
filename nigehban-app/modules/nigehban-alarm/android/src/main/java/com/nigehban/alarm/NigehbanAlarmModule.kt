package com.nigehban.alarm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The lock-screen takeover and the looping siren (N3.3 / N3.4).
 *
 * `src/alarm.js` is the only caller. It treats this module as optional --
 * `requireOptionalNativeModule` returns null in Expo Go and on web -- and falls
 * back to a plain repeating vibration when it is absent. That fallback is not
 * this feature: it needs the app's JavaScript to still be running, so it dies
 * with the process, which is exactly the case an emergency alarm exists for.
 * Everything below is what survives a killed app.
 *
 * Four decisions carry the design:
 *
 *   1. **The channel is silent and does not vibrate.** A notification channel
 *      plays its sound and its vibration pattern exactly once, and Android
 *      gives no way to loop them. So the channel here is deliberately mute and
 *      still, and the `MediaPlayer` and `Vibrator` below own the audio and the
 *      buzzing instead -- both of which *can* be told to repeat forever.
 *
 *   2. **The audio goes out on `STREAM_ALARM`.** `setBypassDnd(true)` on a
 *      channel is silently ignored unless the app holds Notification Policy
 *      Access, which almost no app has and this one does not ask for. Audio
 *      with `USAGE_ALARM` is exempt from Do Not Disturb by default. The alarm
 *      stream is therefore not a volume preference, it is the DND answer.
 *
 *   3. **`CATEGORY_CALL` + `setFullScreenIntent`.** This is the same pair an
 *      incoming-call screen uses, and it is what makes Android launch the
 *      activity over the keyguard instead of posting a heads-up notification.
 *      The launched activity has to cooperate: `withNigehbanAndroid.js` sets
 *      `android:showWhenLocked` and `android:turnScreenOn` on MainActivity, or
 *      the SOS comes up behind the lock screen with the display still off.
 *
 *   4. **The alert id rides on the launching intent.** A full-screen intent is
 *      not a notification tap, so `expo-notifications` never sees it and
 *      `subscribeNotificationTaps` never fires. `consumeLaunchAlertId()` is how
 *      a cold start learns which emergency woke it.
 */
class NigehbanAlarmModule : Module() {

  companion object {
    private const val CHANNEL_ID = "nigehban_fullscreen_alarm"
    private const val NOTIFICATION_ID = 0x4E49 // "NI"
    private const val REQUEST_CODE = 0x4E49
    const val EXTRA_ALERT_ID = "nigehban.alertId"

    /** Matches SIREN_PATTERN in src/alarm.js, so the two feel like one product. */
    private val SIREN_PATTERN = longArrayOf(0, 500, 200, 500, 200, 500, 900)

    /**
     * The siren lives on the class, not on the instance, because it has to
     * outlive the instance.
     *
     * A data-only push starts the alarm from a headless JS runtime. Expo tears
     * that runtime down when the task finishes -- `RNHeadlessAppLoader` only
     * spares it when an Activity has taken the ReactHost over -- and a later
     * cold start builds a *new* module instance. With the player held per
     * instance, that new instance saw `player == null` and `stopAlarm()` became
     * a no-op against a siren that was still audibly playing in the same
     * process, with nothing left that could stop it short of force-stopping the
     * app. Static state means whichever instance is asked can always answer.
     */
    private var player: MediaPlayer? = null

    /**
     * The alarm-stream volume as we found it, so it can be handed back.
     *
     * Null means "not currently raised". Kept separate from the player because a
     * failed `MediaPlayer.prepare()` must still restore the volume it moved.
     */
    private var previousAlarmVolume: Int? = null

    /**
     * The application context the siren was started with.
     *
     * Restoring the volume and cancelling the vibration need a Context, and
     * `appContext.reactContext` is exactly what may already be gone by then --
     * that is the case this whole block exists for. The application context is
     * process-scoped, so it is still good when the React one is not.
     */
    private var sirenContext: Context? = null

    /**
     * Set when a full-screen intent reaches an app that is already running.
     *
     * A cold start reads the id straight off `activity.intent`, but Android
     * delivers the intent to `onNewIntent` when the activity already exists, and
     * that never reaches `activity.intent`. Both paths feed the same
     * `consumeLaunchAlertId()`. Static for the same reason as the player: the
     * instance that receives the intent need not be the one that is asked.
     */
    private var pendingAlertId: String? = null
  }

  override fun definition() = ModuleDefinition {
    Name("NigehbanAlarm")

    OnNewIntent { intent ->
      intent.getStringExtra(EXTRA_ALERT_ID)?.let { pendingAlertId = it }
    }

    // There is deliberately no OnDestroy that silences.
    //
    // It used to, to cover a JS reload in development leaving a siren nothing
    // could stop. But the module is also destroyed when Expo tears down the
    // headless runtime a background push ran in -- and on Android 14 without
    // USE_FULL_SCREEN_INTENT no Activity takes the ReactHost over, so that
    // teardown happens seconds after the alarm starts, on a killed phone, which
    // is the exact scenario N3.3 exists for. The siren has to outlive the
    // runtime that started it. Development is covered from JS instead: App.js
    // stops the alarm once boot settles with no alert to answer.

    AsyncFunction("presentAlarm") { title: String, body: String, alertId: String ->
      val context = requireContext()
      ensureChannel(context)
      // Sound and vibration start before the notification is posted. If posting
      // throws -- a revoked POST_NOTIFICATIONS on Android 13+, most likely --
      // a phone that is screaming is still a phone that raised the alarm.
      startSiren(context)
      startVibration(context)
      postNotification(context, title, body, alertId)
      true
    }

    AsyncFunction("stopAlarm") {
      silence()
      // The siren goes first and the notification second, and the cancel uses
      // whatever context is available rather than insisting on the React one:
      // a stop that throws before silencing is a stop that leaves the phone
      // screaming.
      (appContext.reactContext ?: sirenContext)
        ?.let { NotificationManagerCompat.from(it).cancel(NOTIFICATION_ID) }
      true
    }

    /**
     * The alert id that launched this process, exactly once.
     *
     * It is removed from the intent as it is read. Without that, the same id
     * keeps being returned on every later launch, and the app reopens an
     * emergency that ended days ago -- the same trap
     * `clearLastNotificationResponseAsync` exists for on the notification side.
     */
    AsyncFunction("consumeLaunchAlertId") {
      pendingAlertId?.let {
        pendingAlertId = null
        return@AsyncFunction it
      }
      val intent = appContext.currentActivity?.intent ?: return@AsyncFunction null
      val id = intent.getStringExtra(EXTRA_ALERT_ID)
      if (id != null) intent.removeExtra(EXTRA_ALERT_ID)
      id
    }

    /**
     * Whether this app may still fire a full-screen intent.
     *
     * Since Android 14 the permission is no longer granted at install to
     * anything that is not a calling or alarm-clock app. When it is not held,
     * `setFullScreenIntent` degrades to an ordinary heads-up notification --
     * quietly, which is why the Setup screen asks rather than assumes.
     */
    AsyncFunction("canUseFullScreenIntent") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return@AsyncFunction true
      val manager = requireContext().getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.canUseFullScreenIntent()
    }

    /** Open the one Settings page that can grant the above. */
    AsyncFunction("openFullScreenIntentSettings") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return@AsyncFunction false
      val context = requireContext()
      val intent = Intent(
        Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
        android.net.Uri.parse("package:${context.packageName}")
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }
  }

  private fun requireContext(): Context =
    appContext.reactContext ?: throw IllegalStateException("NigehbanAlarm: no Android context")

  // ---- the notification ----------------------------------------------------

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Emergency lock-screen alarm",
      NotificationManager.IMPORTANCE_HIGH // HIGH or above, or the full-screen intent is ignored
    ).apply {
      description = "Takes over the screen for a family emergency and sounds a siren until answered."
      // Mute and still on purpose -- see decision 1 in the class comment. The
      // MediaPlayer and Vibrator own these so they can repeat.
      setSound(null, null)
      enableVibration(false)
      lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      // Ignored without Notification Policy Access. Kept because it costs
      // nothing and helps on the builds where it is granted; the alarm stream
      // is what actually carries this through Do Not Disturb.
      setBypassDnd(true)
    }
    manager.createNotificationChannel(channel)
  }

  private fun postNotification(context: Context, title: String, body: String, alertId: String) {
    // The launcher intent rather than a hardcoded MainActivity: the class name
    // is generated and has moved before, and this cannot be the thing that
    // breaks when it moves again.
    val launch = (context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent(Intent.ACTION_MAIN)).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra(EXTRA_ALERT_ID, alertId)
    }

    val pending = PendingIntent.getActivity(
      context,
      REQUEST_CODE,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle(title)
      .setContentText(body)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX) // what IMPORTANCE_HIGH means below API 26
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      // Ongoing and non-cancellable: swiping an emergency away by accident,
      // while the siren keeps playing from a notification that is no longer
      // there to stop it, is a worse state than any of the alternatives.
      .setOngoing(true)
      .setAutoCancel(false)
      .setFullScreenIntent(pending, true)
      .setContentIntent(pending)
      .build()

    NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
  }

  /**
   * `expo-notifications` generates `notification_icon` when one is configured;
   * app.json currently sets only a colour, so the launcher icon is the honest
   * fallback. A missing icon resource throws at notify() time, so this never
   * returns 0.
   */
  private fun smallIcon(context: Context): Int {
    val generated = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (generated != 0) generated else context.applicationInfo.icon
  }

  // ---- the siren -----------------------------------------------------------

  private fun startSiren(context: Context) {
    stopSiren()
    // Held for the stop, which may run long after this React context is gone.
    sirenContext = context.applicationContext

    val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
      ?: return

    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    // Raised to maximum and remembered, because a family member who turned the
    // alarm volume down to sleep is precisely the person this has to wake.
    // Restored in stopSiren so the phone is handed back as it was found.
    try {
      previousAlarmVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
      audio.setStreamVolume(
        AudioManager.STREAM_ALARM,
        audio.getStreamMaxVolume(AudioManager.STREAM_ALARM),
        0
      )
    } catch (e: SecurityException) {
      // Some OEM DND states refuse the change. Play at whatever volume is set
      // rather than not playing at all.
      previousAlarmVolume = null
    }

    try {
      player = MediaPlayer().apply {
        setDataSource(context, uri)
        setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        )
        isLooping = true
        prepare()
        start()
      }
    } catch (e: Exception) {
      // A dead ringtone URI must not take the vibration and the takeover down
      // with it.
      player = null
      restoreVolume()
    }
  }

  private fun stopSiren() {
    player?.let {
      try {
        if (it.isPlaying) it.stop()
      } catch (e: IllegalStateException) {
        // already torn down
      }
      it.release()
    }
    player = null
    restoreVolume()
  }

  private fun restoreVolume() {
    val previous = previousAlarmVolume ?: return
    previousAlarmVolume = null
    val context = sirenContext ?: appContext.reactContext ?: return
    try {
      val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      audio.setStreamVolume(AudioManager.STREAM_ALARM, previous, 0)
    } catch (e: SecurityException) {
      // Nothing useful to do; the user can still change it themselves.
    }
  }

  // ---- the vibration -------------------------------------------------------

  private fun vibrator(context: Context): Vibrator =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }

  private fun startVibration(context: Context) {
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

    // Repeat index 0 -- start the waveform again from the beginning, forever,
    // until cancel(). This is the "until dismissed" half of N3.4.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      vibrator(context).vibrate(VibrationEffect.createWaveform(SIREN_PATTERN, 0), attributes)
    } else {
      @Suppress("DEPRECATION")
      vibrator(context).vibrate(SIREN_PATTERN, 0, attributes)
    }
  }

  /** Everything that makes noise, stopped. Safe to call when nothing is running. */
  private fun silence() {
    stopSiren()
    // Whichever context is still alive. Returning early on a missing React
    // context, as this once did, meant the one path that most needs to silence
    // an alarm -- a runtime that has been torn down since it started one -- was
    // the one path that could not.
    val context = appContext.reactContext ?: sirenContext
    if (context != null) {
      try {
        vibrator(context).cancel()
      } catch (e: Exception) {
        // no vibrator on this device
      }
    }
    sirenContext = null
  }
}
