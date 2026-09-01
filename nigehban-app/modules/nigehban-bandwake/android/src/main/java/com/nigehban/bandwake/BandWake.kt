package com.nigehban.bandwake

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build

/**
 * THE SOS THAT ARRIVES WITH THE APP ALREADY DEAD.
 *
 * A GATT link is opened by the phone and only lives while some app is alive to
 * hold it. On most non-Samsung Android skins -- Vivo, Oppo, Xiaomi, Huawei,
 * Transsion -- swiping the app off the Recents screen runs `kill -9` on the
 * process, which no foreground service and no permission survives. We have a
 * logcat of exactly that: `com.vivo.upslide ... kill -9 9457`, and the band
 * dropping six milliseconds later because its GATT client died with us. From
 * that moment the wearer carries a band that looks linked, is not, and will
 * drop their SOS on the floor.
 *
 * Android 8.0 added the one mechanism that answers this:
 * `BluetoothLeScanner.startScan(filters, settings, PendingIntent)`. The scan is
 * owned by the **system**, not by us. The filter is pushed down into the
 * Bluetooth controller, and when a matching advertisement appears the OS starts
 * our process to deliver it. Like an AlarmManager alarm, it outlives `kill -9`.
 *
 * Three properties of it decide everything in this file:
 *
 *   1. **The filter is not an optimisation, it is the permit.** Since Android
 *      8.1 a background scan with no filter returns nothing at all while the
 *      screen is off -- which is precisely when this has to work. Filtering in
 *      the controller is what makes a screen-off background scan legal, and it
 *      is also why being armed costs no battery: the band only advertises the
 *      SOS pattern during an emergency, so in normal use nothing ever matches
 *      and the CPU is never woken.
 *
 *   2. **The PendingIntent must be mutable on Android 12+.** The Bluetooth
 *      stack delivers results by writing them into the intent as extras. With
 *      FLAG_IMMUTABLE it cannot, and the scan then delivers empty broadcasts
 *      forever -- registered, running, and useless. That is the failure that
 *      looks most like success.
 *
 *   3. **It does not survive a reboot, or Bluetooth being switched off and on
 *      again.** It survives the app dying, which is the case it exists for, but
 *      not those two. `BandWakeBootReceiver` re-arms on both.
 *
 * Everything here hangs off an object and takes a Context, rather than living
 * on the Expo module, because the callers that matter have neither a module
 * instance nor a React context: a BroadcastReceiver the system built a
 * millisecond ago, in a process that had been dead since yesterday.
 */
object BandWake {

  /**
   * THE SWITCH. `false` means this phone is never woken by the band.
   *
   * Turned off on purpose on 1 Sep 2026 -- nothing below is deleted, and
   * flipping this back to `true` (with `BAND_WAKE_ENABLED` in
   * `src/bandWake.js`, and the commented-out effects in App.js) restores the
   * feature exactly as it was. The reasoning is in docs/BAND_WAKE_DISABLED.md;
   * the short version is BUG-012 and BUG-013, which are Critical and which need
   * a band id in the advertisement -- new firmware in the field -- before the
   * wake can be trusted with more than one band in the room.
   *
   * This switch is separate from the JavaScript one, and both are needed. The
   * JS one stops the app *asking* to be woken. This one stops the *system*
   * delivering a wake that no JavaScript ever asked for: a registration left in
   * the Bluetooth stack by an earlier build, or one put back by
   * `BandWakeBootReceiver` after a reboot, an app update or a Bluetooth toggle.
   * Those paths run in a process with no React context and would not see the JS
   * switch at all.
   */
  const val FEATURE_ENABLED = false

  private const val DISABLED_REASON =
    "band beacon wake is switched off (see docs/BAND_WAKE_DISABLED.md)"

  // ---- the wire format, shared with nigehban_band_nrf52.ino ----------------
  //
  //     FF FF   'N' 'G'   flag   seq
  //
  // Company FFFF is the SIG identifier reserved for testing, which means it is
  // also what every unbadged beacon in a shopping centre uses. The two magic
  // bytes are what stop a stranger's tag being read as a family emergency, and
  // because the filter matches on them the controller rejects everyone else
  // without ever waking us.
  private const val COMPANY_ID = 0xFFFF
  private const val MAGIC_0 = 'N'.code.toByte()
  private const val MAGIC_1 = 'G'.code.toByte()
  private const val FLAG_SOS: Byte = 0x01

  /** Offsets within the manufacturer payload Android returns, company id stripped. */
  private const val OFFSET_FLAG = 2
  private const val OFFSET_SEQ = 3
  private const val PAYLOAD_LEN = 4

  private const val REQUEST_CODE = 0x4257 // "BW"

  // ---- what has to outlive the process ------------------------------------
  private const val PREFS = "nigehban.bandwake"
  private const val KEY_ARMED = "armed"
  private const val KEY_LAST_SEQ = "lastSeq"
  private const val KEY_PENDING_SEQ = "pendingSeq"
  private const val KEY_PENDING_AT = "pendingAt"
  private const val KEY_PENDING_ADDR = "pendingAddr"
  private const val KEY_PENDING_RSSI = "pendingRssi"
  private const val KEY_LAST_WAKE_AT = "lastWakeAt"
  private const val KEY_LAST_ERROR = "lastError"

  /**
   * How old a press may be and still be raised on the wearer's behalf.
   *
   * The pending press is read when the app next opens, and "next" can be days:
   * a phone that went flat, an app nobody launched. Silently paging a family
   * about Tuesday on Thursday teaches them to distrust the alarm, which costs
   * more than the one missed press. Past this it is kept for the diagnostics
   * screen and not acted on.
   */
  private const val PENDING_MAX_AGE_MS = 30L * 60L * 1000L // 30 minutes

  /**
   * Set by the Expo module while JavaScript is actually running.
   *
   * Non-null means the receiver can hand the press straight to JS, which raises
   * it through the ordinary `raise()` path -- offline queue, retries, GPS fix
   * and all -- and nothing needs to be shown. Null means the app is dead and
   * the notification is the only way through. Static, because the receiver and
   * the module are never the same object.
   */
  @Volatile
  var liveListener: ((Map<String, Any?>) -> Unit)? = null

  fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ---- registering the scan ------------------------------------------------

  /**
   * The intent the Bluetooth stack fills with results and broadcasts at us.
   *
   * FLAG_UPDATE_CURRENT so re-arming replaces rather than accumulates, and
   * FLAG_MUTABLE from Android 12 because the stack has to be able to write the
   * results in. See point 2 in the class comment for what happens without it.
   */
  private fun scanIntent(context: Context): PendingIntent {
    val intent = Intent(context.applicationContext, BandWakeReceiver::class.java)
      .setAction(BandWakeReceiver.ACTION_SCAN_RESULT)
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
    return PendingIntent.getBroadcast(context.applicationContext, REQUEST_CODE, intent, flags)
  }

  /**
   * Match only a band that is actually calling for help.
   *
   * The flag byte is inside the match rather than read afterwards, so an idle
   * band -- which is every band, nearly always -- never wakes this app at all.
   * The sequence byte is left outside the mask so it can count freely.
   */
  private fun filters(): List<ScanFilter> {
    val data = byteArrayOf(MAGIC_0, MAGIC_1, FLAG_SOS)
    val mask = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte())
    return listOf(
      ScanFilter.Builder()
        .setManufacturerData(COMPANY_ID, data, mask)
        .build()
    )
  }

  /**
   * LOW_POWER, deliberately, for a scan that stays registered for weeks.
   *
   * It duty-cycles the controller rather than the CPU, so being armed costs
   * close to nothing, and it still sees a band advertising at 20 ms within a
   * few seconds. LOW_LATENCY would save those seconds and would drain the
   * battery every hour of every day for the one minute a year it matters -- and
   * a flat phone is a worse emergency device than a slow one.
   */
  private fun settings(): ScanSettings {
    val b = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
      .setReportDelay(0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      b.setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
        .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
        .setNumOfMatches(ScanSettings.MATCH_NUM_ONE_ADVERTISEMENT)
    }
    return b.build()
  }

  private fun scanner(context: Context) =
    (context.applicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)
      ?.adapter
      ?.takeIf { it.isEnabled }
      ?.bluetoothLeScanner

  /**
   * Arm the scan. Returns null on success, or the reason it failed.
   *
   * `armed` is written before the attempt, not after it. It records the
   * standing instruction -- "this phone wants to be woken by that band" -- and
   * not the outcome, because it is what `BandWakeBootReceiver` consults after a
   * reboot or a Bluetooth toggle. A failure now with Bluetooth switched off has
   * to leave behind something that knows to try again when it comes back on.
   */
  @SuppressLint("MissingPermission")
  fun start(context: Context): String? {
    val app = context.applicationContext

    // Switched off. Take down anything an earlier build left registered rather
    // than merely declining to add to it: a phone updating from a build that
    // had this on is carrying both a live registration in the Bluetooth stack
    // and an `armed` flag that BandWakeBootReceiver would act on after the next
    // reboot. `stop` clears both, and this is the one call site that reliably
    // runs on such a phone.
    if (!FEATURE_ENABLED) {
      stop(app)
      return recordError(app, DISABLED_REASON)
    }

    prefs(app).edit().putBoolean(KEY_ARMED, true).apply()

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return recordError(app, "PendingIntent scans need Android 8.0")
    }
    val scanner = scanner(app) ?: return recordError(app, "Bluetooth is off")

    return try {
      val code = scanner.startScan(filters(), settings(), scanIntent(app))
      if (code == 0) {
        recordError(app, null)
        null
      } else {
        recordError(app, "startScan returned $code")
      }
    } catch (e: SecurityException) {
      // BLUETOOTH_SCAN on 12+, ACCESS_FINE_LOCATION below it. The app asks for
      // both, so this is a permission revoked from Settings afterwards.
      recordError(app, "scan permission missing: " + (e.message ?: "SecurityException"))
    } catch (e: Exception) {
      recordError(app, e.message ?: e.toString())
    }
  }

  /** Withdraw the standing instruction and take the scan down. */
  @SuppressLint("MissingPermission")
  fun stop(context: Context) {
    val app = context.applicationContext
    prefs(app).edit().putBoolean(KEY_ARMED, false).apply()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      scanner(app)?.stopScan(scanIntent(app))
    } catch (e: Exception) {
      // Bluetooth off, or it was never registered. Either way no scan is
      // running now, which is what was asked for.
    }
  }

  fun isArmed(context: Context): Boolean = prefs(context).getBoolean(KEY_ARMED, false)

  /**
   * Re-arm after a reboot or a Bluetooth toggle, but only if it was armed.
   *
   * While the feature is off this does the opposite: a standing instruction
   * left behind by an earlier build is withdrawn instead of acted on. Without
   * this the switch would be defeated by the first reboot -- the boot receiver
   * runs in a process with no JavaScript in it, so the JS switch cannot be
   * consulted, and `armed` is still `true` in storage from before the update.
   */
  fun restartIfArmed(context: Context) {
    if (!FEATURE_ENABLED) {
      if (isArmed(context)) stop(context)
      return
    }
    if (isArmed(context)) start(context)
  }

  private fun recordError(context: Context, message: String?): String? {
    prefs(context).edit().putString(KEY_LAST_ERROR, message).apply()
    return message
  }

  // ---- a press coming in ---------------------------------------------------

  /**
   * The SOS sequence number in this scan result, or null if it is not one.
   *
   * The company id is read here rather than in the receiver so that it, the
   * filter above and the firmware all take it from one line. A second copy of
   * it somewhere else is how the filter and the parser drift apart, and the
   * failure that produces is silent: the scan matches, the parse returns
   * nothing, and the emergency is dropped without a word.
   */
  fun sosSeq(result: ScanResult): Int? =
    sosSeq(result.scanRecord?.getManufacturerSpecificData(COMPANY_ID))

  /** Record why the scan itself failed, for the diagnostics screen. */
  fun recordScanError(context: Context, message: String?) {
    recordError(context, message)
  }

  /**
   * The SOS sequence number in this payload, or null if it is not one.
   *
   * The controller already matched the magic and the flag, so re-checking them
   * is redundant -- except that a scan record is attacker-supplied bytes off
   * the air, and the cost of being sure is four comparisons.
   */
  fun sosSeq(payload: ByteArray?): Int? {
    if (payload == null || payload.size < PAYLOAD_LEN) return null
    if (payload[0] != MAGIC_0 || payload[1] != MAGIC_1) return null
    if (payload[OFFSET_FLAG] != FLAG_SOS) return null
    return payload[OFFSET_SEQ].toInt() and 0xFF
  }

  /**
   * Have we already acted on this press?
   *
   * The band holds the flag up for ten minutes so a phone that was rebooting or
   * out of range still gets its chance, which means the same press arrives over
   * and over. The sequence byte separates "still the same emergency" from "they
   * pressed it again", and it is remembered in storage rather than in memory
   * because the process this ran in will not be the one that runs next.
   */
  fun isDuplicate(context: Context, seq: Int): Boolean =
    prefs(context).getInt(KEY_LAST_SEQ, -1) == seq

  fun remember(context: Context, seq: Int, address: String?, rssi: Int) {
    val now = System.currentTimeMillis()
    prefs(context).edit()
      .putInt(KEY_LAST_SEQ, seq)
      .putInt(KEY_PENDING_SEQ, seq)
      .putLong(KEY_PENDING_AT, now)
      .putString(KEY_PENDING_ADDR, address)
      .putInt(KEY_PENDING_RSSI, rssi)
      .putLong(KEY_LAST_WAKE_AT, now)
      .apply()
  }

  fun pendingPayload(context: Context): Map<String, Any?>? {
    val p = prefs(context)
    val seq = p.getInt(KEY_PENDING_SEQ, -1)
    if (seq < 0) return null
    val at = p.getLong(KEY_PENDING_AT, 0L)
    val age = System.currentTimeMillis() - at
    return mapOf(
      "seq" to seq,
      "at" to at,
      "address" to p.getString(KEY_PENDING_ADDR, null),
      "rssi" to p.getInt(KEY_PENDING_RSSI, 0),
      "ageMs" to age,
      "stale" to (age > PENDING_MAX_AGE_MS)
    )
  }

  /** Read once and cleared, so one press can never be raised twice. */
  fun takePending(context: Context): Map<String, Any?>? {
    val out = pendingPayload(context) ?: return null
    clearPending(context)
    return out
  }

  fun clearPending(context: Context) {
    prefs(context).edit()
      .remove(KEY_PENDING_SEQ)
      .remove(KEY_PENDING_AT)
      .remove(KEY_PENDING_ADDR)
      .remove(KEY_PENDING_RSSI)
      .apply()
  }

  /** Everything the Setup screen needs to answer "is this actually working". */
  fun diagnostics(context: Context): Map<String, Any?> {
    val p = prefs(context)
    return mapOf(
      "supported" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O),
      "armed" to p.getBoolean(KEY_ARMED, false),
      "bluetoothOn" to (scanner(context) != null),
      "lastWakeAt" to p.getLong(KEY_LAST_WAKE_AT, 0L),
      "lastSeq" to p.getInt(KEY_LAST_SEQ, -1),
      "lastError" to p.getString(KEY_LAST_ERROR, null),
      "pending" to pendingPayload(context)
    )
  }
}
