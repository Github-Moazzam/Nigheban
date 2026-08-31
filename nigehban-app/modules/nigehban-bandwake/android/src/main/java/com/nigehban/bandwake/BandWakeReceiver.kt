package com.nigehban.bandwake

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Where the band's SOS lands when there is no app left to land in.
 *
 * The system creates this object fresh, in a process it has just started for
 * the purpose, with no Activity, no React context and no JavaScript. Everything
 * it needs is static on `BandWake` for exactly that reason.
 *
 * It has roughly ten seconds of execution time and no network guarantees, so it
 * does not try to reach the server itself. It does the two things that must
 * happen inside that window -- write the press down where a later launch will
 * find it, and get the phone to wake somebody -- and leaves the actual alert to
 * the app's ordinary `raise()` path, which already owns the GPS fix, the
 * offline queue, the retry and the family fan-out. Reimplementing any of that
 * here would mean two code paths for one alert, and the emergency one would be
 * the one nobody ever tests.
 *
 * Two ways out, and which one is taken depends on whether anything is alive:
 *
 *   - **JavaScript is running.** `BandWake.liveListener` is set, the press goes
 *     straight to it, the alert leaves immediately and nothing is displayed.
 *     This is the case where the band went out of range rather than the app
 *     being killed.
 *
 *   - **The app is dead.** A full-screen-intent notification, the same
 *     mechanism `nigehban-alarm` uses for an incoming family emergency. On a
 *     locked or idle phone -- a phone in a pocket, which is the whole scenario
 *     -- Android launches the activity itself and the app sends the SOS with
 *     nobody touching anything. On a phone being actively used Android shows it
 *     as a heads-up instead, and SEND IT NOW is one tap.
 */
class BandWakeReceiver : BroadcastReceiver() {

  companion object {
    const val ACTION_SCAN_RESULT = "com.nigehban.bandwake.SCAN_RESULT"

    const val EXTRA_BAND_SOS = "nigehban.bandSos"
    const val EXTRA_BAND_SOS_SEQ = "nigehban.bandSosSeq"

    private const val CHANNEL_ID = "nigehban_band_sos"
    private const val NOTIFICATION_ID = 0x4258 // "BX"
    private const val REQUEST_OPEN = 0x4259

    /**
     * Take the notification down, because the app has the press now.
     *
     * It is posted ongoing and non-cancellable -- an emergency that has not
     * been sent yet must not be swipeable away by accident -- which means
     * something has to be responsible for removing it, or the wearer is left
     * with a permanent "SOS FROM YOUR BAND" they cannot clear. That
     * responsibility sits with whoever consumes the pending press: see
     * `consumePendingSos` in NigehbanBandWakeModule.
     */
    fun dismissNotification(context: Context) {
      try {
        NotificationManagerCompat.from(context.applicationContext).cancel(NOTIFICATION_ID)
      } catch (e: Exception) {
        // Nothing posted, or no notification access. Either way there is
        // nothing on screen that this was meant to remove.
      }
    }
  }

  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext

    // An error frame rather than results: the scan has been dropped, usually
    // because Bluetooth was cycled or the controller reset. Re-arming here is
    // what stops a single glitch quietly disarming the band for good.
    val error = intent.getIntExtra(BluetoothLeScanner.EXTRA_ERROR_CODE, -1)
    if (error != -1) {
      BandWake.recordScanError(app, "scan error $error")
      BandWake.restartIfArmed(app)
      return
    }

    val results = readResults(intent) ?: return
    for (result in results) {
      val seq = BandWake.sosSeq(result) ?: continue
      // The band keeps advertising the same press for ten minutes; only the
      // first sighting of a given sequence number is an emergency, the rest are
      // the same one still going.
      if (BandWake.isDuplicate(app, seq)) continue
      BandWake.remember(app, seq, result.device?.address, result.rssi)
      deliver(app, seq)
    }
  }

  @Suppress("DEPRECATION")
  private fun readResults(intent: Intent): List<ScanResult>? =
    intent.getParcelableArrayListExtra<ScanResult>(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT)

  private fun deliver(context: Context, seq: Int) {
    // Straight to JS when JS exists. It has the session and the location, so
    // the alert is on its way before this receiver returns.
    BandWake.liveListener?.let { listener ->
      try {
        listener(BandWake.takePending(context) ?: mapOf("seq" to seq))
        return
      } catch (e: Exception) {
        // A listener that throws must not swallow the emergency. Fall through
        // and show it, which is what would have happened with no listener.
      }
    }
    notifyBandSos(context, seq)
  }

  // ---- the notification ----------------------------------------------------

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      CHANNEL_ID,
      "SOS from your band",
      // HIGH or above, or the full-screen intent is ignored outright.
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "Shown when your band calls for help and the app was not running."
      lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      setBypassDnd(true)
    }
    manager.createNotificationChannel(channel)
  }

  /**
   * Wake the phone, and carry the press in on the intent.
   *
   * The launcher intent rather than a hardcoded MainActivity, for the same
   * reason `nigehban-alarm` uses one: the class name is generated and has moved
   * before, and this must not be what breaks when it moves again.
   */
  private fun notifyBandSos(context: Context, seq: Int) {
    ensureChannel(context)

    val launch = (context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent(Intent.ACTION_MAIN)).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra(EXTRA_BAND_SOS, true)
      putExtra(EXTRA_BAND_SOS_SEQ, seq)
    }
    val open = PendingIntent.getActivity(
      context,
      REQUEST_OPEN,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle("SOS FROM YOUR BAND")
      .setContentText("Opening Nigehban to tell your family where you are.")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      // The pair that takes over a locked screen instead of queueing in the
      // tray. On an unlocked phone Android downgrades it to a heads-up, which
      // is why there is an explicit action on it as well -- an emergency
      // notification with nothing to press is the trap this app has already
      // been caught by once.
      .setFullScreenIntent(open, true)
      .setContentIntent(open)
      .addAction(0, "SEND IT NOW", open)
      .build()

    try {
      NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
    } catch (e: Exception) {
      // Revoked POST_NOTIFICATIONS on 13+, most likely. The press is already
      // written down, so the next launch still finds it and still sends it.
    }
  }

  /** Matches nigehban-alarm: the generated icon when there is one, else the launcher. */
  private fun smallIcon(context: Context): Int {
    val generated =
      context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (generated != 0) generated else context.applicationInfo.icon
  }
}
