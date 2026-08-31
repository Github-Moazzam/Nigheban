package com.nigehban.bandwake

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JavaScript face of the band-SOS wake. `src/bandWake.js` is the only caller.
 *
 * Thin on purpose. Everything that has to work with the app dead lives on
 * `BandWake` and in `BandWakeReceiver`, because this class only exists while
 * there is a React context -- which is exactly the condition the whole feature
 * is built to survive the absence of.
 *
 * What this adds on top is the live path. While JS is running there is no
 * reason to make the wearer look at a notification: `onBandSos` hands the press
 * straight to `App.js`, which raises it through the same `raise()` every other
 * SOS goes through. The notification is what happens when this module is not
 * loaded at all.
 */
class NigehbanBandWakeModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("NigehbanBandWake")

    Events("onBandSos")

    /**
     * Claim the live path for as long as this runtime exists.
     *
     * Registered on module create rather than when JS subscribes, because the
     * gap between the two is a real cold start and a press arriving inside it
     * would otherwise take the notification route while the app was in fact
     * coming up. `sendEvent` on a runtime that is tearing down throws rather
     * than silently dropping, and the receiver treats a throw as "no listener"
     * and shows the notification instead -- so losing this race costs a
     * notification, never the alert.
     */
    OnCreate {
      BandWake.liveListener = { payload -> sendEvent("onBandSos", payload) }
    }

    OnDestroy {
      BandWake.liveListener = null
    }

    /**
     * Arm the scan. Returns null on success or a human-readable reason.
     *
     * Idempotent: `startScan` with an equal PendingIntent replaces the previous
     * registration rather than stacking a second one, so App.js can call this
     * on every band-state change without counting.
     */
    AsyncFunction("start") {
      BandWake.start(requireContext())
    }

    AsyncFunction("stop") {
      BandWake.stop(requireContext())
      true
    }

    AsyncFunction("isArmed") {
      BandWake.isArmed(requireContext())
    }

    /**
     * The press that woke this launch, exactly once.
     *
     * Read-and-clear, like `consumeLaunchAlertId` in nigehban-alarm and for the
     * same reason: an id that stays readable is an emergency the app re-raises
     * on every launch for the rest of the week. The `stale` flag comes back
     * with it rather than being applied here, so the decision about how old is
     * too old stays in one place -- the JS that has to explain it to a person.
     */
    AsyncFunction("consumePendingSos") {
      val context = requireContext()
      // The notification comes down here rather than on a tap, because a tap is
      // not the only way this gets read: a full-screen intent launch, an
      // ordinary resume and the live path all arrive at the same place. Hanging
      // the dismissal off the press being *taken* is what makes it impossible
      // to add a fourth way in that leaves an uncancellable emergency banner on
      // somebody's phone.
      BandWakeReceiver.dismissNotification(context)
      BandWake.takePending(context)
    }

    AsyncFunction("diagnostics") {
      BandWake.diagnostics(requireContext())
    }
  }

  private fun requireContext(): Context =
    appContext.reactContext ?: throw IllegalStateException("NigehbanBandWake: no Android context")
}
