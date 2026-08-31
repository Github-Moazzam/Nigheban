/* ============================================================================
   NIGEHBAN — TEST 6: DOES THE RADIO WORK?
   ----------------------------------------------------------------------------
   No wiring. The onboard LED is the only output. This is F1.2 + F1.3 and it is
   the LAST unknown before the port: T1-T4 proved the board, the motor, the
   button and the IMU, so if this passes, nothing in nigehban_band_nrf52/ is a
   guess any more.

   Isolates ONE thing: Bluefruit's BLEUart speaking the same Nordic UART Service
   the app already speaks. No buttons, no motor, no IMU, no JSON schema -- so a
   failure here is the radio and nothing else.

   WHAT YOU NEED
     nRF Connect (Nordic) on a phone. Free, iOS and Android. The Nigehban app is
     NOT needed and must not be involved -- the whole point is to prove the band
     side alone.

   PASS, in three parts:

     1. ADVERTISING (F1.2)
        nRF Connect -> SCAN. `Nigehban-01` appears. Kill this and nothing else
        matters.

     2. CONNECT
        Tap CONNECT. The onboard LED goes SOLID and serial logs link_up.
        The phone lists a service ending 6E400001 with two characteristics.

     3. UART BOTH WAYS (F1.3)
        Open the 6E400003 characteristic (TX, band -> phone) and enable
        notifications -- the three-arrows icon. A heartbeat line arrives every
        5 s. Then write any text to 6E400002 (RX, phone -> band) and it comes
        straight back as an echo line.

        Send as UTF-8 / TEXT, not hex.

   Both directions working = the transport under the frozen protocol is proven,
   and F2 becomes a port instead of an experiment.

   ------------------------------------------------------------------------
   WHY THE NAME IS IN THE SCAN RESPONSE

   A BLE advertising packet is 31 bytes. The NUS UUID is a 128-bit one, which
   costs 18 of them, and the flags cost 3. "Nigehban-01" needs 13 more. That is
   32 -- one byte over, and addName() would silently fail to fit.

   So the UUID advertises and the name goes in the scan response, which is a
   second 31-byte packet the phone asks for. Both are seen by any normal scan;
   nRF Connect shows the name exactly as if it had been in the first packet.

   If you ever rename the band and it stops appearing by name, this is why.
   ========================================================================= */

#include <Adafruit_TinyUSB.h>   // USB CDC. Without it `Serial` fails to LINK.
#include <bluefruit.h>

#define DEVICE_NAME   "Nigehban-01"
#define HEARTBEAT_MS  5000

BLEUart bleuart;                // this IS the Nordic UART Service

uint32_t gLastHeartbeat = 0;
uint32_t gSeq           = 0;
String   gRxLine;               // accumulates until '\n'

// The LED is ACTIVE LOW on this board: LOW lights it.
void led(bool on) { digitalWrite(LED_BUILTIN, on ? LOW : HIGH); }

// Mirrors to USB serial always, so the test still tells you something when the
// phone is the broken half.
void send(const String &json) {
  Serial.println(json);
  if (Bluefruit.connected()) {
    String line = json + "\n";
    bleuart.write(line.c_str(), line.length());
  }
}

void connect_callback(uint16_t conn_handle) {
  char name[32] = {0};
  Bluefruit.Connection(conn_handle)->getPeerName(name, sizeof(name));
  led(true);
  send(String("{\"t\":\"log\",\"msg\":\"link_up\",\"peer\":\"") + name + "\"}");
}

void disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  (void) conn_handle;
  led(false);
  // restartOnDisconnect(true) re-advertises for us -- nothing to do here.
  Serial.print(F("{\"t\":\"log\",\"msg\":\"link_down\",\"reason\":\"0x"));
  Serial.print(reason, HEX);
  Serial.println(F("\"}"));
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  led(false);

  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);   // don't hang on battery
  Serial.println(F("T6: BLE bring-up. Scan for Nigehban-01 in nRF Connect."));

  Bluefruit.begin();
  Bluefruit.setName(DEVICE_NAME);
  Bluefruit.setTxPower(4);          // valid nRF52840 step; see bluefruit.h
  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);

  bleuart.begin();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.ScanResponse.addName();               // see the header note
  Bluefruit.Advertising.restartOnDisconnect(true);
  // Units of 0.625 ms: 32 = 20 ms fast, 244 = 152.5 ms slow. The slow interval
  // is most of the idle current the 1-2 week battery budget rests on (F4.3).
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);       // seconds at the fast rate
  Bluefruit.Advertising.start(0);                 // 0 = advertise forever

  Serial.println(F("{\"t\":\"log\",\"msg\":\"advertising\"}"));
}

void loop() {
  uint32_t now = millis();

  // ---- phone -> band. Accumulate to '\n' and echo the line back.
  // The real firmware hands this to handleCommand(); here it only proves bytes
  // survive the round trip. Note nRF Connect does not append a newline, so we
  // also flush on a short idle -- otherwise a write with no '\n' sits forever.
  static uint32_t lastByte = 0;
  while (bleuart.available()) {
    char c = (char) bleuart.read();
    lastByte = now;
    if (c == '\n' || c == '\r') {
      if (gRxLine.length()) {
        send("{\"t\":\"echo\",\"rx\":\"" + gRxLine + "\"}");
        gRxLine = "";
      }
    } else if (gRxLine.length() < 120) {
      gRxLine += c;
    }
  }
  if (gRxLine.length() && (now - lastByte) > 200) {
    send("{\"t\":\"echo\",\"rx\":\"" + gRxLine + "\"}");
    gRxLine = "";
  }

  // ---- band -> phone. Proves notify works without you touching anything.
  if (now - gLastHeartbeat > HEARTBEAT_MS) {
    gLastHeartbeat = now;
    send("{\"t\":\"hb\",\"seq\":" + String(++gSeq) +
         ",\"up\":" + String(now / 1000) + "}");
  }

  // No delay() anywhere -- the habit F4.3 requires of the shipping firmware.
}
