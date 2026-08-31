package com.nigehban.bandwake

import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Puts the scan back after the two things that silently take it away.
 *
 * A PendingIntent scan survives the app being killed -- that is the whole point
 * of it -- but it does not survive either of these, and neither of them tells
 * anybody:
 *
 *   - **A reboot.** The registration lives in the Bluetooth stack, which starts
 *     empty. Without this the band stops being able to reach a rebooted phone
 *     until somebody happens to open the app, which on a safety device could be
 *     weeks.
 *
 *   - **Bluetooth being switched off and on.** Same reason, and far more common
 *     -- a flight, a battery saver, a tap in the quick settings by accident.
 *     `ACTION_STATE_CHANGED` fires with STATE_ON once the adapter is back, and
 *     re-registering any earlier would fail.
 *
 * `restartIfArmed` reads the standing instruction from storage rather than
 * guessing, so a phone whose owner pressed DISCONNECT is not quietly re-armed
 * by a reboot.
 *
 * `MY_PACKAGE_REPLACED` is here too: an app update restarts the process and
 * drops the registration exactly like a reboot does, and an update that
 * silently disarms the emergency path is the worst kind of regression -- it
 * ships looking fine.
 *
 * None of this helps after a **force stop** from Settings, which puts the app
 * in the stopped state where no broadcast reaches it until it is launched by
 * hand. That is Android working as intended and there is nothing on this side
 * to be done about it.
 */
class BandWakeBootReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext

    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED -> BandWake.restartIfArmed(app)

      BluetoothAdapter.ACTION_STATE_CHANGED -> {
        val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
        // Only on the way up. Re-registering while the adapter is turning off
        // or already off just records a failure and loses the reason.
        if (state == BluetoothAdapter.STATE_ON) BandWake.restartIfArmed(app)
      }
    }
  }
}
