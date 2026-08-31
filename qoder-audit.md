This is a major audit request spanning architecture, UI/UX, security, and strategy. I'll dispatch multiple Research agents in parallel to deeply investigate each dimension of your project, then synthesize their findings into a comprehensive report.
Now dispatching all four Research agents in parallel to investigate every dimension of the project.
Four Research agents are now auditing your project in parallel — Researcher Alex (backend/security), Researcher Sam (mobile app/BLE), Researcher Tina (UI/UX), and Researcher Eric (strategy/plan) — and I'll synthesize their findings into the full 4-phase report once they complete.Researcher Alex has completed the backend audit. Three other agents are still working — waiting for Researcher Sam, Researcher Tina, and Researcher Eric to finish before synthesizing the full report.
Waiting for the remaining three research agents to complete.
Researcher Tina's UI/UX audit is complete. Two agents still running — waiting for Researcher Sam (mobile app architecture) and Researcher Eric (strategy/plan) to finish.
Researcher Sam's mobile app audit is complete. Waiting for Researcher Eric (strategy/plan) to finish — the last remaining agent before I can synthesize the full report.
All four research agents have completed. Here is the full synthesized audit.

---

# Nigehban — 360-Degree Project Audit

---

## Phase 1: Architecture & Codebase Deep-Dive

### 1.1 Structural Flaws

**The server is a 1,861-line monolith.** [nigehban_server.py](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py) contains routing, business logic, database access, push delivery, geospatial math, rate limiting, WebSocket hub, and the sweeper background task — all in one file. There is zero module separation. Any change to alert logic risks breaking the sweeper, and vice versa.

**The app's root component is a 1,268-line god component.** [App.js](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/App.js) owns the entire state graph (16+ `useState`, 14+ `useEffect`, 7+ `useCallback`), every safety callback (raise, resolve, ackCheckin, toggleHighAlert, cancelFall, escalateFall), WebSocket routing, battery monitoring, background service orchestration, offline queue flushing, the alarm lifecycle, and the full UI tree. Testing this in isolation is impossible.

**No navigation library — manual tab state.** Tabs are driven by `useState('home')` with conditional rendering ([App.js:42-48](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/App.js#L42-L48)). Every tab switch unmounts and remounts the target screen, destroying scroll position, form input, and pending fetches. The declared deep-link scheme (`nigehban://` in [app.json:92](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/app.json#L92)) is non-functional without a navigation stack.

**Module-scope singleton BLE state.** [band.js:99-137](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/band.js#L99-L137) uses twelve mutable `let` variables at module scope (`manager`, `linked`, `connecting`, `retryTimer`, etc.). This is deliberate and documented, but makes the module untestable, leaks connections on hot reload, and will break if `useBand` is ever mounted in two component trees simultaneously.

**Duplicated BLE parsing logic.** [band.js:386-397](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/band.js#L386-L397) and [bandLink.js:65-77](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/bandLink.js#L65-L77) contain identical wire-protocol parsing. A protocol change requires updating both, and missing one creates silent divergence between BLE mode and virtual mode.

**Dead backup file ships an old insecure schema.** [nigehban_server.py.bak](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py.bak) is 1,622 lines of obsolete SQLite code with plaintext token storage (line 100: `token TEXT NOT NULL`). It should be deleted.

### 1.2 Performance & Security

**Live secrets committed to the workspace.** [.env](file:///c:/Users/MOAX/Desktop/Nigheban/.env) contains the Supabase anon key, the service role key (bypasses all RLS), and a trivially weak database password (`supabase1234554321`). Although `.gitignore` excludes `.env`, it's physically present and readable. Anyone with workspace access has full admin control over the database.

**Session token stored unencrypted.** [api.js:150-163](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/api.js#L150-L163) persists the bearer token via `AsyncStorage` — a plain SQLite file readable on rooted or backed-up devices. The PIN correctly uses `expo-secure-store` in [security.js:22-28](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/security.js#L22-L28), but the far more sensitive session token does not.

**WebSocket token in URL query parameter.** [nigehban_server.py:1795-1802](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L1795-L1802) passes the auth token as `/ws?token=...`, which leaks into server logs, ngrok inspector, and proxy traces.

**Bridge WebSocket has zero authentication.** [nigehban_bridge.py:182-206](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban_bridge.py#L182-L206) listens on `0.0.0.0:8765` with no token, no origin check, and no rate limit. Any LAN device can trigger the band alarm, falsely acknowledge check-ins, toggle anti-snatch mode, and read GPS coordinates.

**CORS allows all origins.** [nigehban_server.py:490-496](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L490-L496) sets `allow_origins=["*"]`. The inline comment acknowledges this is dev-only and "MUST be narrowed," but real user data (locations, emergency alerts) is already being stored.

**Minimum password length is 4 characters.** [nigehban_server.py:515-516](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L515-L516) — for a safety product protecting vulnerable people, this combined with 8-per-5-minute rate limiting is brute-forceable.

**Cleartext traffic enabled in production builds.** [app.json:56-58](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/app.json#L56-L58) sets `usesCleartextTraffic: true`, allowing the app to communicate over unencrypted HTTP with any server in production.

**No HTTPS on the server itself.** [nigehban_server.py:1860](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L1860) runs plain HTTP. TLS is entirely delegated to ngrok, but the banner actively encourages LAN connections where traffic is cleartext.

**Auth cache has no size bound.** [nigehban_server.py:103-104](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L103-L104) — `_AUTH_CACHE` is a `dict` that grows without bound. A script that logs in repeatedly creates unbounded entries with no eviction.

**WebSocket reconnect has no exponential backoff.** [api.js:301](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/api.js#L301) retries every 2.5s indefinitely during server outages — drains battery and radio on mobile.

**`nearby_strangers()` does a full table scan.** [nigehban_server.py:870-891](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L870-L891) loads all fresh presence rows into Python memory and computes haversine in a loop. The geohash index is created but never used for querying.

**No transactions around multi-statement DB mutations.** [nigehban_server.py:148](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L148) sets `autocommit=True` on all pooled connections. Operations like `link_both()` + invite update are not transactional — a crash between them leaves a half-linked state.

**No React Error Boundary.** [App.js:1251-1267](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/App.js#L1251-L1267) renders the root tree with no error boundary. An uncaught render error during an emergency produces a white screen.

### 1.3 Technical Debt

**No TypeScript — in a safety-critical application.** The entire codebase is plain JavaScript with zero type annotations. Every `?.` chain is a gamble that the developer remembered every optional field. [api.js:177](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/api.js#L177) returns untyped `data`; [state.js:134](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/state.js#L134) trusts `.id`, `.acks`, `._local`, `.kind` with no contract.

**Pervasive silent catch blocks.** Dozens of `catch { /* comment */ }` across all files — never with telemetry, crash reporting, or even `__DEV__` logging. In a safety app, these silent failures should be counted. Examples: [api.js:157](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/api.js#L157), [band.js:246-253](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/band.js#L246-L253), [notifications.js:362-364](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/notifications.js#L362-L364).

**No crash reporting or analytics.** No Sentry, no Bugsnag, no analytics SDK anywhere. It's impossible to know if the alarm path actually fires in production.

**Zero `devDependencies`.** [package.json](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/package.json) has no linter, no formatter, no type checker, no test runner.

**Event journal grows without bound.** [nigehban_hub.py:117-122](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban_hub.py#L117-L122) appends every event to `events.jsonl` with no rotation, max size, or compression.

**Health check is fake.** [nigehban_server.py:499-501](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L499-L501) returns `{"ok": True}` without checking database connectivity, pool status, or sweeper liveness.

**`scripts/db.py` is an unrestricted SQL executor.** [db.py:33-40](file:///c:/Users/MOAX/Desktop/Nigheban/scripts/db.py#L33-L40) runs arbitrary SQL from argv against production data with no guardrails.

**Notification handler registered twice.** [App.js:87-93](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/App.js#L87-L93) sets a handler at module load, then [notifications.js:227-248](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/notifications.js#L227-L248) overwrites it with a more complete one — making the first registration dead code.

**`alert.kind` field accepts any string.** [nigehban_server.py:443](file:///c:/Users/MOAX/Desktop/Nigheban/server/nigehban_server.py#L443) — arbitrary kinds are silently treated as severity 3 via the default dict fallback.

---

## Phase 2: UI/UX & Interaction Design Review

### 2.1 UX Friction

**SOS trigger is inconsistent between roles.** Admin Home ([Home.js:165](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Home.js#L165)) requires a 600ms long-press, while the user Dashboard ([Dashboard.js:297](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/Dashboard.js#L297)) uses a single tap. An admin building muscle memory for long-press then handing the phone to a user creates a dangerous mismatch in the one interaction that matters most.

**Auth screen is hostile to non-technical users.** [Auth.js:149](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Auth.js#L149) presents a server address field with `abc123.ngrok-free.app` as placeholder. For elderly Pakistani users, this is intimidating. The "Find my laptop on this Wi-Fi" button helps but only on the same network.

**No password recovery flow exists.** Nowhere in the app can a user reset a forgotten password.

**User shell has no dedicated Family tab.** [UserShell.js:144-153](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/UserShell.js#L144-L153) offers only 3 tabs. Family management is only accessible by scrolling past the SOS button to member cards on the Dashboard. "Request Check-in" is buried.

**No onboarding walkthrough.** A first-time user sees the Dashboard with no family members and an SOS button that has nowhere to send alerts. There's an empty state message but no guided setup flow. For elderly users, this is a critical gap.

**"Setup" means different things in different roles.** [App.js:47](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/App.js#L47) (admin Setup = permissions + diagnostics) vs [UserShell.js:149](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/UserShell.js#L149) (user Setup = band management + PIN + sign-out). Same label, completely different content.

### 2.2 Visual Hierarchy & UI

**Credit where due:** The design system is genuinely disciplined — two theme palettes (admin in [theme.js](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/theme.js), user in [kit.js](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/kit.js)), semantic color tokens, consistent 4/8 spacing scale, named type scale, and universal 48pt+ touch targets. The rule "colour never carries meaning on its own; there is always a word next to it" is applied throughout.

**However:**

**`C.faint` fails WCAG AA for normal text.** [theme.js:29](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/theme.js#L29) defines it at 3.6:1 contrast and states it's "never body text," but it IS used for body-length explanatory text in [Setup.js:299](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Setup.js#L299), [Band.js:57-64](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Band.js#L57-L64), and [Band.js:108-113](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Band.js#L108-L113).

**User palette contrast misses AAA.** [kit.js:26](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/kit.js#L26) — `U.dim` at ~5.8:1 passes AA but not AAA (7:1). For a safety app targeting elderly users with potentially declining vision, AAA is the appropriate target.

**No `maxFontSizeMultiplier` on critical large text.** [FallCountdown.js:91](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/components/FallCountdown.js#L91) (fontSize:96) and [DisarmPad.js:179](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/DisarmPad.js#L179) could break layouts with aggressive system font scaling.

**Label/Chip uppercase strategy contradicts itself.** [ui.js:28-34](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/ui.js#L28-L34) — the `Label` component uses `textTransform: 'uppercase'` while the comment says it should be uppercased "in place, for VoiceOver." Meanwhile, `Chip` ([ui.js:94](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/ui.js#L94)) correctly uses `.toUpperCase()` inline. The Label approach causes VoiceOver/TalkBack to spell out letters.

### 2.3 The "Forgotten" States

**Dashboard data load failure is silently swallowed.** [Dashboard.js:93](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/Dashboard.js#L93) — the catch block assumes the offline strip handles it, but that strip reads WebSocket state, not HTTP fetch state. A failed HTTP fetch with an active WebSocket shows stale data with zero indication.

**No offline indicator on safety-critical screens:**
- [Family.js](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Family.js) — where people manage emergency contacts, no offline banner
- [Alerts.js](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Alerts.js) — admin alerts list, no offline banner
- [UserAlerts.js](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/UserAlerts.js) — user alerts list, no offline banner

**Sign-out has no confirmation.** [UserSettings.js:405-424](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/UserSettings.js#L405-L424) disconnects the band, stops background watch, clears the queue, and resets the state machine on a single tap. Ironically, the less dangerous "remove family member" action in [Family.js:156-163](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Family.js#L156-L163) correctly uses `Alert.alert`.

**Band buzz has no success feedback.** [Home.js:241](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Home.js#L241) and [UserSettings.js:237](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/UserSettings.js#L237) send buzz commands with no toast, haptic, or confirmation that the band actually vibrated.

**SOS "pulse" dot doesn't actually animate.** [SosLive.js:191](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/user/SosLive.js#L191) has a static red circle named `pulse`. An animated pulse would reinforce the emergency is active on the most anxiety-inducing screen.

**BLE mode has no skeleton/loading state.** [Band.js:228-260](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/screens/Band.js#L228-L260) shows raw status text while waiting for first BLE connection, unlike the rest of the app which has polished skeletons.

**Toast auto-dismiss may be too fast for screen readers.** [App.js:308](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/App.js#L308) — 4.5s may not be enough for a screen reader user to locate and read the message.

---

## Phase 3: Strategic Plan & Feature Gap Analysis

### 3.1 The "Bad Plan" Audit

**The plan is ~2x overscoped for the actual team.** 82 person-hours across 4 parallel tracks were estimated for 5 days. All evidence points to a solo (or two-person) contributor. It is now Day 12+ with zero deployment milestones complete.

**Priorities were ordered backwards.** The Good Samaritan feature (proximity-based stranger alerting) was built end-to-end — server, app UI, tests, 123 lines of test code — while **the band cannot detect a fall and cannot vibrate**. `HAS_IMU 0` in [nigehban_band_nrf52.ino](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban_band_nrf52/nigehban_band_nrf52.ino). For a product titled "fall detection wearable," this is building the sunroof before the engine.

**Zero deployment after 12 days of a cloud hackathon.** The entire D-track (D0-D3) is untouched. Everything runs on a laptop with ngrok. For a "Bano Qabil x Alibaba Cloud" hackathon, having zero cloud integration is a critical gap.

**Over-engineered features for hackathon stage:**
- Good Samaritan (geohash proximity fan-out, 800m radius, progressive disclosure)
- Two-font design system with 56KB icon bundle optimization
- Timing-safe pairing responses (byte-identical for existing vs. nonexistent codes)
- Full JavaScript port of firmware gesture engine at 104Hz ([virtualBand.js](file:///c:/Users/MOAX/Desktop/Nigheban/nigehban-app/src/virtualBand.js))

Each is impressive engineering — and each stole time from hardware and deployment.

### 3.2 Missing Core Features

**Emergency service integration.** A safety device that cannot call 1122 (Pakistan's rescue number) is incomplete. This is a `Linking.openURL('tel:1122')` button — 30 minutes of work for massive demo impact.

**Real-time location during emergencies.** Location is a static pin in the SOS alert. Family sees where the person WAS, not where they ARE. No location streaming during active SOS.

**Medical profile.** No way to store allergies, medications, blood type, or emergency contacts beyond in-app family. A Good Samaritan or first responder has zero medical context.

**Multi-language support.** The target demographic is elderly Pakistanis. The entire app is in English. No Urdu, no RTL layout.

**Caregiver escalation chains.** All family members are notified equally. No "call Mom first, then Dad after 2 minutes, then emergency services after 5 minutes."

**Family without the app.** The system only reaches Nigehban app users. WhatsApp fan-out was cut. An elderly person's doctor, neighbor, or building security is unreachable.

**Historical fall data and export.** `near_miss` events are recorded but never surfaced. No trend analysis, no data export for medical professionals.

**Multiple band support / replacement flow.** If a user's band breaks, there is no clean "pair a new band" flow that transfers settings.

### 3.3 Blind Spots & Edge Cases

**Phone dead + fall = nothing happens.** The band has no fall detection capability. Even the phone-side detection requires the app to be running.

**Boot kills everything.** No boot receiver (N2.3) means a phone reboot kills the background service permanently until the user manually opens the app.

**BUG-010 is devastating.** `setTimeout` in React Native stops entirely when the Activity is paused. The reconnect timer, heartbeat, and data watchdog all freeze when the screen goes off. This is documented with forensic detail but remains unfixed.

**BUG-015 on dominant market phones.** On Xiaomi, Vivo, Oppo, Huawei (the majority of phones sold in Pakistan), a Recents swipe kills the process outright and nothing restarts it.

**No concurrent emergency handling.** The state machine has a single `activeSos` slot. Two family members having simultaneous emergencies shows only whichever arrived last.

**No timezone-aware display.** A mother in Lahore sees "SOS at 14:32" while her daughter in Dubai had the event at 15:32.

**No firmware OTA updates.** The nRF52840 supports DFU over BLE, but it's not implemented. Firmware updates require physical USB access.

**Test suite is 33% broken.** [test_consent_and_sweeper.py](file:///c:/Users/MOAX/Desktop/Nigheban/tests/test_consent_and_sweeper.py) (270 lines, the largest test) reads from the old SQLite database while the server now uses Postgres — producing false greens.

**No CI/CD pipeline.** No GitHub Actions, no build automation.

---

## Phase 4: The Expert's Verdict & Action Plan

### Biggest Risk

**The product cannot do what its name promises.** Nigehban is a fall-detection safety wearable where the band cannot detect falls (`HAS_IMU 0`), cannot vibrate (no motor driver), has no reliable battery reading, and has no power management. The phone-side fall detection only works while the app is alive — which BUG-010 and BUG-015 ensure it frequently is not, on the exact Android phones dominant in Pakistan. Meanwhile, 12 days into a cloud hackathon, nothing has been deployed to the cloud. The project has world-class software architecture wrapped around non-functional hardware and zero infrastructure.

### Execution Checklist

| Priority | Action | Effort | Files |
|----------|--------|--------|-------|
| **CRITICAL** | Enable IMU fall detection on band (F3) | 4-6h | `nigehban_band_nrf52.ino` |
| **CRITICAL** | Build motor driver + LiPo for haptic (F4) | 3-4h | Hardware + `nigehban_band_nrf52.ino` |
| **CRITICAL** | Deploy server to Alibaba Cloud (D0-D2) | 3-4h | New Dockerfile, server config |
| **CRITICAL** | Rotate all Supabase credentials — they're exposed | 15min | `.env`, Supabase dashboard |
| **CRITICAL** | Move session token to `expo-secure-store` | 30min | `api.js` |
| **CRITICAL** | Fix BUG-010 (`setTimeout` stops when screen off) | 2-3h | `band.js`, native modules |
| **HIGH** | Add React Error Boundary around `<Main />` | 30min | `App.js` |
| **HIGH** | Add emergency services call button (1122) | 30min | `SosLive.js`, `SosLiveView.js` |
| **HIGH** | Add exponential backoff to WebSocket reconnect | 30min | `api.js:301` |
| **HIGH** | Add authentication to bridge WebSocket | 1-2h | `nigehban_bridge.py` |
| **HIGH** | Raise minimum password to 8 characters | 5min | `nigehban_server.py:515` |
| **HIGH** | Move WS token from query param to first-message handshake | 1-2h | `nigehban_server.py`, `api.js` |
| **HIGH** | Add offline banners to Family.js, Alerts.js, UserAlerts.js | 1h | 3 screen files |
| **HIGH** | Fix Dashboard.js:93 silent data load failure | 30min | `Dashboard.js` |
| **HIGH** | Delete `nigehban_server.py.bak` | 1min | `server/` |
| **HIGH** | Add sign-out confirmation dialog | 15min | `UserSettings.js:406` |
| **HIGH** | Fix broken test suite (SQLite → Postgres) | 2h | `test_consent_and_sweeper.py` |
| **MEDIUM** | Restrict CORS to actual origins | 15min | `nigehban_server.py:490` |
| **MEDIUM** | Validate `kind` field against SEVERITY dict | 15min | `nigehban_server.py:443` |
| **MEDIUM** | Add crash reporting (Sentry) | 1-2h | `App.js`, `package.json` |
| **MEDIUM** | Make health check verify DB + sweeper | 30min | `nigehban_server.py:499` |
| **MEDIUM** | Wrap multi-statement DB ops in transactions | 2h | `nigehban_server.py` |
| **MEDIUM** | Fix Label uppercase strategy (VoiceOver) | 15min | `ui.js:28-34` |
| **MEDIUM** | Animate the SOS "pulse" dot | 30min | `SosLive.js:191` |
| **MEDIUM** | Add medical profile screen | 3-4h | New screen + server endpoint |
| **MEDIUM** | Add Urdu / RTL support | 4-6h | All screens, i18n setup |
| **MEDIUM** | Cap auth cache size | 30min | `nigehban_server.py:103` |
| **LOW** | Unify SOS trigger (long-press vs tap) | 30min | `Home.js:165` |
| **LOW** | Add onboarding walkthrough for first-time users | 3-4h | New component |
| **LOW** | Add `maxFontSizeMultiplier` on countdown/PIN text | 15min | `FallCountdown.js`, `DisarmPad.js` |
| **LOW** | Remove `react-native-web` dependency | 5min | `package.json` |
| **LOW** | Add event journal rotation | 1h | `nigehban_hub.py:117` |
| **LOW** | Set up CI/CD pipeline | 2-3h | New workflow files |

**What to stop doing immediately:** Do not invest more time in Good Samaritan, gesture remapping, directional links, or Redis. Those are post-launch features. Every hour spent on them is an hour stolen from hardware, deployment, and the five open critical BLE bugs.
