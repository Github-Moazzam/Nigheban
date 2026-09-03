# The band's PIN, and the band's name

Two changes to the same idea: the wristband stops being an anonymous open radio
that answers to anybody, and starts being *this person's band*, with a name they
chose and a lock only they can open.

Both live on the nRF52 itself, in a two-line file on its internal flash, and
both are changeable from the app. Neither survives a factory reset, which is the
point of having one.

**Status: observed working on hardware, 3 Sep 2026** — XIAO nRF52840 Sense,
Samsung / Android 14, release APK. First link asks for the passkey through
Android's own dialog and then for the same six digits through the app; both
appear exactly once per phone.

---

## Why the band needed locking at all

Before this, the band advertised the Nordic UART Service with both
characteristics wide open. Anybody within about ten metres, with nRF Connect and
no special knowledge, could:

- connect to it, which alone takes the band off the air — it advertises only
  while unconnected, so the wearer's own phone can no longer find it;
- subscribe to its notifications and watch every press, every heartbeat, every
  fall and every battery reading;
- write `{"c":"alarm"}` and make it buzz for twenty pulses, or
  `{"c":"buzz"}` repeatedly until the cell is flat.

For a safety device worn by somebody who may already be being followed, the
second of those is a tracking channel and the third is a way to disarm the
device without touching it.

---

## Two locks, and why not one

### Lock 1 — BLE pairing with a passkey

The UART characteristics now require an encrypted, MITM-protected link:

```
_txd.setPermission(SECMODE_ENC_WITH_MITM, SECMODE_NO_ACCESS);   // -> the CCCD
_rxd.setPermission(SECMODE_NO_ACCESS, SECMODE_ENC_WITH_MITM);
```

`_txd` is notify-only, so its own value is never read — but Bluefruit copies a
characteristic's `read_perm` onto its **CCCD's write permission**, and the CCCD
is what a phone writes to subscribe. That single line is what makes Android pop
its passkey dialog at the moment the app asks for notifications.

This is real cryptography and it protects everything on the wire. What it cannot
do is expire. A bond survives the app being uninstalled, the phone being sold,
and the handset being stolen — the keys sit in the band and in Android, and
neither has any idea the relationship ended.

### Lock 2 — the auth handshake

So the band also stays mute until the app says, over that encrypted link:

```json
{"t":"cmd","c":"auth","pin":"481923"}
```

Until it does, the firmware sends no events, obeys no commands, keeps its SOS
beacon flying and does not flash the link LED. Wrong PIN three times, or no PIN
inside the window, and it hangs up.

#### The limit that actually costs an attacker something

`AUTH_MAX_TRIES` only ends a *connection*, and on its own that is close to
worthless: reconnecting is free and unlimited, so three guesses per link is
really unlimited guesses and a six-digit PIN falls to a patient script.

So failures are also counted **across** connections, and past a threshold the
band stops answering:

| consecutive failures | what happens |
|---|---|
| 1–4 | nothing but a refusal |
| 5 | 30 s of silence |
| 6 | 2 min |
| 7 | 5 min |
| 8 and beyond | 15 min, indefinitely |

Five free attempts before any of it starts, deliberately: the person most likely
to get this wrong is the owner typing from memory, and the first thing a lockout
must not do is punish them. A correct PIN clears the counter outright, and so
does a correct *old* PIN on the change-PIN screen — otherwise somebody who
fumbled into a fifteen-minute wait could not reach the one screen that proves
who they are. Guessing *during* a lockout costs nothing extra, so waiting is
always the winning move for an owner and never shortens anything for an attacker.

**The counter is deliberately not persisted.** It lives in RAM, so a power cycle
clears it — and that is not the hole it looks like. Power-cycling this band means
holding it, and anybody holding it can hold the button through boot and factory
reset the PIN outright. A flash write per wrong guess would buy nothing against
an attacker who already has the better option, and would spend the flash's erase
budget doing it.

> **Safety cost, stated plainly.** While locked out the band cannot link to a
> phone, so a press cannot reach the family over BLE. That is the price of
> having a lock at all. It is bounded three ways — five free tries, a
> fifteen-minute ceiling, and the factory reset, which works during a lockout
> like any other time.

The handshake is what makes **changing the PIN mean something**. A new passkey
only governs the *next* pairing, so phones already bonded would sail straight
through lock 1 forever. They now fail lock 2 instead, and are locked out the
moment the PIN changes — with nobody having to go into Android's Bluetooth
settings on any of the phones involved.

### The order they run in

```
phone: connect, discover services
phone: subscribe to TXD  ──▶ Android shows the passkey dialog  (lock 1)
band:  {"t":"evt","e":"need_auth"}
phone: {"t":"cmd","c":"auth","pin":"481923"}                    (lock 2)
band:  {"t":"evt","e":"auth_ok","name":"Ayesha's band","defpin":0}
       ...heartbeats, presses, everything else...
```

Two deadlines guard it. `LINK_SETTLE_MS` (60 s) runs from connect and is
generous, because a person is reading six digits and typing them into a system
dialog. `AUTH_WINDOW_MS` (8 s) starts when the phone subscribes — pairing is
done by then and the handshake is one automatic round trip. Whichever expires
first hangs the connection up, so an idle unauthenticated peer cannot squat on
the band's only connection slot and keep the real phone locked out.

---

## What "connected" now means

`band.status === 'connected'` means paired **and** authenticated. Everything
that used to fire when the radio link came up now fires from `authOk()`:

| | before | now |
|---|---|---|
| the link-up buzz | on connect | on auth |
| `link_up` event | on connect | on auth |
| SOS beacon comes down | on connect | on auth |
| link LED says "linked" | `gConnected` | `gAuthed` |

The beacon one matters most. It is the path that exists *because* the app is
not there; letting any connection switch it off would mean an attacker could
silence a cry for help by connecting to the band and walking away.

New app-side states, all of which mean "the radio is fine, a person has to do
something":

- `pairing` — Android's passkey dialog is up, or about to be
- `authenticating` — paired, proving this phone
- `needs-pin` — no PIN stored on this phone yet
- `bad-pin` — the band refused these six digits
- `pair-failed` — Android and the band disagree about pairing (see below)
- `old-firmware` — the band never asked for a PIN and ignored the handshake
- `locked-out` — too many wrong PINs; the band has stopped listening for a
  while. Distinct from `bad-pin` because the answer is different: waiting fixes
  this and typing does not.

### The first operation always fails, and that is normal

Android does not pair on connect. It pairs the first time an operation touches
an attribute that demands it: it fails **that** operation with
`InsufficientAuthentication`, puts its own passkey dialog up, and never returns
to what it was doing. On this band the subscribe is that operation, so the first
link to a band the phone has never met *always* errors once.

Two things follow, and both were bugs before they were understood:

1. **The subscribe must be re-offered.** `subscribe()` in `band.js` is a named
   function for exactly this reason, retried every `PAIR_RETRY_MS` for
   `PAIR_RETRY_BUDGET_MS` — a budget sized for a person finding the
   notification, reading six digits and typing them, not for a radio. Without
   it the app reported "the band sent nothing" about a band that was waiting
   politely to be let in.

2. **The auth write must not be sent early.** `{"c":"auth"}` goes to RXD, which
   needs the same encryption, so sending it straight after `subscribe()` races
   the same dialog and is refused the same way. It is driven by the band's
   `need_auth` instead — which the firmware sends from the CCCD-write callback,
   and *that* cannot fire until the subscription is live, which cannot happen
   until pairing succeeded. The trigger is a guarantee, not a hope.

Classify these on `attErrorCode` (5, 8, 12, 15), never on `errorCode`.
`errorCode` says which operation failed — 403 is `CharacteristicNotifyChangeFailed`,
not "not authorized", and reading it as the latter silently classifies every
pairing as a hardware fault.

### Where the PIN is asked for

Both the wearer's **Setup** screen (`user/UserSettings.js`) and the **Band
console** mount a PIN field, and Home labels the state. That is not duplication
for its own sake: the console is a diagnostics screen, and a wearer connects
her band from Setup. A gate that reports "Needs its PIN" on the screen someone
is actually looking at, with the input somewhere else, is not a gate — it is a
dead end.

`needs-pin` and `bad-pin` **stop the reconnect loop**. Retrying cannot help, and
the loop actively hurts: the band hangs up on an unauthenticated link after a
few seconds, so the app would reconnect, fail and reconnect, cycling the status
underneath somebody halfway through typing.

---

## Renaming

`{"c":"setname","name":"Ayesha's band"}` writes the name to flash, calls
`Bluefruit.setName()`, rebuilds the scan response and bounces the advertisement.
So the new name shows up in the app, in Android's Bluetooth list, in nRF Connect
and on every other phone in the family — it is the band's real BLE name, not a
label on one handset.

Rules, enforced identically in `nameLegal()` on both sides:

- 1–20 characters (the scan response is 31 bytes and a name costs its length
  plus two);
- printable ASCII only, no `"` and no `\`. The firmware's JSON parser finds a
  value by scanning to the next quote, so a name containing one would truncate
  every line the band ever sends.

**The app's scan no longer filters on the name.** It used to skip anything not
starting with `Nigehban-`, which would go blind on the first rename. The NUS
service UUID is the identity, it rides in the advertising packet rather than the
scan response, and it is what the OS-level scan filter matches.

---

## Changing the PIN

`{"c":"setpin","old":"123456","pin":"481923"}` — six digits, because
`BLE_GAP_PASSKEY_LEN` is 6 and this same string is handed to the SoftDevice as
the pairing passkey.

**The current PIN must be supplied, and the app must make a person type it.**
Being authenticated is not enough and never was: a link stays authenticated for
as long as it stays up, so anybody who picked up an unlocked phone with a live
band on it could set a new PIN and own the band — the wearer's other phones stop
authenticating, and the wearer does not know the number that would fix it. That
is a lockout performed by a stranger with no knowledge of anything, which is
precisely what a PIN is supposed to prevent. Pre-filling the field from the
keystore would make the check theatre, so neither screen does it. Wrong answers
count towards the same lockout as a failed `auth` — it is the same secret being
guessed at.

The app stores the new PIN only once the band has **confirmed** it, in the
`pin_set` branch. The old order — save first, then ask — was safe while the band
accepted every `setpin` and stopped being safe the moment it could refuse one:
mistyping the current PIN would have left the phone holding a PIN the band never
agreed to, and the next reconnect failing against it. If the confirmation is lost
in flight instead, the band has the new PIN and the phone the old one, which
surfaces as an ordinary `bad-pin` prompt somebody can answer.

Bonds are deliberately **not** cleared. Clearing them would break the link the
command arrived on, and Android would then be holding a bond the band has
forgotten, which takes a trip into system settings to clear on every phone in
the family. Access is revoked anyway, by lock 2. `{"c":"unpair"}` is there for
when dropping the keys really is what you want.

> This is **not** the four-digit disarm PIN in `src/security.js`. That one
> protects the wearer *from* the phone in somebody else's hand; this one protects
> the band *from* everybody else's phone. Different secret, different length,
> different threat.

---

## Disconnecting on purpose forgets the PIN

`disconnect()` in `band.js` clears the stored PIN. Nothing else does — and the
distinction is the whole point:

| how the link ended | PIN kept? | comes back by itself? |
|---|---|---|
| out of range, signal lost, app killed, phone rebooted | yes | yes, silently |
| the wearer pressed **Disconnect** | **no** | no — asks for the six digits |
| sign-out | **no** | no |

Automatic drops go through `onDisconnected()` and `retrySoon()`, which never
touch the keystore, so a wearer who steps into a lift or leaves her phone in
another room gets her band back without typing anything. That path has to stay
silent or the lock becomes a reason to stop wearing the band.

A deliberate unlink is different in kind. It is the one moment somebody has said
"this phone and that band are finished", and a stored PIN is exactly what would
let any hand holding the phone put them back together while knowing nothing. So
it goes, and that is what makes Disconnect a real answer to "somebody else has
my phone" rather than a cosmetic one.

Sign-out gets this for free and wants it: `App.js` already disconnects there so
the next account cannot inherit the last one's wristband.

Because it is now destructive, the wearer's Setup screen confirms it first. The
admin console does not — the person on a console meant to press the button —
but it says what will happen.

---

## Where the wearer changes these

Both settings live in **Setup → DEVICE**, as rows that expand in place:

- **Band name** — free text, up to 20 characters, written to the wristband.
- **Band PIN** — typed twice, and the row reads "Change it" in amber for as
  long as the band is still on the published factory PIN.

Both only appear while the band is actually connected, because both are commands
written to the wristband — offering them against a band that is not there would
be offering a control that silently does nothing. The PIN row additionally
requires `canSetPin`, so it is hidden when this phone *is* the band: there is
nobody to keep out, and a lock that locks nothing is worse than no lock.

The admin console (`screens/Band.js`) has the same two, plus **Forget paired
phones** (`{"c":"unpair"}`), which is a recovery tool rather than a setting.

---

## The way out — a legitimately forgotten PIN

Two routes, in the order to try them.

### 1. Ask a phone that still has it

Any phone still linked to the band is holding the six digits in its keystore.
**Setup → DEVICE → Band PIN → Change it → "I have forgotten it"** shows them,
behind the four-digit **disarm PIN** — the gate this app already uses for "prove
you are the owner of this phone".

That gate is the right strength, not a compromise. Revealing the band PIN to
somebody already holding this unlocked, signed-in phone gives away nothing they
could not already do: the band is linked and obeys them. What it saves is the
alternative below, which costs a factory reset and re-pairing every phone in the
family. If the phone has no band PIN stored, the dialog says so and points at
the reset rather than pretending.

### 2. The band itself

Hold the band's button while it boots and keep holding for five seconds. Name,
PIN and every bond go back to factory, and the LED blinks fast while you hold so
you can tell it is counting. Then **forget the band in Android's Bluetooth
settings** on every phone, because their bonds are now stale.

It has to be physical. A reset reachable over the air is a lock with its own key
taped to it. It also works during a lockout, which is what stops a lockout ever
being permanent.

### What the band will not do

It prints its **name**, and whether it is still on the published factory PIN,
over USB serial at boot — never over the radio. It does **not** print the PIN
itself, and that is deliberate rather than an oversight.

Reading a PIN over USB and holding the button through boot both need physical
possession, so they look equivalent. They are not. A factory reset is *loud* —
the name is gone and every phone has to re-pair, so the owner finds out. Reading
the PIN is silent: an attacker with sixty seconds and a cable would walk away
with permanent, undetectable access to a band its owner still believes is
locked. The noisy recovery is the one worth having.

---

## Flashing an existing band

1. Flash the new sketch. The config lives in a flash region an upload does not
   touch, so a band that has already been named keeps its name.
2. A band flashed for the first time comes up as `Nigehban-02` on whatever
   `DEFAULT_PAIR_PIN` was set to. **Editing that line to your own six digits
   before flashing is the better path** — then the published `123456` never
   exists on your band and you type your own PIN at Android's dialog.

   The amber "factory PIN" banner keys off `PUBLISHED_PIN`, a separate frozen
   literal, *not* off `DEFAULT_PAIR_PIN`. So a band compiled with your own
   default is not nagged: the thing worth warning about is a PIN printed in a
   public repository, not a PIN that came from a `#define`.
3. On the phone: **forget the band in Android's Bluetooth settings first.** The
   old firmware needed no bond and the new one does; a phone reconnecting with
   a stale idea of the relationship fails encryption, which the app reports as
   `pair-failed`. Nothing in the app can clear an Android bond.
4. nRF Connect and `nigehban_hub.py` now need to pair too. The bench loop in
   `loop()` that flushes a line with no trailing newline is unchanged, so
   hand-typed commands still work — after pairing.

---

## What this does not do

The PIN is six digits. Six digits is 10⁶, and BLE legacy passkey pairing is
known to be brute-forceable by an attacker who captures the pairing exchange
itself — the passkey is not protected against a passive listener present at the
one moment two devices first pair. LESC would fix that and is a larger change:
Bluefruit's static-passkey path (`BLESecurity::setPIN`) sets `lesc = 0`
explicitly, so getting numeric comparison instead means giving up the fixed PIN
this whole feature is built around.

That is a real limitation and it is worth being plain about. What is closed here
is the case that actually happens: a stranger in range with a phone, connecting
to a band that used to let anyone in.
