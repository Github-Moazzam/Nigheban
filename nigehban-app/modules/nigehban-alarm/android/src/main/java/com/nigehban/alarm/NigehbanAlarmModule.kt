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
import androidx.core.app.Person
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
 * Five decisions carry the design:
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
 *   4. **The notification carries the two answers itself.** A full-screen
 *      intent is only launched when the phone is locked or its screen is off.
 *      Android's own rule -- "the system UI may choose to display a heads-up
 *      notification instead, while the user is using the device" -- means that
 *      a family member holding an unlocked phone never gets the takeover, no
 *      matter how the permission is set. That is not a failure to fix, it is
 *      the platform, so the notification has to be answerable where it lands:
 *      `CallStyle` renders it as an incoming call with an answer and a decline,
 *      and those two buttons do exactly what the two buttons on the in-app
 *      takeover do. Without them an ongoing, non-swipeable notification with a
 *      siren behind it is a phone the person cannot make stop.
 *
 *   5. **The alert id rides on every intent.** A full-screen intent is not a
 *      notification tap, so `expo-notifications` never sees it and
 *      `subscribeNotificationTaps` never fires. `consumeLaunchAlertId()` is how
 *      a launch -- cold or warm -- learns which emergency woke it, and
 *      `activeAlertId()` is how an app opened some other way finds the siren
 *      that is already sounding.
 */
class NigehbanAlarmModule : Module() {

  companion object {
    private const val CHANNEL_ID = "nigehban_fullscreen_alarm"
    private const val NOTIFICATION_ID = 0x4E49 // "NI"

    // Three distinct request codes on purpose. PendingIntents that differ only
    // in their extras are "the same" to Android and the second one silently
    // reuses the first; answering and merely opening would then be one action.
    private const val REQUEST_OPEN = 0x4E49
    private const val REQUEST_ANSWER = 0x4E4A
    private const val REQUEST_DISMISS = 0x4E4B

    const val EXTRA_ALERT_ID = "nigehban.alertId"
    const val EXTRA_ANSWERED = "nigehban.answered"

    /** The app's own green and red, so the call buttons match the takeover. */
    private const val ANSWER_TINT = 0xFF3CC183.toInt()
    private const val DECLINE_TINT = 0xFFF2645A.toInt()

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
     * app. Static state means whichever instance is asked can always answer --
     * and it is also what lets `NigehbanAlarmReceiver`, which has no module
     * instance at all, stop a siren from a notification button.
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

    /** Whether the intent that carried `pendingAlertId` was the answer button. */
    private var pendingAnswered = false

    /**
     * The alert a siren is sounding for right now, or null.
     *
     * The reason this exists is the case where somebody opens the app from the
     * launcher while it is screaming, rather than from the notification: there
     * is no alert id on that intent, so `consumeLaunchAlertId()` returns
     * nothing and the app used to come up on Home with the siren still going
     * and no way in the UI to reach it. Cleared by every stop, so a stale id
     * cannot reopen an emergency that is over.
     */
    private var soundingAlertId: String? = null

    /**
     * Stop everything and take the notification down.
     *
     * The one entry point for "this emergency has been answered", callable with
     * no module instance and no React context, because the two callers that
     * matter most have neither: `NigehbanAlarmReceiver` handling the decline
     * button, and a process whose JS runtime was torn down after a headless
     * push started the siren.
     */
    fun dismiss(context: Context?) {
      // The context is read *before* silence() runs, because silence() clears
      // `sirenContext` as its last act. Reading it afterwards -- which is what
      // stopAlarm used to do -- left the cancel with nothing to cancel through
      // on exactly the path where the React context was already gone.
      val ctx = context ?: sirenContext
      silence(ctx)
      if (ctx == null) return
      try {
        NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID)
      } catch (e: Exception) {
        // A cancel that throws must not be the reason the siren survives; it
        // has already been silenced above.
      }
    }

    /** Everything that makes noise, stopped. Safe to call when nothing is running. */
    fun silence(context: Context?) {
      val ctx = context ?: sirenContext
      stopSiren(ctx)
      // Returning early on a missing context, as this once did, meant the one
      // path that most needs to silence an alarm -- a runtime that has been
      // torn down since it started one -- was the one path that could not.
      if (ctx != null) {
        try {
          vibrator(ctx).cancel()
        } catch (e: Exception) {
          // no vibrator on this device
        }
      }
      soundingAlertId = null
      sirenContext = null
    }

    fun activeAlertId(): String? = soundingAlertId

    // ---- the siren ---------------------------------------------------------

    fun startSiren(context: Context) {
      stopSiren(context)
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
        restoreVolume(context)
      }
    }

    private fun stopSiren(context: Context?) {
      player?.let {
        try {
          if (it.isPlaying) it.stop()
        } catch (e: IllegalStateException) {
          // already torn down
        }
        it.release()
      }
      player = null
      restoreVolume(context)
    }

    private fun restoreVolume(context: Context?) {
      val previous = previousAlarmVolume ?: return
      previousAlarmVolume = null
      val ctx = context ?: sirenContext ?: return
      try {
        val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audio.setStreamVolume(AudioManager.STREAM_ALARM, previous, 0)
      } catch (e: SecurityException) {
        // Nothing useful to do; the user can still change it themselves.
      }
    }

    // ---- the vibration -----------------------------------------------------

    private fun vibrator(context: Context): Vibrator =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      }

    fun startVibration(context: Context) {
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

    // ---- the notification --------------------------------------------------

    fun ensureChannel(context: Context) {
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

    fun postNotification(context: Context, title: String, body: String, alertId: String) {
      val open = launchIntent(context, alertId, answered = false, requestCode = REQUEST_OPEN)
      val answer = launchIntent(context, alertId, answered = true, requestCode = REQUEST_ANSWER)
      val decline = PendingIntent.getBroadcast(
        context,
        REQUEST_DISMISS,
        Intent(context, NigehbanAlarmReceiver::class.java)
          .setAction(NigehbanAlarmReceiver.ACTION_DISMISS)
          .putExtra(EXTRA_ALERT_ID, alertId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )

      val manager = NotificationManagerCompat.from(context)

      // CallStyle first on the versions that have it, plain actions everywhere
      // else and whenever it will not post.
      //
      // CallStyle is what makes this read as an incoming call rather than as a
      // notice: it is ranked above everything else in the shade, it does not
      // collapse itself away after a few seconds the way an ordinary heads-up
      // does, and it draws the two answers as call buttons. It is also fussy --
      // since Android 14 it is rejected outright unless the notification either
      // belongs to a phoneCall foreground service or carries a full-screen
      // intent, and `notify` throws rather than degrading. This one does carry a
      // full-screen intent, so it should stand; the catch is here because an
      // emergency notification that throws is an emergency nobody is told about,
      // and a plain notification with two buttons is a complete answer on its
      // own.
      //
      // Gated at API 31 because that is where it stops being a real platform
      // style. Below it, androidx draws its own approximation out of custom
      // RemoteViews, and a heavily skinned OEM launcher is exactly where a
      // custom layout renders wrong. The two buttons are the part that has to
      // work on every phone in the family; the call chrome is the part that is
      // allowed to vary.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        try {
          val caller = Person.Builder().setName(title).setImportant(true).build()
          val style = NotificationCompat.CallStyle
            .forIncomingCall(caller, decline, answer)
            .setAnswerButtonColorHint(ANSWER_TINT)
            .setDeclineButtonColorHint(DECLINE_TINT)
          manager.notify(
            NOTIFICATION_ID,
            builder(context, title, body, open).setStyle(style).build()
          )
          return
        } catch (e: Exception) {
          // A fresh builder below, never this one: setStyle has already been
          // applied to it and reusing it would fail the same way twice.
        }
      }

      manager.notify(
        NOTIFICATION_ID,
        builder(context, title, body, open)
          // Wording matched to the in-app takeover, so the two do not read as
          // two different products asking two different questions.
          .addAction(0, "I'M ON IT", answer)
          .addAction(0, "DISMISS", decline)
          .build()
      )
    }

    private fun builder(
      context: Context,
      title: String,
      body: String,
      open: PendingIntent,
    ) = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle(title)
      .setContentText(body)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX) // what IMPORTANCE_HIGH means below API 26
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      // Ongoing and non-cancellable: swiping an emergency away by accident,
      // while the siren keeps playing from a notification that is no longer
      // there to stop it, is a worse state than any of the alternatives. This is
      // only defensible because the buttons above exist -- an unswipeable
      // notification with nothing on it to press is a trap, not a safeguard.
      .setOngoing(true)
      .setAutoCancel(false)
      .setFullScreenIntent(open, true)
      .setContentIntent(open)

    /**
     * An intent that opens the app on this alert.
     *
     * The launcher intent rather than a hardcoded MainActivity: the class name
     * is generated and has moved before, and this cannot be the thing that
     * breaks when it moves again.
     *
     * `answered` is the difference between the notification body ("show me
     * this") and the answer button ("I am going"). It rides all the way to
     * `consumeLaunchAlertId`, which is where the siren is cut and the ack is
     * sent -- the answer is delivered by opening the app rather than by a
     * broadcast because telling the server needs the session, and the session
     * only exists inside the app.
     */
    private fun launchIntent(
      context: Context,
      alertId: String,
      answered: Boolean,
      requestCode: Int,
    ): PendingIntent {
      val launch = (context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent(Intent.ACTION_MAIN)).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        putExtra(EXTRA_ALERT_ID, alertId)
        if (answered) putExtra(EXTRA_ANSWERED, true)
      }
      return PendingIntent.getActivity(
        context,
        requestCode,
        launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
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

    // ---- what a launch was about -------------------------------------------

    /** Record an alert id off an intent, and cut the siren if it was answered. */
    fun rememberFromIntent(intent: Intent, context: Context?): Boolean {
      val id = intent.getStringExtra(EXTRA_ALERT_ID) ?: return false
      pendingAlertId = id
      pendingAnswered = intent.getBooleanExtra(EXTRA_ANSWERED, false)
      // Read once and removed as it is read. Without that, the same id keeps
      // being returned on every later launch, and the app reopens an emergency
      // that ended days ago -- the same trap
      // `clearLastNotificationResponseAsync` exists for on the notification side.
      intent.removeExtra(EXTRA_ALERT_ID)
      intent.removeExtra(EXTRA_ANSWERED)
      // Somebody who pressed I'M ON IT has answered. Making them listen to the
      // siren for the second or two it takes JavaScript to boot, fetch the row
      // and render the takeover is the app arguing with them.
      if (pendingAnswered) dismiss(context)
      return true
    }

    /** The pending id and how it arrived, exactly once. */
    fun takePending(): Map<String, Any>? {
      val id = pendingAlertId ?: return null
      val answered = pendingAnswered
      pendingAlertId = null
      pendingAnswered = false
      return mapOf("alertId" to id, "answered" to answered)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NigehbanAlarm")

    OnNewIntent { intent ->
      rememberFromIntent(intent, appContext.reactContext)
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
      // After startSiren, which clears it: the siren and the id that names it
      // are set together or the app can be told there is nothing sounding while
      // it is plainly sounding.
      soundingAlertId = alertId
      postNotification(context, title, body, alertId)
      true
    }

    AsyncFunction("stopAlarm") {
      // Whichever context is alive. The siren goes first and the notification
      // second: a stop that throws before silencing is a stop that leaves the
      // phone screaming.
      dismiss(appContext.reactContext)
      true
    }

    /**
     * What launched this process, exactly once.
     *
     * Returns `{ alertId, answered }`, or null when this launch was not about
     * an emergency. `answered` means the person pressed the notification's own
     * I'M ON IT rather than opening the app to look -- the ack is sent from JS
     * on the strength of it.
     */
    AsyncFunction("consumeLaunchAlertId") {
      takePending()?.let { return@AsyncFunction it }
      val intent = appContext.currentActivity?.intent ?: return@AsyncFunction null
      if (!rememberFromIntent(intent, appContext.reactContext)) return@AsyncFunction null
      takePending()
    }

    /**
     * The alert a siren is sounding for right now, or null.
     *
     * For the app that is opened from the launcher, or brought back from the
     * recents list, while the alarm is going: neither of those carries an
     * alert id, and without this the takeover has no way to appear.
     */
    AsyncFunction("activeAlertId") {
      activeAlertId()
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
}
