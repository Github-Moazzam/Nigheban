/* ============================================================================
   NIGEHBAN BAND — XIAO nRF52840 SENSE FIRMWARE
   ----------------------------------------------------------------------------
   The band. This is the only firmware in the tree -- the ESP32 prototype it was
   ported from was retired on 27 Aug 2026. It speaks the EXACT protocol that
   prototype spoke, and the one `virtualBand.js` speaks on the phone, so the app
   cannot tell which of them answered. That is the whole point of this file:
   EXECUTION_PLAN.md section 5 is frozen.

   Transport : BLE, Nordic UART Service — newline-delimited JSON, via BLEUart
   Board     : Seeed XIAO nRF52840 **Sense**  (Seeeduino:nrf52:xiaonRF52840Sense)
   Core      : Seeed nRF52 Boards 1.1.13 (Adafruit Bluefruit) — NOT the mbed one
   Library   : Seeed Arduino LSM6DS3 (only needed once HAS_IMU flips to 1)

   Wiring — proven on the bench by T2/T3, see firmware/README.md:
     BTN    -> D2  -> other leg to GND    (INPUT_PULLUP, no resistor)
     MOTOR  -> D1  -> driver module IN    (100 uF bulk cap across motor supply)
     LED    -> onboard, pin 11, ACTIVE LOW

   ------------------------------------------------------------------------
   WHAT CAME OVER VERBATIM (F2.1)

   `Pattern` / `feedback()` / `feedbackTick()`, `Button` / `buttonTick()`,
   `onGesture()`, `jsonStr()` / `jsonInt()` / `handleCommand()` came over
   unchanged from the ESP32 prototype. They were already correct and already
   agreed with the app; re-deriving them would only introduce drift.
   The prototype is gone from the tree; `git show 70c5176:nigehban_band_esp32/
   nigehban_band_esp32.ino` is the record if the provenance is ever in question.

   WHAT CHANGED, AND WHY

     BLE layer      BLEDevice/BLEServer/BLE2902 -> BLEUart. Bluefruit ships NUS
                    as one object, so the three-characteristic dance is gone.
     Button B       Deleted. The shipped band has one button, and the gesture
                    map already put everything on button 1 -- so this removes
                    a line, not a feature.
     IMU            MPU6050 path deleted (F2.2). The Sense has an LSM6DS3TR-C
                    on board at 0x6A; external-IMU code is work spent on
                    hardware we do not have.
     Battery        SIM_BATTERY replaced with the real divider (F2.3).
     LED polarity   Active LOW on this board. See ledWrite().

   ------------------------------------------------------------------------
   OPEN — THE HAPTIC TIMINGS BELOW ARE CORRECT AND CURRENTLY IMPERCEPTIBLE

   Every feedback() pulse width here (60-250 ms) is the RIGHT value for a
   healthy coin ERM, which reaches speed in 50-80 ms. On the current motor
   module ~300 ms is the floor, so as of today most of these cannot be felt.

   DO NOT "fix" this by raising the numbers. At a 300 ms floor a 1-pulse ack and
   a 4-pulse SOS both degrade into "a long buzz happened", and SOS confirmation
   slips from 0.7 s to 1.8 s -- in the one moment the wearer cannot wait and
   cannot look. The driver is what is broken. firmware/README.md carries the
   diagnosis and the 20-second test that settles it.

   These numbers become correct the moment the driver is fixed. Leave them.
   ========================================================================= */

#include <Adafruit_TinyUSB.h>   // USB CDC. Without it `Serial` fails to LINK.
#include <bluefruit.h>
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>   // the band's own name and PIN, across reboots

// ---------------------------------------------------------------- CONFIG ---
// The FACTORY name and PIN. Neither is the band's identity any more -- both are
// overwritten by whatever is in /nigehban.cfg on the internal flash, which the
// app writes with {"c":"setname"} and {"c":"setpin"}. These are what a band
// comes up with before anybody has set anything, and what a factory reset
// (hold the button through boot) puts back.
#define DEVICE_NAME     "Nigehban-02"

// Six digits, not four, and not negotiable: BLE_GAP_PASSKEY_LEN is 6, and this
// same string is handed to the SoftDevice as the pairing passkey. The app's
// disarm PIN is four digits and is a DIFFERENT secret for a different job --
// see docs/BAND_PIN_AND_NAME.md.
//
// CHANGE THIS BEFORE FLASHING A BAND YOU CARE ABOUT, or change it from the app
// on first link. A published default is a default everybody knows.
#define DEFAULT_PAIR_PIN "123456"

// The PIN this repository ships with, frozen as a literal.
//
// It is NOT the same question as DEFAULT_PAIR_PIN, and conflating the two is a
// bug worth naming. The app nags when the band reports `defpin`, and the thing
// worth nagging about is "these six digits are printed in a public repository",
// not "these six digits came from a #define". Somebody who edits the line above
// to their own secret before flashing has done exactly the right thing, and
// comparing against DEFAULT_PAIR_PIN would reward them with a permanent amber
// banner telling them to do the thing they already did.
//
// So this stays "123456" forever. Only a band actually running the published
// value gets nagged.
#define PUBLISHED_PIN    "123456"

// 20 characters of name. The scan response is 31 bytes, a name costs its own
// length plus 2, and leaving headroom there is cheaper than debugging a band
// that advertises but cannot be found.
#define NAME_MAX_LEN    20
#define CFG_FILE        "/nigehban.cfg"

// ------------------------------------------------------------ THE GATE ---
//
// Two locks, because they fail in different directions and this band is worth
// locking twice.
//
//   BLE pairing (passkey)   The SoftDevice will not let anybody subscribe to a
//                           notification or write a command until the link is
//                           encrypted with MITM protection, and getting there
//                           means typing six digits into Android's own pairing
//                           dialog. This is real cryptography and it protects
//                           everything on the wire.
//
//   The auth handshake      Encryption proves the phone paired ONCE. It does
//                           not prove the phone should still be here: a bond
//                           outlives an uninstall, a resale, a stolen handset.
//                           So the band also stays mute until the app sends
//                           {"c":"auth","pin":"..."} over that encrypted link,
//                           and changing the PIN then locks out every phone
//                           still holding a bond, without anybody having to go
//                           near Android's Bluetooth settings.
//
// Until a connection clears BOTH, the band sends no events, obeys no commands,
// keeps its SOS beacon flying, and does not tell the wearer it is linked.
// Two windows, because two very different things are being waited on.
//
// LINK_SETTLE_MS covers pairing: a person reading six digits off a screen and
// typing them into Android's dialog, which is slow and must not be rushed. It
// is here so an idle unauthenticated connection cannot sit on the band's only
// connection slot forever, keeping it off the air and unreachable by the phone
// that actually owns it.
//
// AUTH_WINDOW_MS starts later and is much tighter: it begins when the phone
// subscribes to notifications, by which point pairing is already done and the
// handshake is one automatic round trip. Whichever deadline is sooner wins.
#define LINK_SETTLE_MS  60000   // connect -> authenticated, generous
#define AUTH_WINDOW_MS  8000    // subscribed -> authenticated, strict
#define AUTH_MAX_TRIES  3       // wrong PIN this many times and the link goes

// ---- and the limit that actually costs an attacker something --------------
//
// AUTH_MAX_TRIES above only ends a CONNECTION. On its own it is close to
// worthless: reconnecting is free and unlimited, so three guesses per link is
// really unlimited guesses, and a six-digit PIN falls to a patient script.
//
// So failures are also counted ACROSS connections, and past a threshold the
// band stops answering at all for a while. The delay doubles-ish each time and
// caps, which turns 10^6 guesses from an afternoon into geological time while
// costing an owner who fat-fingers their PIN twice absolutely nothing.
//
// Five free attempts before any of it starts. That is deliberately generous:
// the person most likely to get this wrong is the owner, typing from memory,
// and the first thing a lockout must not do is punish them.
//
// DELIBERATELY NOT PERSISTED. The counter lives in RAM, so a power cycle
// clears it -- and that is not the hole it looks like. Power-cycling this band
// means holding it, and anybody holding it can hold the button through boot and
// factory-reset the PIN outright. A flash write per wrong guess would buy
// nothing against an attacker who already has the better option, and would
// spend the flash's erase budget on it.
//
// SAFETY NOTE, because this is a safety device: while locked out the band
// cannot link to a phone, so a press cannot reach the family over BLE. That is
// the price of having a lock at all, and it is bounded three ways -- five free
// tries, a fifteen-minute ceiling, and the button-through-boot reset, which
// works during a lockout like any other time.
#define AUTH_LOCKOUT_AT 5       // consecutive failures before any lockout
static const uint32_t AUTH_LOCKOUT_MS[] = { 30000, 120000, 300000, 900000 };

// Hold the button while the band boots, and keep holding for this long: name,
// PIN and every bond go back to factory. It is the way out of a forgotten PIN,
// and the only one -- which is why it takes physical possession of the band and
// cannot be done over the air.
#define FACTORY_RESET_HOLD_MS 5000

#define PIN_BTN         D2
#define PIN_MOTOR       D1

// The link LED: a SECOND, externally visible LED, not the onboard one.
//
// LED_BUILTIN sits on the module, inside the enclosure, where nobody can see
// it -- and it is driven by feedbackTick() as a visual echo of the motor, so it
// cannot show standing state anyway. This one answers a question no buzz can:
// "is my band linked RIGHT NOW", askable at any moment, without an event having
// to happen. See docs/BAND_FEEDBACK_SPEC.md phase 2.
//
// HARDWARE: needs an LED and a series resistor fitted to this pin. Until one is,
// everything below is a harmless toggle of an unconnected pin.
#define PIN_LINK_LED    D3
#define LINK_LED_ACTIVE_HIGH  1     // 0 if the LED is wired to sink through the pin
// LED_BUILTIN is 11 and ACTIVE LOW on this board -- always go through
// ledWrite(), never digitalWrite(), or every indicator reads inverted.

#define HAS_IMU         1       // F3 — needs the "Seeed Arduino LSM6DS3" library

// Gesture timing (ms) — must stay identical to DEFAULT_GESTURES in the app's
// virtualBand.js. Changing one without the other silently breaks the demo.
#define DEBOUNCE_MS     35
// How long a lone tap waits to see whether a second one is coming. This is NOT
// a cosmetic timeout -- see "THE SLOW-TAP FAILURE" below. It only ever delays
// checkin_ack; SOS fires on the second tap itself and is unaffected.
#define TAP_WINDOW_MS   1200
#define HOLD_1_MS       3000    // "hold 3s"  -> High Alert toggle
#define HOLD_2_MS       5000    // "hold 5s"  -> unbound; v2 anti-snatch

#define HEARTBEAT_MS    10000

// ------------------------------------------------- PRESS & OUTCOME FEEDBACK ---
//
// Two facts, told separately, by whichever side actually knows them. The whole
// reasoning is in docs/BAND_FEEDBACK_SPEC.md; the short version:
//
//   "I heard you"   -- the band knows this instantly. One TICK per press, so
//                      two taps are felt as two ticks and the wearer can tell
//                      "not registered" (press again) from "registered and
//                      failed" (stop pressing, find your phone). Those need
//                      opposite responses and used to feel identical.
//
//   "It went / it didn't" -- the band CANNOT know this. A successful UART write
//                      means the phone received the press, not that the family
//                      was paged; with the app's offline queue an SOS can sit
//                      unsent for minutes. So the band asks and waits, and the
//                      phone answers with {c:'ack'}, {c:'queued'} or
//                      {c:'failed'}.
//
// The one case the band CAN answer alone is having no link at all: nothing can
// have received it, so FAILED goes out immediately with no waiting.
//
// 90 ms is the floor everywhere here. It is the shortest width confirmed felt on
// this hardware, and it is what the check-in ack already used.
// ---- the check-in nag ------------------------------------------------------
//
// A check-in used to buzz ONCE at the top of its window and then say nothing
// until the window expired -- at which point it buzzed again, but that second
// buzz was not a reminder, it was the news that the family had already been
// told the wearer did not answer.
//
// One buzz is trivially missed: asleep, in the shower, band under a sleeve, in
// a noisy street. And the cost of missing it is not a missed notification, it
// is a false alarm sent to everybody who cares about this person. So the
// question is now asked repeatedly until it is answered or the window closes.
//
// The nag is the check-in pattern with one pulse taken off, not a new pattern.
// It is the SAME question being asked again, and 400 ms pulses are used by
// nothing else, so it cannot be mistaken for anything -- and the vocabulary
// does not grow.
//
// It tightens near the deadline. That is the only way a wrist can say "you are
// running out of time" to somebody who is not looking at a screen.
//
// Costs roughly 0.02 mAh per nag. In High Alert -- the one mode that asks
// unprompted, every 5-10 minutes -- budget a few percent of the cell per day.
// That is the price of the mode, and it is cheaper than a false escalation.
#define CHECKIN_NAG_MS        12000   // ordinary reminder interval
#define CHECKIN_NAG_URGENT_MS  5000   // once the deadline is close
#define CHECKIN_URGENT_AT_MS  20000   // "close" = this much of the window left

#define FB_TICK_MS        90      // "I counted that press"
#define OUTCOME_WAIT_MS   4000    // no answer by now: assume it did not go
#define OUTCOME_DEFER_MS  260     // let a tick finish before an outcome plays

// ---- what an outcome feels like, by what was being confirmed ---------------
//
// An SOS getting through and an "I'm fine" getting through are not the same
// news and must not feel the same. The SOS one is a single firm buzz, longer
// than anything the check-in path produces, because it is the one confirmation
// a frightened person is waiting for and it has to be unmistakable without
// counting anything.
//
// FAILED is two long heavy buzzes rather than one. A single buzz now means
// "sent", so failure cannot also be a single buzz -- distinguishing 400 ms from
// 900 ms on a wrist under stress is not a distinction anybody should have to
// make, and it is the most dangerous pair in the whole vocabulary to confuse.
// Repetition is the safer signal: one buzz is a full stop, two heavy ones are
// insistent, and insistent is what "this did not go" should feel like.
#define FB_SOS_OK_MS      400     // SOS delivered: one firm buzz
#define FB_FAIL_MS        700     // failed: two of these
#define FB_FAIL_GAP_MS    300

// The LED's two standing states. Flashes, never steady: a 2 mA LED held on
// against a 250-400 mAh cell is 5-8 days on its own, against a 1-2 week budget.
// 20 ms every 3-5 s is a ~0.5% duty cycle and costs essentially nothing.
#define LINK_LED_FLASH_MS       20
#define LINK_LED_PERIOD_UP_MS   5000    // linked: one brief flash, unobtrusive
#define LINK_LED_PERIOD_DOWN_MS 2000    // not linked: a double flash, more often
#define LINK_LED_GAP_MS         180     // spacing of the double flash

// ------------------------------------------------------- THE SOS BEACON ---
//
// The way an SOS gets out when there is no link to get it out on.
//
// A GATT connection is opened by the phone, never by the band, and it only
// exists while the phone's app is alive to hold it. On most non-Samsung
// Android skins -- Vivo, Oppo, Xiaomi, Huawei, Transsion -- swiping the app off
// the Recents screen runs `kill -9` on it, which no foreground service and no
// permission can survive. The wearer walks out with a band that looks linked,
// is not, and will drop their SOS on the floor.
//
// So the press also goes out in the advertisement itself, where no connection
// is required. Android 8+ lets an app hand the OS a scan filter plus a
// PendingIntent; the Bluetooth chip watches for the pattern and the *system*
// starts the app when it appears -- with the app killed, hours later. That is
// what these bytes are for. `modules/nigehban-bandwake` is the other half.
//
// Layout, 6 bytes inside the manufacturer-specific field:
//
//     FF FF   'N' 'G'   flag   seq
//     \___/   \_____/   \__/   \_/
//       |        |       |      +-- press counter, wraps; the phone dedups on it
//       |        |       +--------- 0 idle, 1 SOS standing
//       |        +----------------- our magic, because company FFFF is the
//       |                           testing id and half the world uses it
//       +-------------------------- company id, little-endian, SIG "testing"
//
// The phone filters on `FF FF 'N' 'G' 01` with a full mask, so an idle band
// never wakes it and the sequence byte is free to change. Filtering in the
// chip rather than in software is also what makes this legal at all: since
// Android 8.1 a background scan with no filter returns nothing while the
// screen is off, which is exactly when this has to work.
#define SOS_BEACON_COMPANY_LO  0xFF
#define SOS_BEACON_COMPANY_HI  0xFF
#define SOS_BEACON_MAGIC_0     'N'
#define SOS_BEACON_MAGIC_1     'G'
// How long the flag stays up. Long enough that a phone which was rebooting,
// out of range or in Doze still gets its chance; short enough that a band left
// unpaired in a drawer is not still crying SOS tomorrow.
#define SOS_BEACON_MS          600000UL   // 10 minutes

// ------------------------------------------------- FALL AND IMPACT (F3) ---
//
// TWO DETECTORS, AND ONLY ONE OF THEM DECIDES ANYTHING.
//
// A fall has a shape the band can recognise on its own: the wrist goes light
// (free-fall), then it is hit, then it stops moving. All three parts are
// visible from the accelerometer alone, so the band is entitled to call it and
// say `fall`.
//
// A crash does not have that shape. There is no free-fall -- a rider hits a car
// at 40 km/h with 1 g of gravity on the wrist the whole way -- and what is left
// is a spike, which on a WRIST is also a clap, a door slammed, a hand put down
// hard on a table, a cricket bat. The band cannot tell those apart and must not
// pretend to. So it reports the measurement and nothing more: `impact`, with
// the peak, the rotation and whether the arm went still afterwards.
//
// What turns that into an accident is the ONE fact the band does not have and
// the phone does: how fast this person was travelling ten seconds ago. An 11 g
// spike at walking pace is furniture. The same spike at 45 km/h is a crash.
// src/motion.js owns that judgement; see docs/FALL_AND_ACCIDENT.md.
//
// This split is the same one the press feedback already uses: each side says
// only what it actually knows.

// 100 Hz. Free-fall from standing lasts 300-500 ms and the minimum below is
// 70 ms, so this samples the shortest thing we care about seven times.
//
// It is NOT enough to catch a true impact peak: the spike itself is 5-15 ms
// wide, so `peak_g` here is a LOWER BOUND on what the wrist actually felt.
// That is fine for a threshold and wrong for a physics claim -- if a reading
// ever has to be exact, it needs the LSM6DS3's own FIFO at 416 Hz, not a
// faster loop(). Every threshold below is calibrated at THIS rate; changing it
// changes what they mean.
#define IMU_PERIOD_MS         10

// ---- a fall, by either of two routes ---------------------------------------
//
// PEOPLE DO NOT FREE-FALL. THIS IS THE MOST IMPORTANT COMMENT IN THIS FILE.
//
// The three-stage machine below -- light, then hit, then still -- is the
// textbook fall detector, and taken alone it misses the falls this product
// exists for. A person does not drop; they TOPPLE. Rotating about the feet or
// the hips takes 0.7-1.2 s, and the wrist stays attached to a body the whole
// way, so it frequently never reads below 0.45 g for 70 ms at all.
//
// The falls that do produce clean free-fall are faints. Trips, slips, a leg
// giving way, and the slow slump an elderly person actually has produce little
// or none -- and those are the majority. Making free-fall a mandatory gate
// therefore fails silently on the common case, which is the wrong direction to
// be wrong in for a safety device.
//
// So free-fall is EVIDENCE, not a requirement. It is one of two routes in:
//
//   ROUTE A -- "it dropped".  free-fall -> impact -> still.
//              The impact bar is low (2.40 g) because the free-fall already
//              corroborated that something fell. This is the classic path and
//              it catches faints and falls from a height.
//
//   ROUTE B -- "it was hit".  a HARDER impact -> the wearer ended up at a
//              different angle -> still, for longer.
//              No free-fall required. This is the topple, and it is carried by
//              the two things a topple genuinely does produce: a solid landing,
//              and a body that is now oriented differently from how it was.
//
// Route B needs its own evidence because "a spike then stillness" on its own is
// also a hand put down hard on a desk. The orientation change is what separates
// them: clapping, slamming a door and setting a hand down all leave the wearer
// in the same posture they started in, and going to the floor does not.
#define FALL_FREEFALL_G       0.45f   // below this, something is falling
#define FALL_FREEFALL_MIN_MS  70      // ...for this long: rejects a flick
#define FALL_IMPACT_G         2.40f   // ROUTE A: a spike above this
#define FALL_IMPACT_WINDOW_MS 1400    // ...this soon after the free-fall ends
#define FALL_STILL_BAND_G     0.28f   // then |g - 1| inside this
#define FALL_STILL_MS         1600    // ...held: they did not get straight up

// ---- route B: the topple ---------------------------------------------------
//
// 4 g, not 2.4: with no free-fall behind it the impact is carrying more of the
// argument, and 2.4 g is cleared by walking briskly downstairs.
#define FALL_HARD_G           4.00f
// How far the wrist's resting angle must have moved between just before the
// impact and after everything settled. 35 degrees is well beyond the drift of
// an arm at rest and well inside the change from upright to on the floor.
#define FALL_TILT_DEG         35.0f
// Longer than route A's 1.6 s, because there is no free-fall corroborating this
// one and a person who trips, lands on their hands and gets up must have time
// to do so before anything is raised.
#define FALL_STILL_SLOW_MS    2500

// ---- an impact: a spike big enough to be worth telling the phone about -----
//
// 8 g is chosen against the false positive, not the true positive. A wrist
// clears 2-3 g walking downstairs and 10-16 g clapping, so anything lower is a
// stream of noise; a vehicle impact is 20 g and up and saturates the sensor
// long before it gets here. Tune this from a real CSV capture before trusting
// it -- docs/FALL_AND_ACCIDENT.md has the bench protocol.
#define IMPACT_G              8.00f
#define IMPACT_SETTLE_MS      1200    // watch this long to see if the arm stops

// One event per episode. A crash is not one spike -- it is a spike, a tumble,
// a landing, and a bike coming down on top of it, over several seconds. Each
// of those clears the threshold, and without this the phone would get six
// `impact` lines for one accident and the wearer six buzzes.
#define FALL_REFRACTORY_MS    15000
#define IMPACT_REFRACTORY_MS  10000

// Forward declaration, and it has to be THIS high up now.
//
// The Arduino IDE injects its auto-generated prototypes just above the first
// thing ctags calls a function -- which, since SecureUart::begin() appeared
// below, may be the class rather than ledWrite(). buttonTick()'s generated
// prototype takes a `Button&`, so if the injection point moves above the
// declaration the sketch stops compiling for a reason that has nothing to do
// with anything anybody edited. Declaring it before the class as well costs one
// line and makes the injection point stop mattering. The second declaration
// further down is kept deliberately; a repeat is legal and it is where somebody
// reading the button engine will look for it.
struct Button;

// -------------------------------------------------- THE ENCRYPTED UART ---
//
// Stock BLEUart leaves both characteristics wide open -- its own source carries
// the note "TODO enable encryption when bonding is enabled" -- so anybody in
// range can subscribe to this band's notifications and write it commands. That
// is the hole this subclass closes.
//
// It has to be a subclass rather than two setPermission() calls after
// bleuart.begin(), because permissions are read by the SoftDevice at the moment
// a characteristic is ADDED to the attribute table. Setting them afterwards
// changes a struct nobody looks at again. So the body below is BLEUart::begin()
// with two lines changed, and it has to be kept in step if the core is upgraded.
//
// The two permissions are not symmetrical, and neither is a typo:
//
//   _txd is notify-only, so its own value is never read -- but the library
//   copies read_perm onto the CCCD's WRITE permission (BLECharacteristic.cpp,
//   `cccd_md.write_perm = _attr_meta.read_perm`). The CCCD is what a phone
//   writes to subscribe, so read_perm here is what forces pairing at exactly
//   the moment the app asks for notifications.
//
//   _rxd is write-only, and write_perm means what it says.
class SecureUart : public BLEUart {
public:
  SecureUart(uint16_t depth = BLE_UART_DEFAULT_FIFO_DEPTH) : BLEUart(depth) {}

  virtual err_t begin(void) {
    _rx_fifo = new Adafruit_FIFO(1);
    _rx_fifo->begin(_rx_fifo_depth);

    VERIFY_STATUS( BLEService::begin() );

    uint16_t max_mtu = Bluefruit.getMaxMtu(BLE_GAP_ROLE_PERIPH);

    _txd.setProperties(CHR_PROPS_NOTIFY);
    _txd.setPermission(SECMODE_ENC_WITH_MITM, SECMODE_NO_ACCESS);  // -> the CCCD
    _txd.setMaxLen( max_mtu );
    _txd.setUserDescriptor("TXD");
    VERIFY_STATUS( _txd.begin() );

    _rxd.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
    _rxd.setWriteCallback(BLEUart::bleuart_rxd_cb, true);
    _rxd.setPermission(SECMODE_NO_ACCESS, SECMODE_ENC_WITH_MITM);
    _rxd.setMaxLen( max_mtu );
    _rxd.setUserDescriptor("RXD");
    VERIFY_STATUS( _rxd.begin() );

    return ERROR_NONE;
  }
};

// ------------------------------------------------------------------ STATE ---
SecureUart bleuart;             // this IS the Nordic UART Service

bool     gConnected    = false;
bool     gWasConnected = false;

// ---- who this band is, and who may talk to it ----------------------------
// Both are loaded from /nigehban.cfg at boot and both are changeable from the
// app. gName is what goes out in the scan response; gPin is both the pairing
// passkey and the answer to {"c":"auth"}.
char     gName[NAME_MAX_LEN + 1] = DEVICE_NAME;
char     gPin[7]                 = DEFAULT_PAIR_PIN;

// Per connection, and deliberately not persisted: proving yourself once is not
// proving yourself forever, and a band that stayed authenticated across a
// reconnect would be authenticated to whoever connected next.
bool     gAuthed       = false;
bool     gWasAuthed    = false;   // was the link that just died ever a real one
uint8_t  gAuthTries    = 0;
uint32_t gAuthDeadline = 0;       // 0 = nothing being waited on

// The across-connections half of the limit. These two deliberately survive a
// disconnect -- that is the entire point, see AUTH_LOCKOUT_AT -- and are
// cleared only by a correct PIN or by power.
uint8_t  gAuthFails    = 0;       // consecutive, since the last success
uint32_t gLockedUntil  = 0;       // millis(); 0 = not locked out

// Has setup() finished putting the radio on the air. Only applyName() reads it;
// see the comment there for what goes wrong without it.
bool     gAdvStarted   = false;

bool     gSosBeacon    = false;   // is the advertisement crying SOS right now
uint8_t  gSosSeq       = 0;       // bumped per press, so repeats are not deduped
uint32_t gSosBeaconAt  = 0;       // when it went up, for SOS_BEACON_MS

uint8_t  gBattery      = 100;
bool     gBatteryForced= false;   // `bat` command pins it for demos
bool     gArmed        = false;   // anti-snatch, v2 -- no gesture sets it yet
bool     gHighAlert    = false;   // High Alert (exec plan section 5, hold 3 s)
bool     gAwaitingAck  = false;   // a check-in request is outstanding
uint32_t gAckDeadline  = 0;
uint32_t gNextNagAt    = 0;       // 0 = not nagging; see CHECKIN_NAG_MS
uint32_t gLastHeartbeat= 0;
uint32_t gSeq          = 0;
String   gRxLine;                 // accumulates until '\n'

// Forward declaration. The Arduino IDE injects auto-generated prototypes just
// above the first function definition, which is ABOVE the real struct below --
// so the name has to exist by here or buttonTick()'s prototype will not compile.
struct Button;

void ledWrite(bool on) { digitalWrite(LED_BUILTIN, on ? LOW : HIGH); }

// ------------------------------------------------- NAME AND PIN, ON FLASH ---
//
// Two lines of text in LittleFS on the nRF52840's own internal flash:
//
//     Ayesha's band\n
//     481923\n
//
// A text file rather than a packed struct: the whole thing is under 30 bytes,
// it wants to be readable from a serial dump when a band is misbehaving, and a
// struct would need a version field the first time a third setting appears.
//
// The flash region InternalFS uses survives a sketch upload, so a band keeps its
// name and PIN across a re-flash. It does not survive InternalFS.begin() finding
// a corrupt filesystem, which formats -- and that is the right trade, because a
// band that comes back with the factory PIN can be recovered and a band that
// will not boot cannot.

/** Safe to put inside our hand-rolled JSON, and to advertise? */
bool nameLegal(const String &n) {
  if (n.length() == 0 || n.length() > NAME_MAX_LEN) return false;
  for (uint16_t i = 0; i < n.length(); i++) {
    char c = n[i];
    // Printable ASCII only, minus the two characters jsonStr() cannot survive.
    // That parser finds a value by scanning to the next quote, so a name with
    // one in it would truncate every line this band ever sends.
    if (c < 0x20 || c > 0x7E || c == '"' || c == '\\') return false;
  }
  return true;
}

bool pinLegal(const String &p) {
  if (p.length() != 6) return false;
  for (uint16_t i = 0; i < 6; i++) if (p[i] < '0' || p[i] > '9') return false;
  return true;
}

bool usingDefaultPin() { return strcmp(gPin, PUBLISHED_PIN) == 0; }

void configSave() {
  InternalFS.remove(CFG_FILE);            // LittleFS appends to an open file
  Adafruit_LittleFS_Namespace::File f(InternalFS);
  if (!f.open(CFG_FILE, Adafruit_LittleFS_Namespace::FILE_O_WRITE)) {
    Serial.println("{\"t\":\"log\",\"msg\":\"cfg write failed\"}");
    return;
  }
  f.write((const uint8_t *) gName, strlen(gName)); f.write((const uint8_t *) "\n", 1);
  f.write((const uint8_t *) gPin,  strlen(gPin));  f.write((const uint8_t *) "\n", 1);
  f.close();
}

void configLoad() {
  Adafruit_LittleFS_Namespace::File f(InternalFS);
  if (!f.open(CFG_FILE, Adafruit_LittleFS_Namespace::FILE_O_READ)) return;  // factory

  char buf[64] = {0};
  int n = f.read((uint8_t *) buf, sizeof(buf) - 1);
  f.close();
  if (n <= 0) return;

  String all(buf);
  int nl = all.indexOf('\n');
  if (nl < 0) return;
  String name = all.substring(0, nl);
  String pin  = all.substring(nl + 1);
  name.trim();
  pin.trim();

  // Each field is taken only if it is still legal. A half-corrupt file leaves
  // the other half at factory rather than losing the band's identity outright.
  if (nameLegal(name)) name.toCharArray(gName, sizeof(gName));
  if (pinLegal(pin))   pin.toCharArray(gPin, sizeof(gPin));
}

/**
 * Put gName on the air.
 *
 * setName() alone changes only the GAP Device Name characteristic, which a
 * scanning phone never reads -- it reads the scan response, and that is a
 * snapshot taken when the payload was last built. So the response is rebuilt,
 * and if the radio is actually advertising it is bounced, because the
 * SoftDevice takes the payload at start(). While a link is up there is nothing
 * to bounce and restartOnDisconnect(true) puts the new bytes up on the drop.
 */
void applyName() {
  Bluefruit.setName(gName);
  Bluefruit.ScanResponse.clearData();
  Bluefruit.ScanResponse.addName();

  // gAdvStarted keeps setup() out of this. The first call comes before the
  // interval, the timeout and the manufacturer payload have been configured,
  // and starting the radio there would put a half-built advertisement on the
  // air -- setup() starts it properly a few lines later.
  if (gAdvStarted && !gConnected) {
    Bluefruit.Advertising.stop();
    Bluefruit.Advertising.start(0);
  }
}

/** Hand the SoftDevice the passkey it will demand at the next pairing. */
void applyPin() {
  Bluefruit.Security.setPIN(gPin);
}

// ------------------------------------------------------- FEEDBACK ENGINE ---
// Non-blocking buzz/blink pattern player. Never use delay() in loop() (F4.3).
// Verbatim from the ESP32 prototype except for the LED polarity.
struct Pattern {
  uint8_t  pulsesLeft = 0;
  uint16_t onMs = 0, offMs = 0;
  bool     high = false;
  uint32_t nextChange = 0;
} gPat;

void feedback(uint8_t pulses, uint16_t onMs, uint16_t offMs) {
  gPat.pulsesLeft = pulses;
  gPat.onMs = onMs;
  gPat.offMs = offMs;
  gPat.high = false;
  gPat.nextChange = 0;   // fire immediately
}

// ---- one deferred pattern, so a tick is never cut off mid-buzz -------------
//
// feedback() overwrites gPat outright, so two patterns raised close together
// destroy each other. That matters in exactly one place and it is the worst
// place: a disconnected SOS fires the FAILED buzz on the same tap that raises
// tap 2's tick, so without this the wearer would feel the tick truncated and
// might feel nothing legible at all.
//
// One slot, not a queue. Two outcomes cannot be pending at once -- the second
// press cancels the first's wait -- and a queue that can hold three buzzes is a
// wrist that is still buzzing about the last emergency during the next one.
struct Deferred {
  uint8_t  pulses = 0;      // 0 = nothing waiting
  uint16_t onMs = 0, offMs = 0;
  uint32_t at = 0;
} gDeferred;

void feedbackAfter(uint32_t delayMs, uint8_t pulses, uint16_t onMs, uint16_t offMs) {
  gDeferred.pulses = pulses;
  gDeferred.onMs = onMs;
  gDeferred.offMs = offMs;
  gDeferred.at = millis() + delayMs;
}

void deferredTick() {
  if (gDeferred.pulses == 0) return;
  if (millis() < gDeferred.at) return;
  // Wait for the motor to be idle as well as for the clock, or the deferral
  // solves nothing: a long tick still running would be cut off exactly as
  // before.
  if (gPat.pulsesLeft != 0) return;

  feedback(gDeferred.pulses, gDeferred.onMs, gDeferred.offMs);
  gDeferred.pulses = 0;
}

/** One press, counted. Deliberately the shortest thing the wrist ever feels. */
void tick() { feedback(1, FB_TICK_MS, 0); }

void feedbackTick() {
  if (gPat.pulsesLeft == 0) return;
  uint32_t now = millis();
  if (now < gPat.nextChange) return;

  gPat.high = !gPat.high;
  ledWrite(gPat.high);
  digitalWrite(PIN_MOTOR, gPat.high ? HIGH : LOW);

  if (gPat.high) {
    gPat.nextChange = now + gPat.onMs;
  } else {
    gPat.nextChange = now + gPat.offMs;
    gPat.pulsesLeft--;
  }
}

// ------------------------------------------------------- OUTCOME FEEDBACK ---
//
// Waiting to be told whether the press actually went anywhere.
//
// Armed when an event that matters is handed to a live link, disarmed by the
// phone's answer or by running out of patience. The wait exists because the
// band genuinely does not know: it saw the write succeed, which says the phone
// heard it and nothing at all about whether the server did.
uint32_t gOutcomeDueAt = 0;      // 0 = not waiting for anything

// WHAT is being waited on, because the answer has to feel different depending
// on the question. The band knows this without being told -- it sent the event
// -- so the protocol stays as it is and the app cannot get it wrong.
#define OUTCOME_NONE  0
#define OUTCOME_ACK   1          // "I'm fine", answering a check-in
#define OUTCOME_SOS   2          // a call for help
uint8_t gOutcomeKind = OUTCOME_NONE;

/**
 * It got through.
 *
 * Two shapes, not one. An SOS reaching the family is the confirmation somebody
 * frightened is actually waiting for, so it gets a single firm buzz that is
 * longer than anything on the check-in path and needs no counting. A check-in
 * answered is routine good news and stays light.
 */
void outcomeDelivered() {
  if (gOutcomeKind == OUTCOME_SOS) feedbackAfter(OUTCOME_DEFER_MS, 1, FB_SOS_OK_MS, 0);
  else                             feedbackAfter(OUTCOME_DEFER_MS, 2, 90, 70);
  gOutcomeDueAt = 0;
  gOutcomeKind  = OUTCOME_NONE;
}

/**
 * The phone has it, the server does not, and nobody has been paged yet.
 *
 * Three medium pulses: more than the light "done" of an answered check-in, and
 * plainly not the single firm buzz that means the family knows. In practice
 * only an SOS reaches this -- the check-in path has no offline queue behind it.
 */
void outcomeQueued() {
  feedbackAfter(OUTCOME_DEFER_MS, 3, 250, 150);
  gOutcomeDueAt = 0;
  gOutcomeKind  = OUTCOME_NONE;
}

/**
 * It did not go.
 *
 * Two long heavy buzzes. Deliberately NOT a single long one: a single buzz now
 * means "sent", and asking a frightened person to tell 400 ms from 900 ms is
 * asking them to make the most dangerous distinction in this vocabulary under
 * the worst possible conditions. Repetition carries it instead -- one buzz is a
 * full stop, two heavy ones are insistent, and insistent is what this means.
 */
void outcomeFailed() {
  feedbackAfter(OUTCOME_DEFER_MS, 2, FB_FAIL_MS, FB_FAIL_GAP_MS);
  gOutcomeDueAt = 0;
  gOutcomeKind  = OUTCOME_NONE;
}

/** Start waiting. The phone has OUTCOME_WAIT_MS to answer. */
void expectOutcome(uint8_t kind) {
  gOutcomeKind  = kind;
  gOutcomeDueAt = millis() + OUTCOME_WAIT_MS;
}

void outcomeTick() {
  if (gOutcomeDueAt == 0) return;
  if (millis() < gOutcomeDueAt) return;
  // Nobody answered. Fail toward "not sent": on a safety device it is better to
  // tell someone help may not be coming than to let them believe it is.
  outcomeFailed();
}

// ------------------------------------------------------------- LINK LED ---
//
// Standing state, on its own pin and deliberately NOT through feedbackTick().
// The onboard LED is welded to the motor in there, which is fine for echoing a
// buzz and useless for showing state -- it would flash on every vibration and
// mean nothing.
void linkLedWrite(bool on) {
#if LINK_LED_ACTIVE_HIGH
  digitalWrite(PIN_LINK_LED, on ? HIGH : LOW);
#else
  digitalWrite(PIN_LINK_LED, on ? LOW : HIGH);
#endif
}

void linkLedTick() {
  static uint32_t phaseAt = 0;
  static uint8_t  step = 0;
  uint32_t now = millis();
  if (now < phaseAt) return;

  // Linked: one brief flash every 5 s. Not linked: two flashes every 2 s.
  // Dark means neither -- a flat battery or a dead band, which a steady "on
  // means fine" indicator could never have distinguished from working.
  //
  // gAuthed, not gConnected. The question this LED answers is "is my band
  // linked RIGHT NOW", and a radio connection that has not proved who it is
  // cannot carry an SOS anywhere -- so counting it would be the indicator
  // telling a comfortable lie in exactly the situation it exists to expose.
  if (gAuthed) {
    if (step == 0) { linkLedWrite(true);  phaseAt = now + LINK_LED_FLASH_MS;      step = 1; }
    else           { linkLedWrite(false); phaseAt = now + LINK_LED_PERIOD_UP_MS;  step = 0; }
    return;
  }

  switch (step) {
    case 0:  linkLedWrite(true);  phaseAt = now + LINK_LED_FLASH_MS;       step = 1; break;
    case 1:  linkLedWrite(false); phaseAt = now + LINK_LED_GAP_MS;         step = 2; break;
    case 2:  linkLedWrite(true);  phaseAt = now + LINK_LED_FLASH_MS;       step = 3; break;
    default: linkLedWrite(false); phaseAt = now + LINK_LED_PERIOD_DOWN_MS; step = 0; break;
  }
}

// ----------------------------------------------------------- BATTERY (F2.3) ---
// The divider on VBAT_ENABLE (P0.14) is enabled by driving it LOW, then the
// tapped voltage is read on PIN_VBAT (P0.31). Note the macro is VBAT_ENABLE --
// EXECUTION_PLAN.md:512 writes PIN_VBAT_ENABLE, which does not exist and does
// not compile.
//
// CALIBRATE THESE TWO AGAINST A MULTIMETER before trusting any percentage.
// Meter the cell directly, compare to the mv= field on the serial heartbeat,
// and scale VBAT_DIVIDER_COMP by the ratio. Everything downstream -- the app's
// low-battery warning, the demo-day "is it charged?" glance -- rides on it.
#define VBAT_MV_PER_LSB     (3000.0F / 4096.0F)  // AR_INTERNAL_3_0, 12-bit
#define VBAT_DIVIDER_COMP   (2.961F)             // 1M / 510k tap -- VERIFY

// ===========================================================================
// DO NOT "OPTIMISE" VBAT_ENABLE. IT WILL DESTROY THE BOARD.
//
// The divider is  BAT+ -- 1M -- P0.31 -- 510k -- P0.14, so P0.14 is its BOTTOM
// leg. Driving it LOW completes the path and is what puts a safely divided
// voltage on P0.31. Set it HIGH, or leave it high-Z as an INPUT, and there is
// no division at all: P0.31 floats up toward BAT+ through the 1M. While
// charging that is ~4.2 V against a 3.6 V absolute maximum on the pin, and the
// pin is permanently destroyed. Seeed warn about this explicitly.
//
// The tempting power saving -- "the divider drains current, so gate it between
// readings" -- is exactly the fatal move. That drain is 4.2 V / 1.51 M = 2.8 uA,
// under 1.5% of the 200-400 uA budget in F4.3. Leave the pin LOW forever.
// ===========================================================================
void batteryBegin() {
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, LOW);        // LOW enables the divider -- see above
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);
  delay(1);
}

uint16_t batteryMilliVolts() {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < 8; i++) sum += analogRead(PIN_VBAT);   // cheap average
  return (uint16_t)((sum / 8.0F) * VBAT_MV_PER_LSB * VBAT_DIVIDER_COMP);
}

// Piecewise LiPo curve. A linear 3.3-4.2 V map reads ~50% for most of the
// discharge and then falls off a cliff, which trains the wearer to ignore it.
uint8_t batteryPercent(uint16_t mv) {
  if (mv >= 4150) return 100;
  if (mv >= 4000) return 85 + (mv - 4000) * 15 / 150;
  if (mv >= 3850) return 65 + (mv - 3850) * 20 / 150;
  if (mv >= 3700) return 40 + (mv - 3700) * 25 / 150;
  if (mv >= 3550) return 15 + (mv - 3550) * 25 / 150;
  if (mv >= 3300) return      (mv - 3300) * 15 / 250;
  return 0;
}

// --------------------------------------------------------------- BLE TX ---
//
// sendRaw() is the wire. send() is the wire plus the gate, and everything above
// this line uses send() -- so a connection that has not answered {"c":"auth"}
// hears nothing at all: no heartbeat, no battery, no SOS, no idea whether the
// person wearing this band is in trouble. Only the handshake itself is allowed
// to bypass it, and only to say "who are you" and "no".
//
// The serial mirror stays unconditional either way. It is the bench view, it
// costs nothing, and losing it whenever a stranger happened to be connected
// would make this the hardest thing in the firmware to debug.
void sendRaw(const String &json) {
  Serial.println(json);                       // always mirror to USB serial
  if (!gConnected) return;
  String line = json + "\n";

  // BLEUart::write() splits the line into MTU-sized notifications and stops at
  // the first one the SoftDevice refuses -- its notification queue is only a
  // few packets deep -- then discards the remainder without reporting it. At
  // the default 23-byte MTU an 86-byte heartbeat needs five packets, so the
  // phone was getting the first 23 bytes of every line and never the newline
  // that terminates it: the app buffered fragments forever and parsed nothing.
  //
  // So push until the whole line is gone, giving the radio a moment to drain
  // whenever the queue backs up. delay() on this core yields to the scheduler,
  // which is exactly what lets the SoftDevice empty it. Bounded at 200 ms so a
  // link dropping mid-line can never stall loop().
  // Send in explicit MTU-sized pieces, retrying only the piece that failed.
  //
  // Handing the whole line to BLEUart::write() does not work. It chunks the
  // line internally at MTU-3, and when the SoftDevice's notification pool runs
  // dry mid-line it abandons the rest and returns false -- keeping no record
  // of how far it got (BLECharacteristic::notify, the `if (!getHvnPacket())
  // return false` inside its while loop). That is the original bug: the phone
  // got the first 23 bytes of every 86-byte line and never the newline that
  // terminates it. It also makes the obvious fix wrong, because retrying the
  // whole line re-sends bytes that already went out and corrupts the stream.
  //
  // Keeping the offset here is what makes a retry safe: every write is at most
  // one notification, so it either goes out whole or not at all.
  const uint8_t *p = (const uint8_t *) line.c_str();
  size_t left = line.length();

  // 20 is the worst case (MTU 23). The MTU is negotiated by the phone, so it
  // is only known once connected -- use whatever we actually got.
  uint16_t chunk = 20;
  BLEConnection *c = Bluefruit.Connection(Bluefruit.connHandle());
  if (c && c->getMtu() > 23) chunk = c->getMtu() - 3;

  // Bounded so a link dying mid-line can never stall loop(). delay() on this
  // core yields to the scheduler, which is what lets the pool refill.
  uint32_t deadline = millis() + 200;
  while (left && gConnected && millis() < deadline) {
    uint16_t n = (left < chunk) ? (uint16_t) left : chunk;
    if (bleuart.write(p, n)) { p += n; left -= n; }
    else delay(2);                            // pool empty -- let it drain
  }
}

void send(const String &json) {
  if (!gAuthed) { Serial.println(json); return; }
  sendRaw(json);
}

void sendEvent(const char *type, const String &extra = "") {
  String j = "{\"t\":\"evt\",\"e\":\"";
  j += type;
  j += "\",\"seq\":" + String(++gSeq);
  j += ",\"ms\":" + String(millis());
  j += ",\"bat\":" + String(gBattery);
  j += ",\"armed\":" + String(gArmed ? 1 : 0);
  j += ",\"ha\":" + String(gHighAlert ? 1 : 0);
  if (extra.length()) j += "," + extra;
  j += "}";
  send(j);
}

// ------------------------------------------------------- BUTTON ENGINE ---
// Verbatim from the ESP32 prototype. Button B is gone; the shipped band has one
// button and the gesture map already lived on button 1.
struct Button {
  uint8_t  pin;
  uint8_t  id;                 // 1 = the only button on the shipped band
  bool     stable = true;      // true = released (pull-up)
  bool     lastRead = true;
  uint32_t lastChange = 0;
  uint32_t pressStart = 0;
  uint8_t  clicks = 0;
  uint32_t lastRelease = 0;
  bool     sosFired = false;   // this burst already sent SOS; stay quiet after
  bool     holdFired1 = false;
  bool     holdFired2 = false;

  // The ESP32 prototype brace-initialised this struct. That core compiled to a
  // newer C++ standard; this one is gnu++11, where the default member
  // initialisers above stop Button being an aggregate and `Button b{pin, id}`
  // will not compile. Same two fields, set the only way this core allows.
  Button(uint8_t p, uint8_t i) : pin(p), id(i) {}
};

Button gBtn(PIN_BTN, 1);

void onGesture(uint8_t btn, const char *gesture, uint8_t n);

void buttonTick(Button &b) {
  uint32_t now = millis();
  bool raw = digitalRead(b.pin);              // LOW = pressed

  if (raw != b.lastRead) { b.lastRead = raw; b.lastChange = now; }

  if ((now - b.lastChange) > DEBOUNCE_MS && raw != b.stable) {
    b.stable = raw;
    if (b.stable == LOW) {                    // ---- press edge
      b.pressStart = now;
      b.holdFired1 = b.holdFired2 = false;

      // "I felt that." On the way DOWN, under the finger, not on release.
      //
      // This started on the release edge and it was wrong: the wearer had to
      // press, hold, and let go before anything happened, which reads as lag
      // even though nothing is actually slow. A click confirmation that arrives
      // after the click is over is not a click confirmation.
      //
      // Only the 35 ms debounce sits in front of it now, which is below what
      // anyone can perceive. Counting is unaffected -- one press, one tick, so
      // two taps are still felt as two.
      tick();
    } else {                                  // ---- release edge
      uint32_t held = now - b.pressStart;
      if (!b.holdFired1 && !b.holdFired2 && held < HOLD_1_MS) {
        b.clicks++;
        b.lastRelease = now;

        // The tick for this press already fired on the way down, which is the
        // whole answer to the doubt described below: a press that was not
        // registered feels different from one that was, so tapping again out of
        // uncertainty stops being the only safe move.

        // SOS the instant the second tap lands -- do not wait for the burst to
        // close. Taps 3, 4, 5 are still SOS but must not re-send it, so the
        // flag latches for the rest of the burst.
        if (b.clicks == 2 && !b.sosFired) {
          b.sosFired = true;
          onGesture(b.id, "click", 2);
        }
      }
    }
  }

  // The hold threshold fires while still held down (with a cue), like real
  // devices. Only hold3 is bound today; the hold5 hook is commented out rather
  // than deleted so v2 anti-snatch is a two-line restore -- an unbound
  // threshold must stay silent, or the band buzzes to announce it did nothing.
  if (b.stable == LOW) {
    uint32_t held = now - b.pressStart;
    if (!b.holdFired1 && held >= HOLD_1_MS) {
      b.holdFired1 = true;
      feedback(1, 250, 120);
      onGesture(b.id, "hold3", 0);
    }
    // if (!b.holdFired2 && held >= HOLD_2_MS) {
    //   b.holdFired2 = true;
    //   feedback(2, 250, 120);
    //   onGesture(b.id, "hold5", 0);
    // }
  }

  // Close the burst. By the time we get here SOS has already been sent if it
  // was ever going to be, so the only thing this can still emit is the 1-tap
  // checkin_ack -- which is exactly the event that must never be guessed.
  if (b.clicks > 0 && b.stable == HIGH && (now - b.lastRelease) > TAP_WINDOW_MS) {
    uint8_t n = b.clicks;
    bool    alreadySos = b.sosFired;
    b.clicks = 0;
    b.sosFired = false;
    if (!alreadySos) onGesture(b.id, "click", n);
  }
}

// -------------------------------------------------------- GESTURE MAP ---
// This is the ONLY place hardware meets meaning, and it must stay identical to
// DEFAULT_GESTURES in nigehban-app/src/virtualBand.js -- the two implementations
// of this map that remain.
//
// Follows EXECUTION_PLAN.md section 5, the frozen contract:
//
//     1 tap        checkin_ack        "I'm fine" / stands down a live SOS
//     2+ taps      sos                double-tap is the specified gesture
//     hold 3 s     high_alert_on/off  toggles High Alert
//
// Nothing is bound to hold 5 s. Anti-snatch is deferred to v2, so the wearer
// has two things to remember rather than three.
//
// ---------------------------------------------------------------------------
// THE SLOW-TAP FAILURE — why SOS fires early and checkin_ack fires late
//
// The original design counted taps, waited CLICK_GAP_MS (420 ms) for the burst
// to end, and only then decided what had happened. That has a failure mode
// worse than not working at all:
//
//   Someone frightened taps twice, but slowly -- 500 ms apart. Each tap closes
//   its own burst. The band sends checkin_ack. Twice. The family is told
//   "I'm fine" by a person calling for help.
//
// The two errors are not equally bad. A false SOS is embarrassing and someone
// stands it down in seconds. A false "I'm fine" is silent, final, and arrives
// exactly when it must not. So the tie is broken toward SOS, always:
//
//   * SOS fires on the SECOND TAP ITSELF, not when the burst closes. Nothing is
//     waited for, and the ack can no longer win the race by going first. This
//     also makes a real SOS ~400 ms faster, which is the case that needs it.
//
//   * checkin_ack waits TAP_WINDOW_MS (1200 ms) before committing, because it
//     is the claim we must never make by accident. Two taps up to 1.2 s apart
//     are now SOS. The cost is that "I'm fine" confirms a beat later, and
//     nobody is in danger while that beat passes.
//
// A consequence worth accepting rather than fixing: a wearer who taps, feels
// no buzz, and taps again out of doubt now raises an SOS. That is the correct
// direction to fail, and it is the same reasoning that already makes 3, 4 and
// 5 taps SOS. It will also get rarer once the haptics are strong enough to
// confirm the first tap -- see the driver note at the top of this file.
//
// virtualBand.js must match this. It still has the old 420 ms burst logic and
// therefore still has the bug.
// ---------------------------------------------------------------------------
void onGesture(uint8_t btn, const char *gesture, uint8_t n) {
  String meta = "\"btn\":" + String(btn) + ",\"g\":\"" + gesture + "\",\"n\":" + String(n);

  if (btn == 1 && strcmp(gesture, "click") == 0) {
    if (n == 1) {                       // "I'm fine" / silence a check-in
      gAwaitingAck = false;
      gNextNagAt   = 0;                 // answered: stop asking
      // No buzz here any more. The tick already said "I counted that", and this
      // used to fire a 1 x 90 confirmation *before* send() -- which returns
      // early with no link, so the wearer was told their "I'm fine" had gone
      // when nothing had left the wrist. The phone answers now; see below.
      sendEvent("checkin_ack", meta);
      // gAuthed, not gConnected: send() drops the line unless the phone has
      // proved itself, so an unauthenticated connection is a link that cannot
      // carry this. Waiting four seconds for an outcome nobody is coming to
      // deliver would only delay telling the wearer it did not go.
      if (gAuthed) expectOutcome(OUTCOME_ACK); else outcomeFailed();
      return;
    }
    // Two taps is SOS -- and so are three, four, five. A frightened person
    // does not tap a precise number of times, and being strict here fails
    // silently at the exact moment the product has to work. Section 5 reserves
    // 4 taps for `armed` in v2; that needs its own affordance, because folding
    // it in would let an over-tapped SOS arm anti-snatch instead of calling
    // for help.
    if (gAuthed) {
      // Deliberately NO confirmation buzz here.
      //
      // This used to fire a four-pulse "sent" the instant the tap landed. The
      // band cannot know that. A successful write means the phone received the
      // press; with the app's offline queue the alert can then sit unsent for
      // minutes, and the wearer would have been told help was coming either
      // way. So the band asks and waits, and the phone -- the only thing that
      // knows whether the server has it -- answers with ack / queued / failed.
      sendEvent("sos", meta + ",\"src\":\"double_tap\"");
      expectOutcome(OUTCOME_SOS);
      return;
    }

    // No link. This is the one outcome the band CAN settle alone: send() drops
    // this on the floor and nothing anywhere has received it, so there is
    // nothing to wait for and the failure goes out immediately.
    //
    // Until now this buzzed 6 x 250 ms -- longer and heavier than the success
    // pattern, so it felt like a BIGGER confirmation of something that had not
    // happened. It was written when the SOS beacon carried the press out over
    // the advertisement; that path is switched off (docs/BAND_WAKE_DISABLED.md)
    // and the buzz outlived the thing it was confirming.
    //
    // setSosBeacon() is left in place: it is inert while nothing scans for the
    // flag, and it is the foundation the band id will be built on when the
    // beacon returns. See BUG-012.
    setSosBeacon(true);
    outcomeFailed();
    sendEvent("sos", meta + ",\"src\":\"double_tap\",\"via\":\"beacon\"");
    return;
  }

  // --- Hold ---
  // Fires on the way past, with its own buzz count, so the wearer can feel
  // that it landed without looking at anything.
  if (strcmp(gesture, "hold3") == 0) {
    gHighAlert = !gHighAlert;
    feedback(gHighAlert ? 2 : 1, 180, 120);
    sendEvent(gHighAlert ? "high_alert_on" : "high_alert_off", meta);
    return;
  }
}

// ------------------------------------------------------------- IMU (F3) ---
// The on-board LSM6DS3TR-C at 0x6A. The MPU6050 path from the ESP32 prototype
// is gone for good (F2.2) -- that was an external part we do not have.
#if HAS_IMU
#include "LSM6DS3.h"
LSM6DS3 imu(I2C_MODE, 0x6A);     // the Seeed lib remaps to Wire1 internally

bool     gImuOk   = false;       // begin() succeeded; false = detector is off
bool     gImuCsv  = false;       // calibration stream, USB serial only

// The fall machine. Named rather than numbered, because "stage 2" in a serial
// log tells nobody anything at 1 a.m. on a bench.
#define FS_IDLE      0
#define FS_FREEFALL  1           // the wrist has gone light
#define FS_IMPACT    2           // it landed; waiting to see if it stays put
uint8_t  gFallStage = FS_IDLE;
uint32_t gFallSince = 0;         // when this stage began
uint32_t gFreefallMs = 0;        // how long the free-fall actually lasted
float    gFallPeak  = 0;         // biggest |a| seen this episode
uint32_t gFallStillFrom = 0;     // when the wrist last became still, 0 = not
uint32_t gLastFallAt = 0;        // refractory

// Which route this episode came in by -- see the constants block. It decides
// how hard the impact had to be, how long the stillness must hold, and whether
// an orientation change is required at all.
#define ROUTE_A 0                // free-fall corroborated it
#define ROUTE_B 1                // no free-fall: a topple, judged on its own
uint8_t  gFallRoute = ROUTE_A;
// The wrist's resting angle from BEFORE the impact, snapshotted as it starts.
// Taken then and not later because gRest* keeps tracking, and by the time the
// episode resolves it has already learned the post-fall posture -- comparing
// that with itself would read zero degrees for every real fall.
float    gPreX = 0, gPreY = 0, gPreZ = 0;
bool     gPreValid = false;
float    gFallTilt = 0;          // what the comparison actually came out at

// The impact reporter, which is a separate machine on purpose: a crash has no
// free-fall to key off and would never reach FS_IMPACT above.
#define IS_IDLE      0
#define IS_SETTLING  1           // spike seen; measuring what happened next
uint8_t  gImpStage  = IS_IDLE;
uint32_t gImpSince  = 0;
float    gImpPeak   = 0;
float    gImpRot    = 0;         // peak |gyro|, deg/s -- a tumble, not a knock
uint32_t gImpStillMs = 0;        // ms of stillness inside the settle window
uint32_t gLastImpactAt = 0;

void imuBegin() {
  // THE POWER GATE. The Sense can switch the IMU off entirely for low power,
  // and until this pin is HIGH, begin() fails on perfectly good hardware. The
  // EXECUTION_PLAN.md section 8 skeleton is missing this line.
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(10);

  // ===========================================================================
  // SET THE RANGE EXPLICITLY. A DEFAULT HERE IS A SILENTLY BROKEN DETECTOR.
  //
  // The accelerometer clips at its full-scale range and reports the clipped
  // value as though it were real. On a +/-2 g setting every fall, every clap
  // and every car crash reads as "2.0 g" -- the impact threshold is never
  // crossed, nothing is ever detected, and there is no error anywhere to find:
  // the numbers look plausible, they are just all the same.
  //
  // 16 g is this part's maximum and still not enough for a vehicle impact,
  // which saturates it. That is a known and accepted limit: IMPACT_G is 8 g, so
  // a saturated reading is unambiguously over the line. `peak_g` on a real
  // crash means "at least 16", never "exactly 16".
  // ===========================================================================
  imu.settings.accelRange      = 16;    // g -- see above
  imu.settings.accelSampleRate = 104;   // Hz, comfortably over IMU_PERIOD_MS
  imu.settings.gyroRange       = 2000;  // dps -- a wrist in a crash spins hard
  imu.settings.gyroSampleRate  = 104;

  gImuOk = (imu.begin() == 0);
  Serial.println(gImuOk
    ? F("{\"t\":\"log\",\"msg\":\"imu up\",\"range_g\":16,\"odr\":104}")
    : F("{\"t\":\"log\",\"msg\":\"IMU FAILED - fall detection is OFF\"}"));
}

/**
 * One sample, kept whole.
 *
 * The magnitude alone was enough while a fall was only ever "light, hit, still".
 * Route B asks which WAY the wrist is pointing, and that question needs the
 * vector -- so the three axes are read once here and shared, rather than the
 * accelerometer being polled twice per tick for the same numbers.
 */
float gAx = 0, gAy = 0, gAz = 0;

/** |a| in g. 1.0 at rest, toward 0 in free-fall, high on impact. */
float imuMagnitudeG() {
  gAx = imu.readFloatAccelX();
  gAy = imu.readFloatAccelY();
  gAz = imu.readFloatAccelZ();
  return sqrtf(gAx * gAx + gAy * gAy + gAz * gAz);
}

// ---- which way the wrist is pointing ---------------------------------------
//
// Gravity, pulled out of the accelerometer with a slow low-pass filter. This is
// the textbook separation: over half a second or so, deliberate movement is
// zero-mean and averages away, while gravity is a constant 1 g pulling in one
// direction -- so what survives the filter IS the posture.
//
// The obvious alternative -- only sample the vector when the arm is holding
// still -- was tried first and is worse in exactly the case that matters. An
// arm swinging through a walk is rarely quiet for 400 ms together, so the last
// "resting" posture could be minutes old by the time somebody trips, and route
// B would compare where they are now against where they were standing in
// another room. The filter keeps up while they walk; a stillness gate does not.
//
// A hard impact does pollute it -- a 20 g sample shifts the estimate -- but the
// comparison happens seconds later, by which time it has long recovered.
// TWO filters, at two speeds, and the second one is not redundant.
//
// The fast one answers "where is the wrist now", which is what the comparison
// needs AFTER everything has settled.
//
// The slow one answers "where was the wrist before any of this started", and it
// has to be slow because of how long a topple takes. A person rotating to the
// floor takes 0.7-1.2 s, so a half-second filter sampled at the moment of
// impact has already spent its whole memory watching them fall -- it holds a
// posture halfway to the ground, the measured tilt comes out about half what it
// should be, and route B quietly stops firing on the very falls it exists for.
// Three seconds of memory still holds the posture from before the topple began.
#define REST_ALPHA      0.02f    // ~0.5 s at 100 Hz -- "where am I now"
#define REST_SLOW_ALPHA 0.003f   // ~3.3 s        -- "where was I before this"
float    gRestX = 0, gRestY = 0, gRestZ = 0;
float    gSlowX = 0, gSlowY = 0, gSlowZ = 0;
bool     gRestValid = false;

void restTick() {
  if (!gRestValid) {
    gRestX = gSlowX = gAx;
    gRestY = gSlowY = gAy;
    gRestZ = gSlowZ = gAz;
    gRestValid = true;
    return;
  }
  gRestX += (gAx - gRestX) * REST_ALPHA;
  gRestY += (gAy - gRestY) * REST_ALPHA;
  gRestZ += (gAz - gRestZ) * REST_ALPHA;
  gSlowX += (gAx - gSlowX) * REST_SLOW_ALPHA;
  gSlowY += (gAy - gSlowY) * REST_SLOW_ALPHA;
  gSlowZ += (gAz - gSlowZ) * REST_SLOW_ALPHA;
}

/** Angle in degrees between two gravity vectors. 0 = same posture. */
float tiltBetween(float ax, float ay, float az, float bx, float by, float bz) {
  float na = sqrtf(ax * ax + ay * ay + az * az);
  float nb = sqrtf(bx * bx + by * by + bz * bz);
  if (na < 0.1f || nb < 0.1f) return 0;          // nothing meaningful to compare
  float c = (ax * bx + ay * by + az * bz) / (na * nb);
  if (c > 1.0f) c = 1.0f;
  if (c < -1.0f) c = -1.0f;
  return acosf(c) * 57.2957795f;
}

/**
 * |gyro| in deg/s.
 *
 * Read only while an impact is being measured, never on the idle path. Each
 * axis is its own I2C transaction in this library, so reading all six every
 * tick doubles the bus traffic for a number that is meaningless 99.9% of the
 * time.
 */
float imuRotationDps() {
  float x = imu.readFloatGyroX();
  float y = imu.readFloatGyroY();
  float z = imu.readFloatGyroZ();
  return sqrtf(x * x + y * y + z * z);
}

/**
 * The 100 Hz sampler and both detectors.
 *
 * Runs the fall machine and the impact reporter off the SAME sample. They are
 * not exclusive and are not meant to be: a rider thrown off a bike produces a
 * genuine free-fall AND a 20 g spike, and both events going out is correct --
 * the phone raises one incident from whichever arrives first and the refractory
 * windows keep the second from becoming a second buzz.
 */
void imuTick() {
  if (!gImuOk) return;

  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < IMU_PERIOD_MS) return;
  last = now;

  float g = imuMagnitudeG();
  bool  still = fabsf(g - 1.0f) < FALL_STILL_BAND_G;

  // Which way the wrist is pointing. Runs on every sample -- it has to keep up
  // with somebody walking, or route B compares where they are now against where
  // they were standing several minutes ago.
  restTick();

  // ---- the calibration stream ---------------------------------------------
  // USB serial only, and deliberately not through send(): this is 100 lines a
  // second and would flood a BLE link that has an emergency to carry. It exists
  // so a drop test produces a CSV you can plot, which is the only honest way to
  // pick the numbers above. `{"c":"imucal","on":1}` turns it on.
  if (gImuCsv) {
    Serial.print(now);          Serial.print(',');
    Serial.print(g, 3);         Serial.print(',');
    Serial.print(gFallStage);   Serial.print(',');
    Serial.println(gImpStage);
  }

  // ------------------------------------------------------- the fall machine ---
  switch (gFallStage) {
    case FS_IDLE:
      if (g < FALL_FREEFALL_G) {
        // Route A. Something went light; wait to see if it lands.
        gFallStage = FS_FREEFALL; gFallSince = now; gFallPeak = g;
      } else if (g >= FALL_HARD_G) {
        // ROUTE B -- the topple. No free-fall, and there was never going to be
        // one: a person rotating to the floor keeps gravity on the wrist the
        // whole way down. All this stage knows is that something hit hard, so
        // the posture from just before it is captured NOW, while gRest* still
        // describes where the wearer was rather than where they ended up.
        gFallStage = FS_IMPACT;
        gFallRoute = ROUTE_B;
        gFallSince = now;
        gFallPeak  = g;
        gFreefallMs = 0;
        gFallStillFrom = 0;
        gFallTilt = 0;
        gPreX = gSlowX; gPreY = gSlowY; gPreZ = gSlowZ;
        gPreValid = gRestValid;
      }
      break;

    case FS_FREEFALL:
      if (g < FALL_FREEFALL_G) break;                       // still falling
      gFreefallMs = now - gFallSince;
      // A flick of the wrist also goes light, for about 30 ms. Requiring a
      // minimum duration is what separates "this arm moved" from "this arm is
      // no longer being held up".
      if (gFreefallMs >= FALL_FREEFALL_MIN_MS) {
        gFallStage = FS_IMPACT; gFallSince = now; gFallPeak = g; gFallStillFrom = 0;
        gFallRoute = ROUTE_A;
        gFallTilt = 0;
        gPreX = gSlowX; gPreY = gSlowY; gPreZ = gSlowZ;
        gPreValid = gRestValid;
      } else {
        gFallStage = FS_IDLE;
      }
      break;

    case FS_IMPACT: {
      if (g > gFallPeak) gFallPeak = g;

      // How hard it had to hit depends on how it got here. Route A has a
      // free-fall behind it and can afford a low bar; route B is carrying the
      // argument on its own and needs more.
      float needG    = (gFallRoute == ROUTE_B) ? FALL_HARD_G : FALL_IMPACT_G;
      uint32_t needStill = (gFallRoute == ROUTE_B) ? FALL_STILL_SLOW_MS : FALL_STILL_MS;

      // Nothing hit anything. Somebody lowered their arm slowly, or waved.
      if (gFallPeak < needG) {
        if (now - gFallSince > FALL_IMPACT_WINDOW_MS) gFallStage = FS_IDLE;
        break;
      }

      // Landed. Now the question that keeps a dropped bag from paging a mother
      // at 2 a.m.: did the wrist STAY down? Someone who trips, catches
      // themselves and walks on is moving again within a second. Someone who is
      // on the floor is not.
      if (!still) { gFallStillFrom = 0; }
      else if (gFallStillFrom == 0) { gFallStillFrom = now; }

      if (gFallStillFrom && now - gFallStillFrom >= needStill) {
        // Route B's second piece of evidence, and the one that stops it firing
        // on every hand put down hard: did the wearer end up at a different
        // angle from the one they were at? A clap, a slammed door and a palm on
        // a desk all leave the arm roughly where it started. Going to the floor
        // does not.
        //
        // Measured against the posture captured when the impact began, not
        // against a live reading -- gRest* has been learning the new posture
        // ever since, and comparing it with itself reads zero for every fall.
        if (gFallRoute == ROUTE_B) {
          gFallTilt = gPreValid && gRestValid
            ? tiltBetween(gPreX, gPreY, gPreZ, gRestX, gRestY, gRestZ) : 0;
          if (!gPreValid || gFallTilt < FALL_TILT_DEG) {
            // Hit hard, went quiet, same posture. That is furniture, and the
            // wearer is told nothing -- the phone still gets the `impact` from
            // the reporter below, which is where a crash is decided.
            gFallStage = FS_IDLE;
            break;
          }
        }
        gFallStage = FS_IDLE;
        // `== 0` is "nothing has ever fired". Without it the subtraction is
        // measured from boot, and every fall in the first FALL_REFRACTORY_MS of
        // uptime is silently swallowed -- which is a band that is deaf for the
        // first fifteen seconds after a battery change or a reset. 0 is a safe
        // sentinel because this is only ever assigned `now` at event time, and
        // millis() is long past 0 by then.
        if (gLastFallAt == 0 || now - gLastFallAt > FALL_REFRACTORY_MS) {
          gLastFallAt = now;
          // Five firm pulses, the pattern this event has always used. It is a
          // question, not a confirmation -- the phone is about to ask whether
          // the wearer is all right, and this is the wrist saying why.
          feedback(5, 200, 150);
          // `route` and `tilt` go out so a false positive in the field can be
          // told apart from a false positive on the bench without a re-flash.
          sendEvent("fall", "\"peak_g\":" + String(gFallPeak, 2)
                          + ",\"ff_ms\":" + String(gFreefallMs)
                          + ",\"route\":\"" + String(gFallRoute == ROUTE_B ? "topple" : "drop")
                          + "\",\"tilt\":" + String((int) gFallTilt));
        }
      } else if (now - gFallSince > FALL_IMPACT_WINDOW_MS + needStill + 1000) {
        gFallStage = FS_IDLE;                               // got up: not a fall
      }
      break;
    }
  }

  // ---------------------------------------------------- the impact reporter ---
  //
  // Deliberately says nothing about what the spike WAS. It reports how hard,
  // how much rotation, and how still the arm went afterwards, because those are
  // the three things a wrist can honestly measure -- and then the phone, which
  // knows the speed, decides whether this was a road accident or a door.
  switch (gImpStage) {
    case IS_IDLE:
      // Same "never fired" sentinel as the fall path above, for the same
      // reason: measured from boot, the band would ignore every impact in its
      // first ten seconds of uptime.
      if (g >= IMPACT_G
          && (gLastImpactAt == 0 || now - gLastImpactAt > IMPACT_REFRACTORY_MS)) {
        gImpStage = IS_SETTLING;
        gImpSince = now;
        gImpPeak  = g;
        gImpRot   = imuRotationDps();
        gImpStillMs = 0;
      }
      break;

    case IS_SETTLING: {
      if (g > gImpPeak) gImpPeak = g;
      float rot = imuRotationDps();
      if (rot > gImpRot) gImpRot = rot;
      if (still) gImpStillMs += IMU_PERIOD_MS;

      if (now - gImpSince >= IMPACT_SETTLE_MS) {
        gImpStage = IS_IDLE;
        gLastImpactAt = now;
        // No buzz. This is not yet news -- most impacts are furniture, and a
        // band that vibrates every time its wearer puts a hand down hard is a
        // band that gets taken off. If the phone decides this was an accident
        // it opens a check-in, and THAT buzzes.
        sendEvent("impact",
          "\"peak_g\":" + String(gImpPeak, 1)
          + ",\"rot\":" + String((int) gImpRot)
          // Fraction of the settle window the arm was still, 0-100. High means
          // it stopped dead; low means it is still being thrown around, which
          // in a vehicle is the worse of the two.
          + ",\"still\":" + String((int)(gImpStillMs * 100 / IMPACT_SETTLE_MS)));
      }
      break;
    }
  }
}
#endif

// ------------------------------------------------------ COMMANDS IN ---
// Tiny dependency-free JSON field reader. Good enough for our fixed schema.
String jsonStr(const String &s, const char *key) {
  String pat = String("\"") + key + "\":\"";
  int i = s.indexOf(pat);
  if (i < 0) return "";
  i += pat.length();
  int j = s.indexOf('"', i);
  return (j < 0) ? "" : s.substring(i, j);
}
int jsonInt(const String &s, const char *key, int dflt) {
  String pat = String("\"") + key + "\":";
  int i = s.indexOf(pat);
  if (i < 0) return dflt;
  i += pat.length();
  return s.substring(i).toInt();
}

// ------------------------------------------------------- THE HANDSHAKE ---
//
// Everything the band used to do the instant a connection came up now happens
// here instead, because "a connection came up" and "my phone is here" stopped
// being the same sentence the moment a PIN stood between them.
//
// That includes taking the SOS beacon down. An unauthenticated connection must
// never silence a cry for help: the beacon is the path that exists precisely
// because the app is not there, and a stranger's phone connecting -- or an
// attacker's, deliberately -- would otherwise be enough to switch it off.
/** Seconds left on a lockout, or 0 if there is not one. */
uint32_t lockoutLeftS() {
  if (gLockedUntil == 0) return 0;
  uint32_t now = millis();
  // Unsigned comparison, not (gLockedUntil - now) > 0, which is true forever.
  if ((int32_t)(gLockedUntil - now) <= 0) { gLockedUntil = 0; return 0; }
  return (gLockedUntil - now + 999) / 1000;
}

/**
 * A wrong PIN. Count it, and decide whether the band goes quiet for a while.
 *
 * The escalation starts only after AUTH_LOCKOUT_AT, so the owner's first few
 * fumbles cost nothing. After that each further failure moves one step up
 * AUTH_LOCKOUT_MS and stops at the last entry -- fifteen minutes, forever, which
 * is enough to make a search of 10^6 PINs meaningless without ever bricking a
 * band somebody needs.
 */
void noteAuthFailure() {
  if (gAuthFails < 255) gAuthFails++;
  if (gAuthFails < AUTH_LOCKOUT_AT) return;

  uint8_t steps = sizeof(AUTH_LOCKOUT_MS) / sizeof(AUTH_LOCKOUT_MS[0]);
  uint8_t idx   = gAuthFails - AUTH_LOCKOUT_AT;
  if (idx >= steps) idx = steps - 1;

  gLockedUntil = millis() + AUTH_LOCKOUT_MS[idx];
  if (gLockedUntil == 0) gLockedUntil = 1;      // millis() wrap: 0 means "none"

  // Felt, not just reported. If this band is in a drawer being guessed at, the
  // buzz is the only thing that can tell its owner across a room; and if the
  // owner is the one guessing, it says "stop typing" better than a screen can.
  feedback(2, 700, 300);
  Serial.println("{\"t\":\"log\",\"msg\":\"auth locked out\",\"fails\":"
                 + String(gAuthFails) + ",\"for_s\":"
                 + String(AUTH_LOCKOUT_MS[idx] / 1000) + "}");
}

void authOk() {
  gAuthed       = true;
  gWasAuthed    = true;
  gAuthTries    = 0;
  gAuthDeadline = 0;
  // The right PIN clears the whole history. A lockout is there to stop a search,
  // and a search that has just succeeded is over.
  gAuthFails    = 0;
  gLockedUntil  = 0;

  // The name goes back with the acknowledgement so the app can label the band
  // without a second round trip, and so a rename done from another phone shows
  // up on this one the next time it links.
  sendRaw(String("{\"t\":\"evt\",\"e\":\"auth_ok\",\"name\":\"") + gName
          + "\",\"defpin\":" + String(usingDefaultPin() ? 1 : 0) + "}");

  if (gSosBeacon) setSosBeacon(false);

  feedback(1, 200, 100);
  sendEvent("link_up");
}

void handleCommand(const String &line) {
  String c = jsonStr(line, "c");

  // ---- the gate ----------------------------------------------------------
  //
  // One command exists before authentication and it is the one that ends it.
  // Nothing else is answered, not even `ping`: a band that answers anything is
  // a band that confirms it is here, and the whole point of the silence is
  // that a device nobody can talk to is not worth standing next to.
  if (!gAuthed) {
    if (c != "auth") return;

    // Locked out. Answered rather than ignored, and answered with the time,
    // because "wait four minutes" and "this band is broken" need to look
    // completely different to somebody holding a safety device. Guessing during
    // a lockout costs nothing extra -- the counter is untouched here -- so
    // waiting is always the winning move for an owner and never shortens
    // anything for an attacker.
    uint32_t wait = lockoutLeftS();
    if (wait) {
      sendRaw(String("{\"t\":\"evt\",\"e\":\"auth_locked\",\"for_s\":")
              + String(wait) + "}");
      delay(50);                     // let it leave the radio before hanging up
      Bluefruit.disconnect(Bluefruit.connHandle());
      return;
    }

    if (jsonStr(line, "pin") == gPin) { authOk(); return; }

    // Wrong. Say so -- the app has to be able to tell "bad PIN" from "band out
    // of range", or it would sit retrying a link that will never come up and
    // never ask the user for the one thing that would fix it.
    noteAuthFailure();
    gAuthTries++;
    sendRaw(String("{\"t\":\"evt\",\"e\":\"auth_bad\",\"left\":")
            + String(AUTH_MAX_TRIES - gAuthTries) + ",\"locked_s\":"
            + String(lockoutLeftS()) + "}");
    if (gAuthTries >= AUTH_MAX_TRIES) {
      Serial.println("{\"t\":\"log\",\"msg\":\"auth failed, hanging up\"}");
      // Let the refusal actually leave the radio first. sendRaw() only queues
      // the notification with the SoftDevice, and tearing the link down in the
      // same breath drops it -- which would leave the app showing "lost the
      // band" for a wrong PIN, sending somebody to look for a wristband that is
      // right there and merely saying no. delay() yields to the scheduler on
      // this core, which is what lets the queue drain.
      delay(50);
      Bluefruit.disconnect(Bluefruit.connHandle());
    }
    return;
  }

  if (c == "checkin_req") {                  // phone asks "are you OK?"
    gAwaitingAck = true;
    gAckDeadline = millis() + (uint32_t)jsonInt(line, "window", 60) * 1000UL;
    gNextNagAt   = millis() + CHECKIN_NAG_MS; // and keep asking until answered
    feedback(3, 400, 250);                   // long, unmissable buzz
    sendEvent("checkin_prompted");
  } else if (c == "buzz") {
    feedback(jsonInt(line, "n", 2), 150, 120);
  } else if (c == "alarm") {
    feedback(20, 300, 200);
  // ---- the answer to a press this band is still waiting on -----------------
  //
  // All three are ignored unless something is actually pending. An outcome is
  // the answer to a question the wrist asked; delivered with no question in
  // flight it is a buzz for a press the wearer never made. That happens
  // routinely -- an SOS raised from the app's own button, or a stand-down
  // tapped on screen -- and in both of those the wearer is looking at the
  // phone and needs nothing from their wrist.
  } else if (c == "ack") {                   // cloud received our event
    // The command already existed and carried exactly this meaning; nothing had
    // ever sent it. It is repointed at the delivered pattern rather than a new
    // command being invented, so the vocabulary does not grow and the app
    // cannot drift into its own idea of what "sent" feels like. Its old
    // 1 x 60 ms goes with it -- nothing in this design is under 90 ms.
    if (gOutcomeDueAt) outcomeDelivered();
  } else if (c == "queued") {                // phone has it, no network yet
    if (gOutcomeDueAt) outcomeQueued();
  } else if (c == "failed") {                // the phone knows it did not go
    if (gOutcomeDueAt) outcomeFailed();
  } else if (c == "bat") {                   // demo helper: force battery level
    gBattery = (uint8_t)jsonInt(line, "v", 100);
    gBatteryForced = true;
    sendEvent("battery", "\"forced\":1");
  } else if (c == "ping") {
    sendEvent("pong");

  // ---- identity: the name, the PIN, and who is still bonded ----------------
  } else if (c == "auth") {
    // Already through the gate. Answered anyway, and without the buzz, because
    // the app re-runs its handshake whenever it ADOPTS a link it did not open
    // (Android rebuilt the activity, the process came back). That is not a new
    // link and must not feel like one -- but it does still need the name.
    sendRaw(String("{\"t\":\"evt\",\"e\":\"auth_ok\",\"name\":\"") + gName
            + "\",\"defpin\":" + String(usingDefaultPin() ? 1 : 0) + "}");

  } else if (c == "cfg") {
    // The PIN is never sent back, to anyone, ever. `defpin` is the one thing
    // the app needs to know about it: whether it is still the factory value,
    // so it can say so on screen instead of quietly leaving a band open.
    sendEvent("cfg", String("\"name\":\"") + gName + "\",\"defpin\":"
              + String(usingDefaultPin() ? 1 : 0));

  } else if (c == "setname") {
    String n = jsonStr(line, "name");
    n.trim();
    if (!nameLegal(n)) {
      sendEvent("name_rejected", "\"why\":\"1-" + String(NAME_MAX_LEN)
                + " plain characters, no quotes\"");
    } else {
      n.toCharArray(gName, sizeof(gName));
      configSave();
      applyName();
      sendEvent("name_set", String("\"name\":\"") + gName + "\"");
      feedback(2, 90, 90);            // felt, so a rename is not a silent act
    }

  } else if (c == "setpin") {
    String np = jsonStr(line, "pin");
    String op = jsonStr(line, "old");

    // The CURRENT PIN, typed again, before the new one is accepted.
    //
    // Being authenticated is not enough and never was. A link stays
    // authenticated for as long as it stays up, so anybody who picks up an
    // unlocked phone with a live band on it could set a new PIN, and would then
    // own the band: the wearer's other phones stop authenticating, and the
    // wearer does not know the number that would fix it. That is a lockout
    // performed by a stranger with no knowledge of anything, which is exactly
    // what a PIN is supposed to prevent.
    //
    // So this asks for something only the owner knows, rather than something
    // the phone happens to be holding -- and the app is required to make the
    // person type it rather than filling it in from the keystore, or this check
    // would be theatre. Wrong answers count towards the same lockout as a
    // failed auth: it is the same secret being guessed at.
    if (!pinLegal(op) || op != gPin) {
      noteAuthFailure();
      sendEvent("pin_rejected", "\"why\":\"the current PIN is wrong\",\"locked_s\":"
                + String(lockoutLeftS()));
    } else if (!pinLegal(np)) {
      sendEvent("pin_rejected", "\"why\":\"six digits\"");
    } else if (np == op) {
      sendEvent("pin_rejected", "\"why\":\"that is already the PIN\"");
    } else {
      // Getting the old one right is itself proof of the owner, so it clears
      // any lockout the way a successful auth does. Otherwise somebody who
      // fumbled their way into a fifteen-minute wait could not use the one
      // screen that proves who they are.
      gAuthFails   = 0;
      gLockedUntil = 0;
      np.toCharArray(gPin, sizeof(gPin));
      configSave();
      applyPin();
      // The bonds are deliberately LEFT ALONE.
      //
      // A new passkey only governs the NEXT pairing; the phones already bonded
      // keep working keys, so clearing bonds here would break the link this
      // command arrived on and every other phone in the family with it -- and
      // Android would then refuse to reconnect with a stale bond of its own,
      // which takes a trip into Bluetooth settings to clear. Nobody should
      // have to do that to change a PIN.
      //
      // Access is still revoked, because the second lock does it: every one of
      // those phones now fails {"c":"auth"} and gets hung up on until somebody
      // types the new six digits into the app. That is the whole reason for
      // having a second lock. Use {"c":"unpair"} to drop the keys as well.
      sendEvent("pin_set");
      feedback(2, 90, 90);
    }

  } else if (c == "unpair") {
    // Forget every phone that has ever paired. The heavy option, for a band
    // being handed on or one that bonded to a handset that no longer exists.
    // The current link goes with it -- its keys were in there too.
    sendEvent("unpaired");
    feedback(3, 120, 100);
    delay(50);                       // same reason as the auth refusal above
    Bluefruit.Periph.clearBonds();
    Bluefruit.disconnect(Bluefruit.connHandle());
#if HAS_IMU
  // ---- the calibration stream ----------------------------------------------
  //
  // `{"c":"imucal","on":1}`. Prints `ms,g,fall_stage,impact_stage` at 100 Hz to
  // USB serial and to nothing else, so it cannot get anywhere near the BLE
  // link. Paste the capture into a spreadsheet, plot column 2, and the drop you
  // just did is the dip and the spike -- which is the only way to choose
  // FALL_IMPACT_G and IMPACT_G honestly. docs/FALL_AND_ACCIDENT.md is the
  // protocol; the header below is what a plotter expects to see first.
  } else if (c == "imucal") {
    gImuCsv = jsonInt(line, "on", 1) != 0;
    if (gImuCsv) Serial.println(F("ms,g,fall_stage,impact_stage"));
    else         Serial.println(F("{\"t\":\"log\",\"msg\":\"imu csv off\"}"));
#endif
  }
}

// ----------------------------------------------------- THE ADVERTISEMENT ---
//
// Rebuilt rather than edited, because the SoftDevice takes the payload as one
// blob -- there is no way to change six bytes of it in place.
//
// The 31-byte budget, exactly:
//
//     flags                        3
//     128-bit NUS service UUID    18
//     manufacturer data (6)        8
//                                 --
//                                 29
//
// addTxPower() used to hold the last 3 and is gone. Nothing ever read it: the
// app scans on the service UUID and takes the name out of the scan response.
// It was the one field in here that was pure decoration, and the beacon does
// not fit without those bytes.
void buildAdvertising() {
  uint8_t mfg[6] = {
    SOS_BEACON_COMPANY_LO, SOS_BEACON_COMPANY_HI,
    SOS_BEACON_MAGIC_0,    SOS_BEACON_MAGIC_1,
    (uint8_t)(gSosBeacon ? 1 : 0),
    gSosSeq,
  };

  Bluefruit.Advertising.clearData();
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.Advertising.addManufacturerData(mfg, sizeof(mfg));
}

/**
 * Put the SOS flag up, or take it down, and get it on the air.
 *
 * The payload is rebuilt on both paths, connected or not. While a link is up
 * the radio is not advertising -- but `restartOnDisconnect(true)` will put
 * whatever sits in this buffer straight back on the air the moment the link
 * drops, so leaving a stale flag in it is how a band ends up crying about an
 * emergency that was answered an hour ago.
 *
 * Advertising is only stopped and restarted when it is actually running.
 * Touching a live advertisement is what makes a payload change reach the
 * radio; doing it mid-connection is not needed and is not free.
 */
void setSosBeacon(bool on) {
  if (on) {
    gSosSeq++;                       // a second press must not dedup as the first
    gSosBeaconAt = millis();
  }
  gSosBeacon = on;

  if (!gConnected) Bluefruit.Advertising.stop();
  buildAdvertising();
  if (!gConnected) Bluefruit.Advertising.start(0);
}

// ------------------------------------------------------- BLE CALLBACKS ---
void connect_callback(uint16_t conn_handle) {
  gConnected = true;
  // Longer connection interval once linked: this is most of the idle current
  // the 1-2 week budget depends on (F4.3). Units of 1.25 ms -> 30-60 ms.
  BLEConnection *c = Bluefruit.Connection(conn_handle);
  if (c) c->requestConnectionParameter(24, 48);

  // A connection is not a phone yet. Everything that used to happen here --
  // taking the SOS beacon down, the buzz, link_up -- moved to authOk(), which
  // is the first moment anything is actually known about who this is.
  gAuthed       = false;
  gAuthTries    = 0;
  gAuthDeadline = millis() + LINK_SETTLE_MS;

  // The negotiated MTU, on the wire, at the one moment it is knowable. 23 means
  // lines will be chunked and this build is missing configPrphBandwidth; 247
  // means any line fits in a single notification. It doubles as proof of which
  // firmware is actually running after a flash.
  Serial.println("{\"t\":\"log\",\"msg\":\"link up\",\"mtu\":"
                 + String(c ? c->getMtu() : 0) + "}");
}

void disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  (void) conn_handle; (void) reason;
  gConnected = false;
  // Not persisted, and cleared here rather than at the next connect, so there
  // is no window in which a fresh connection inherits the last one's standing.
  gAuthed       = false;
  gAuthTries    = 0;
  gAuthDeadline = 0;
  // restartOnDisconnect(true) re-advertises for us.
}

/**
 * The phone subscribed to notifications.
 *
 * On this firmware that is a bigger event than it sounds: TXD's CCCD needs an
 * encrypted, MITM-protected link, so reaching this callback at all means the
 * six digits were accepted and the pairing went through. It is also the first
 * instant a notification has anywhere to go -- asking for the PIN from
 * connect_callback() would write into a subscription that does not exist yet.
 */
void notify_callback(uint16_t conn_handle, bool enabled) {
  (void) conn_handle;
  if (!enabled || gAuthed) return;

  uint32_t strict = millis() + AUTH_WINDOW_MS;
  if (gAuthDeadline == 0 || strict < gAuthDeadline) gAuthDeadline = strict;

  sendRaw("{\"t\":\"evt\",\"e\":\"need_auth\"}");
}


// ------------------------------------------------------------- SETUP ---
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  ledWrite(false);
  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);
  pinMode(PIN_LINK_LED, OUTPUT);
  linkLedWrite(false);

  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);   // don't hang on battery

  batteryBegin();
  gBattery = batteryPercent(batteryMilliVolts());

  // ---- who this band is ---------------------------------------------------
  InternalFS.begin();
  configLoad();

  // ---- the way out of a forgotten PIN -------------------------------------
  //
  // Held through boot and kept held. It has to be a gesture no wrist can make
  // by accident and no radio can make at all: the band must be in somebody's
  // hand, connected to nothing, for five seconds. Anything reachable over the
  // air would be a lock with its own key taped to it.
  //
  // delay() is fine here and nowhere else in this file -- loop() has not
  // started, there is no pattern to play and no link to service.
  bool wipe = false;
  if (digitalRead(PIN_BTN) == LOW) {
    uint32_t held = millis();
    while (digitalRead(PIN_BTN) == LOW && millis() - held < FACTORY_RESET_HOLD_MS) {
      ledWrite(((millis() / 150) & 1) != 0);      // fast blink: keep holding
      delay(10);
    }
    wipe = (digitalRead(PIN_BTN) == LOW);
    ledWrite(false);
  }
  if (wipe) {
    InternalFS.format();
    snprintf(gName, sizeof(gName), "%s", DEVICE_NAME);
    snprintf(gPin,  sizeof(gPin),  "%s", DEFAULT_PAIR_PIN);
    Serial.println("{\"t\":\"log\",\"msg\":\"factory reset: name and PIN back to default\"}");
  }

  // MUST come before begin() -- it sizes the SoftDevice's connection config,
  // which is fixed once the stack is up.
  //
  // Two defaults were breaking every notification this band sent. The MTU
  // defaults to 23, so an 86-byte heartbeat had to go out as five separate
  // notifications; and the notification TX queue defaults to a depth of ONE,
  // so the second of those five was refused, BLEUart::write() gave up at the
  // first refusal, and the remaining ~63 bytes were dropped without a word.
  // The phone received `{"t":"evt","e":"hb",` and never the newline that ends
  // the line, so it buffered fragments forever and parsed nothing.
  //
  // BANDWIDTH_MAX raises both: a 247-byte MTU, which fits any line this
  // firmware sends in a single packet, and a deeper queue for when it cannot.
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);

  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);

  // The passkey Android will ask for. It must be set before anything can pair,
  // and it is re-set from here on every boot because the SoftDevice does not
  // remember it -- gPin does, on flash.
  applyPin();
  if (wipe) Bluefruit.Periph.clearBonds();     // a reset forgets phones too

  bleuart.begin();
  // Fired when the phone subscribes, which on this build means pairing already
  // succeeded. That is where the band asks for the PIN.
  bleuart.setNotifyCallback(notify_callback);

  // The name goes in the scan response: the 128-bit NUS UUID costs 18 of the
  // advertising packet's 31 bytes and a name will not fit alongside it.
  // applyName() sets the GAP name and builds the response together, so the two
  // can never disagree about what this band is called.
  applyName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);   // 20 ms fast / 152.5 ms slow
  Bluefruit.Advertising.setFastTimeout(30);
  buildAdvertising();
  Bluefruit.Advertising.start(0);               // 0 = advertise forever
  gAdvStarted = true;                           // renames may bounce it now

#if HAS_IMU
  imuBegin();
#endif

  feedback(2, 120, 100);
  Serial.println(String("{\"t\":\"log\",\"msg\":\"Nigehban band up, advertising\",\"name\":\"")
                 + gName + "\",\"defpin\":" + String(usingDefaultPin() ? 1 : 0) + "}");
  // Printed once, on the bench, over USB -- never over the radio. This is how
  // you find out what a band's PIN is when you are holding it and have
  // forgotten, without having to reset it.
  if (usingDefaultPin()) {
    Serial.println("{\"t\":\"log\",\"msg\":\"PIN is the one published in the repo "
                   "(123456) -- change it from the app\"}");
  }
}

// -------------------------------------------------------------- LOOP ---
void loop() {
  uint32_t now = millis();

  buttonTick(gBtn);
  feedbackTick();
  deferredTick();     // releases an outcome buzz once the tick has finished
  outcomeTick();      // the phone never answered: say so rather than nothing
  linkLedTick();      // standing "am I linked", independent of the motor
#if HAS_IMU
  imuTick();
#endif

  // ---- phone -> band, newline-delimited
  //
  // The app terminates every command with '\n', so the accumulate-to-newline
  // path is the real one. The idle flush below exists because generic BLE
  // clients -- nRF Connect above all -- send exactly what you typed and no
  // newline, and without it a hand-written {"c":"ping"} sits in the buffer
  // forever and the band looks dead. Bench tooling has to work too.
  //
  // 200 ms is far longer than the gap between fragments of one MTU-split write
  // and far shorter than a human retyping, so it cannot cut a real line in half.
  static uint32_t lastRxByte = 0;
  while (bleuart.available()) {
    char c = (char) bleuart.read();
    lastRxByte = now;
    if (c == '\n' || c == '\r') {
      gRxLine.trim();
      if (gRxLine.length()) handleCommand(gRxLine);
      gRxLine = "";
    } else if (gRxLine.length() < 200) {
      gRxLine += c;
    }
  }
  if (gRxLine.length() && (now - lastRxByte) > 200) {
    gRxLine.trim();
    if (gRxLine.length()) handleCommand(gRxLine);
    gRxLine = "";
  }

  // The PIN never came, or never came right. Hang up and go back to
  // advertising, because the band's one connection slot is occupied by
  // something that cannot help the person wearing it -- and while it is
  // occupied, the phone that can is locked out.
  if (gConnected && !gAuthed && gAuthDeadline != 0 && now > gAuthDeadline) {
    gAuthDeadline = 0;
    Serial.println("{\"t\":\"log\",\"msg\":\"auth window expired, hanging up\"}");
    Bluefruit.disconnect(Bluefruit.connHandle());
  }

  // connection edges
  if (gConnected != gWasConnected) {
    gWasConnected = gConnected;
    if (gConnected) {
      // Nothing is announced and nothing is felt. The wearer is not linked to
      // anything yet -- see authOk(), which owns the buzz and the link_up now.
      Serial.println("{\"t\":\"log\",\"msg\":\"connected, awaiting auth\"}");
    } else if (!gWasAuthed) {
      // A connection that never proved itself, now gone. The wearer was never
      // linked, so there is nothing to tell them about it going away -- and
      // buzzing here would let anybody in range make this band twitch on their
      // wrist just by connecting to it and walking off.
      Serial.println("{\"t\":\"log\",\"msg\":\"unauthenticated link gone\"}");
    } else if (gOutcomeDueAt != 0) {
      // The link died while we were waiting to hear whether the press got out.
      // It did not, and there is no longer anything that could tell us
      // otherwise, so say so now rather than sitting out the 4 s timeout.
      //
      // This also closes the one dangerous collision in the vocabulary: the
      // ordinary link-down buzz is 2 x 80/80 and "delivered" is 2 x 90/70,
      // which no wrist can tell apart. Those two can only be confused in this
      // exact window -- pressed, waiting, link drops -- and here the long
      // FAILED buzz replaces the link-down buzz entirely. Outside this window
      // "delivered" has no press to refer to, so there is nothing to mistake
      // it for.
      outcomeFailed();
      Serial.println("{\"t\":\"log\",\"msg\":\"link down while awaiting outcome\"}");
    } else {
      feedback(2, 80, 80);
      Serial.println("{\"t\":\"log\",\"msg\":\"link down, advertising again\"}");
    }
    // Consumed, not cleared in the callback: this edge is the only reader, and
    // clearing it in disconnect_callback() would race loop() and turn every
    // real link-down buzz into silence.
    if (!gConnected) gWasAuthed = false;
  }

  // The SOS flag comes down on its own after SOS_BEACON_MS.
  //
  // Nothing else would ever take it down if the phone simply never arrives --
  // flat battery, left at home, uninstalled. A band still advertising an
  // emergency tomorrow morning is a band whose next real SOS nobody believes.
  if (gSosBeacon && (now - gSosBeaconAt) > SOS_BEACON_MS) {
    setSosBeacon(false);
    Serial.println("{\"t\":\"log\",\"msg\":\"sos beacon expired\"}");
  }

  // missed check-in: phone owns the real escalation
  //
  // Checked BEFORE the nag below, so the deadline always wins. A nag fired in
  // the same millisecond the window closed would buzz "answer me" at somebody
  // whose family is already being called.
  if (gAwaitingAck && now > gAckDeadline) {
    gAwaitingAck = false;
    gNextNagAt   = 0;
    feedback(5, 350, 200);
    sendEvent("checkin_missed");
  }

  // Still waiting: ask again.
  //
  // The reminder the wearer actually needs. One buzz at the top of the window
  // is easy to sleep through, and the price of sleeping through it is a false
  // alarm sent to the whole family -- so the question repeats, and tightens as
  // the deadline approaches, until a single press answers it.
  if (gAwaitingAck && gNextNagAt != 0 && now >= gNextNagAt) {
    feedback(2, 400, 250);              // the check-in pattern, one pulse shorter
    uint32_t left = (gAckDeadline > now) ? (gAckDeadline - now) : 0;
    gNextNagAt = now + (left <= CHECKIN_URGENT_AT_MS ? CHECKIN_NAG_URGENT_MS
                                                    : CHECKIN_NAG_MS);
  }

  // heartbeat
  if (now - gLastHeartbeat > HEARTBEAT_MS) {
    gLastHeartbeat = now;
    uint16_t mv = batteryMilliVolts();
    if (!gBatteryForced) gBattery = batteryPercent(mv);
    sendEvent("hb", "\"up\":" + String(now / 1000) + ",\"mv\":" + String(mv));
  }
}
