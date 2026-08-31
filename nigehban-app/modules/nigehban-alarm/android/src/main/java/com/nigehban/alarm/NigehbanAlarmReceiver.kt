package com.nigehban.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The notification's decline button, and the only part of the alarm that can
 * answer with no app running at all.
 *
 * The answer button opens the app, because acknowledging an alert needs the
 * signed-in session and the session only exists inside the app. Declining needs
 * nothing: it is "stop, I have seen it", and it has to work in the state where
 * the app cannot be relied on to start -- the headless runtime that fired the
 * siren has usually been torn down by the time anybody reaches the phone.
 *
 * A BroadcastReceiver is what survives that. It is created fresh by the system
 * on the tap, in the app's process but with no Activity and no React context,
 * and everything it needs is static on `NigehbanAlarmModule` for exactly that
 * reason.
 *
 * Registered in this module's own AndroidManifest.xml. It is not exported: the
 * PendingIntent that reaches it is explicit and comes from this app, and there
 * is no other caller that should be able to silence an emergency.
 */
class NigehbanAlarmReceiver : BroadcastReceiver() {

  companion object {
    const val ACTION_DISMISS = "com.nigehban.alarm.DISMISS"
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_DISMISS) return
    // The application context, not the receiver's: this one dies the moment
    // onReceive returns, and restoring the alarm volume outlives it.
    NigehbanAlarmModule.dismiss(context.applicationContext)
  }
}
