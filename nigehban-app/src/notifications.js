import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { call } from './api';

let Notifications = null;
let Constants = null;
try {
  Notifications = require('expo-notifications');
} catch {
  /* Notifications module fallback */
}
try {
  Constants = require('expo-constants');
} catch {
  /* projectId lookup falls back to the implicit resolution below */
}

export const EMERGENCY_CHANNEL_ID = 'nigehban_emergency_alarm';
export const DEFAULT_CHANNEL_ID = 'nigehban_default';
// The wearer's own live SOS, which is a different thing from both of the above:
// not a family member's siren, and not a check-in. Its own channel so that
// muting check-ins cannot take away the one indicator saying help is coming.
export const SOS_STATUS_CHANNEL_ID = 'nigehban_sos_status';
// "Somebody answered your SOS." Pushed by the server, so the id has to match
// RESPONDER_CHANNEL_ID in nigehban_server.py exactly — Android silently files a
// push naming an unknown channel under the default one instead.
export const RESPONDER_CHANNEL_ID = 'nigehban_sos_responder';

const INSTALL_ID_KEY = 'nigehban.installId';

/** Set by registerPushToken; read by the Setup screen's diagnostics panel. */
let lastToken = null;
let lastError = null;
let registered = false;

export function pushDiagnostics() {
  return { token: lastToken, error: lastError, registered };
}

/**
 * A stable id for this install, minted once and kept.
 *
 * It deliberately is not the push token. Two reasons, and the first one is why
 * no alert ever reached a closed phone: the server validated the install id as
 * [A-Za-z0-9_.:-]{8,64}, and "ExponentPushToken[…]" fails on the brackets, so
 * every registration came back 400 and the devices table stayed empty. The
 * server now tolerates that old shape so already-installed builds recover, but
 * tolerating it is not a reason to keep sending it.
 *
 * The second reason outlives that bug. The push token rotates — on reinstall,
 * on restore, whenever FCM decides. Keyed on the token, each rotation inserts a
 * second device row and leaves the old one holding a token that no longer
 * delivers. Keyed on the install, the same row is updated in place.
 */
async function installId() {
  try {
    const saved = await AsyncStorage.getItem(INSTALL_ID_KEY);
    if (saved) return saved;
  } catch {
    /* unreadable storage — mint a fresh one rather than fail the registration */
  }
  const id = 'ins-'
    + Date.now().toString(36)
    + Math.random().toString(36).slice(2, 10)
    + Math.random().toString(36).slice(2, 10);
  try { await AsyncStorage.setItem(INSTALL_ID_KEY, id); } catch { /* non-fatal */ }
  return id;
}

/**
 * Register Expo Push Token with backend server (POST /device).
 * Allows server to send Remote Push Notifications when app is completely
 * closed — this is the ONLY delivery path that survives a force-stop, and it
 * only works once the project has real FCM (V1) credentials uploaded via
 * `eas credentials`; without that, getExpoPushTokenAsync() throws or the
 * token exists but Expo's push API rejects every send.
 *
 * Returns the token string on success, or null (with the reason recorded in
 * pushDiagnostics()) on failure.
 */
export async function registerPushToken(session) {
  if (!Notifications || !session || Platform.OS === 'web') {
    lastError = !Notifications ? 'expo-notifications not available in this build' : 'no session';
    registered = false;
    return null;
  }

  try {
    const { status } = await Notifications.getPermissionsAsync();
    let finalStatus = status;
    if (status !== 'granted') {
      const { status: reqStatus } = await Notifications.requestPermissionsAsync();
      finalStatus = reqStatus;
    }
    if (finalStatus !== 'granted') {
      lastError = 'notification permission not granted';
      registered = false;
      return null;
    }

    const projectId = Constants?.default?.expoConfig?.extra?.eas?.projectId
      || Constants?.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    if (tokenData && tokenData.data) {
      lastToken = tokenData.data;
      lastError = null;
      // Holding "registered" false until the POST comes back is the point.
      // Recording success as soon as the token existed is what made the
      // diagnostics panel show a green "registered" chip for months while the
      // server was rejecting every one of these calls.
      registered = false;
      await call(session, '/device', {
        method: 'POST',
        body: {
          id: await installId(),
          push_token: tokenData.data,
          platform: Platform.OS,
          os_version: String(Platform.Version ?? ''),
          app_version: Constants?.default?.expoConfig?.version
            || Constants?.expoConfig?.version
            || '',
        },
      });
      registered = true;
      return tokenData.data;
    }
    lastError = 'getExpoPushTokenAsync returned no token';
  } catch (e) {
    lastError = e?.message || String(e);
    registered = false;
    console.warn('[notifications] registerPushToken failed —', lastError);
  }
  return null;
}

/**
 * Initialize high-priority system notification channels on Android/iOS.
 * Configures the MAX importance emergency channel with siren sound, DND bypass, and strong vibration.
 */
export async function setupNotificationChannels() {
  if (!Notifications || Platform.OS === 'web') return false;

  try {
    // Request system notification permissions
    const permissions = await Notifications.getPermissionsAsync();
    if (!permissions.granted) {
      await Notifications.requestPermissionsAsync();
    }

    if (Platform.OS === 'android') {
      // Configure high-priority Emergency SOS channel
      await Notifications.setNotificationChannelAsync(EMERGENCY_CHANNEL_ID, {
        name: 'Emergency SOS Alarms',
        description: 'Critical high-priority siren alarms for family emergency SOS alerts.',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 200, 500, 200, 500],
        enableVibrate: true,
        enableLights: true,
        lightColor: '#F2645A',   // C.red, so the LED matches the app's own danger tone
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true, // Override Do Not Disturb mode for critical SOS
        sound: 'default', // Plays max volume system alarm sound
      });

      // Configure default notification channel for check-ins
      await Notifications.setNotificationChannelAsync(DEFAULT_CHANNEL_ID, {
        name: 'General Safety Check-ins',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200, 100, 200],
        enableVibrate: true,
      });

      // The wearer's own live SOS.
      //
      // Deliberately silent, and deliberately NOT the emergency channel above.
      // That one is a DND-bypassing siren built to wake a family member across
      // town; firing it at the person already holding the phone -- who felt it
      // vibrate when they pressed the button -- adds nothing and could give
      // away the position of somebody hiding from whoever they pressed it
      // about. LOW importance is Android's own definition of a status
      // notification: always in the shade, never a sound, never a heads-up.
      await Notifications.setNotificationChannelAsync(SOS_STATUS_CHANNEL_ID, {
        name: 'Your live SOS',
        description: 'Stays in the notification shade while an SOS you raised is still active.',
        importance: Notifications.AndroidImportance.LOW,
        enableVibrate: false,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });

      // "Ali is on the way."
      //
      // The one piece of good news this app has to deliver, and the wearer is
      // the least able of anyone to go looking for it: the phone is in a
      // pocket, the screen is off, and the app was killed when it left the
      // foreground. So it arrives as a push from the server, and it has to be
      // felt without being heard.
      //
      // DEFAULT importance rather than LOW, because unlike the status
      // notification above this is news and it is worth a buzz. `sound: null`
      // rather than the channel default, because the person it reaches may be
      // hiding from whoever they pressed the button about -- the same reason
      // the SOS channel above is silent. Vibration is felt by one person;
      // a notification tone is heard by the room.
      //
      // The band is deliberately NOT buzzed for this. On the wrist a vibration
      // already means "someone is checking on you, press the button to answer",
      // and somebody in the middle of an emergency must not be handed a button
      // to press -- nor be left unable to trust what a buzz means.
      await Notifications.setNotificationChannelAsync(RESPONDER_CHANNEL_ID, {
        name: 'Someone is coming',
        description: 'Tells you when a family member or a neighbour has answered your SOS.',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200, 100, 200],
        enableVibrate: true,
        // Documented as the way to keep a channel silent (SDK 57
        // NotificationChannelInput: `sound: string | null`). A channel cannot be
        // reconfigured after Android creates it -- only its name and
        // description -- so changing this later needs a new channel id.
        sound: null,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    // Configure notification handler for foreground/background behavior
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification.request.content.data;
        const isEmergency = data && data.severity >= 5;
        // The wearer's own two notifications -- "your SOS is active" and
        // "somebody answered" -- are silent by channel. This handler runs only
        // in the foreground and overrides the channel, so without naming them
        // here the one case where the wearer is holding the phone is the one
        // case it makes a noise.
        const isOwn = data && (data.ownSos || data.t === 'ack');

        return {
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: !isOwn,
          shouldSetBadge: false,
          priority: isEmergency
            ? Notifications.AndroidNotificationPriority.MAX
            : Notifications.AndroidNotificationPriority.HIGH,
        };
      },
    });

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Route a tapped notification back to the alert it was about.
 *
 * The remote push the server sends to a killed app carries `alert_id`
 * (`nigehban_server.py`'s `send_expo_push_notifications` calls), while the
 * local notification this app schedules for itself while alive carries
 * `alertId` (`sendEmergencyAlarmNotification` below) — both are read here so
 * a tap routes the same way regardless of which path delivered it.
 *
 * `onAlertId` fires for a tap on a running app (the normal listener) and,
 * separately, for the notification that cold-launched the app — Expo does
 * not always replay the launch tap through the live listener, so that case
 * is checked once explicitly.
 */
export function subscribeNotificationTaps(onAlertId) {
  if (!Notifications || Platform.OS === 'web') return () => {};

  const extract = (response) => {
    const data = response?.notification?.request?.content?.data;
    const id = data?.alertId ?? data?.alert_id;
    if (id != null) onAlertId(id);
  };

  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (!response) return;
      extract(response);
      // Without this, the tap that cold-launched the app keeps being "the
      // last response" and would reopen the same alert on every future
      // launch, including ones that had nothing to do with a notification.
      Notifications.clearLastNotificationResponseAsync?.().catch(() => {});
    })
    .catch(() => { /* best effort */ });

  const sub = Notifications.addNotificationResponseReceivedListener(extract);
  return () => sub.remove();
}

// The wearer's own live-SOS notification, so it can be replaced and taken down
// again. Module scope, not React state: the notification outlives the screen
// that raised it, which is the entire point of it existing.
let ownSosNotificationId = null;

/**
 * "Your SOS is active", in the wearer's own notification shade.
 *
 * The app's emergency state lives in a React reducer, and Android destroys that
 * whole tree when the app is swiped out of Recents. The SOS still goes out from
 * the surviving process -- the phone vibrates, the family is paged -- but there
 * was then nothing anywhere on the phone saying so: no screen, and no
 * notification, because the only one the app could produce was the siren meant
 * for a family member receiving somebody else's alert.
 *
 * This is the piece that survives. It is sticky, so it cannot be swiped away
 * while help is still coming, and it carries the time the alert was raised so
 * the answer to "did it actually send, and when" is readable from the lock
 * screen without opening anything.
 */
export async function showOwnSosNotification(alert, responders = []) {
  if (!Notifications || Platform.OS === 'web') return false;

  try {
    const raisedAt = alert?.created_at ? new Date(alert.created_at * 1000) : new Date();
    const at = raisedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const what = alert?.kind === 'snatch' ? 'Band torn off'
      : alert?.kind === 'fall' ? 'Fall detected'
      : 'SOS';

    // Who is coming, once anyone is. The server pushes its own notification the
    // moment somebody answers, and that is what actually gets noticed; this is
    // the line the wearer re-reads afterwards, so it has to stay current rather
    // than still saying nobody has replied twenty minutes later.
    const coming = responders.length === 0 ? ''
      : responders.length === 1 ? ` ${responders[0].name} is on the way.`
      : ` ${responders.length} people are on their way.`;

    // One notification per emergency, replaced rather than stacked. Raising,
    // the server confirming and a responder answering are all the same event,
    // and three entries to read at speed is worse than one that is current.
    const previous = ownSosNotificationId;

    ownSosNotificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `${what} is active`,
        body: coming
          ? `Sent at ${at}.${coming} Tap to open.`
          : `Sent at ${at}. Your family can see your location. Tap to open.`,
        // Android's isOngoing: it cannot be swiped away while the alert is live.
        sticky: true,
        // Tapping opens the app; it must not look like the emergency is over.
        autoDismiss: false,
        priority: Notifications.AndroidNotificationPriority.HIGH,
        data: { ownSos: true, alertId: alert?.id },
      },
      // Same rule as the siren below: in expo-notifications the channel is
      // chosen by the TRIGGER, not by the content, and it still means "now".
      trigger: { channelId: SOS_STATUS_CHANNEL_ID },
    });

    // Dismissed after the replacement is up, so the shade is never empty in
    // between -- on a safety device the gap is the one thing worth avoiding.
    if (previous) {
      try { await Notifications.dismissNotificationAsync(previous); } catch { /* already gone */ }
    }

    return true;
  } catch (e) {
    return false;
  }
}

/** The emergency is over: take the notification down with it. */
export async function clearOwnSosNotification() {
  if (!Notifications || Platform.OS === 'web') return false;
  const id = ownSosNotificationId;
  ownSosNotificationId = null;
  if (!id) return false;
  try {
    await Notifications.dismissNotificationAsync(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatch a high-priority Emergency Siren Notification for incoming Severity 5 SOS alerts.
 */
export async function sendEmergencyAlarmNotification(alert) {
  if (!Notifications || Platform.OS === 'web') return false;

  try {
    const isSos = alert.kind === 'sos';
    const isSnatch = alert.kind === 'snatch';

    const title = isSos
      ? `EMERGENCY SOS — ${alert.user?.name || 'Family Member'}`
      : isSnatch
      ? `BAND TORN OFF — ${alert.user?.name || 'Family Member'}`
      : `FALL DETECTED — ${alert.user?.name || 'Family Member'}`;

    const body = alert.maps
      ? 'CRITICAL ALERT! Tap immediately to view live location on map.'
      : 'CRITICAL ALERT! Open Nigehban immediately for emergency details.';

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        categoryIdentifier: 'emergency',
        data: {
          alertId: alert.id,
          severity: alert.severity || 5,
          maps: alert.maps,
        },
      },
      // The MAX-importance, DND-bypassing channel is created above and then has
      // to actually be *used*, or Android files this on the default channel and
      // a severity-5 SOS arrives silently under Do Not Disturb — which is the
      // one condition the channel exists for.
      //
      // In expo-notifications the channel is chosen by the TRIGGER, not by the
      // content: `{ channelId }` is ChannelAwareTriggerInput, and it still means
      // "deliver immediately". On iOS the parser resolves it to null, so this is
      // the same instant dispatch `trigger: null` was.
      trigger: { channelId: EMERGENCY_CHANNEL_ID },
    });

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The same emergency notification, but only if this alert is not already on
 * screen.
 *
 * One alert legitimately arrives up to three ways -- a visible push, a silent
 * push that wakes the background task, and the websocket frame -- because the
 * OS may drop the silent one in Doze and the visible push is the guaranteed
 * floor under that. The redundancy is deliberate. Posting for each of them is
 * not: a family member got the same SOS two and three times over, which is how
 * the one notification that must be read becomes the one that gets swiped.
 *
 * This check used to live in bgNotifications.js and guarded only the background
 * task, so the websocket path -- the one that runs exactly when the app is
 * open -- posted blind. That is why the duplicates appeared with the app open
 * and not with it killed.
 *
 * It can still lose a race, because the two pushes arrive independently and the
 * visible one may not be posted yet. That direction is chosen on purpose: when
 * it cannot be known, a duplicate beats a silence. Two notifications is a
 * nuisance; none is the product failing.
 */
export async function sendEmergencyAlarmIfNothingShown(alert) {
  if (!Notifications || Platform.OS === 'web') return false;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const already = presented.some((n) => {
      const d = n?.request?.content?.data ?? {};
      return String(d.alert_id ?? d.alertId ?? '') === String(alert?.id);
    });
    if (already) return false;
  } catch {
    /* cannot tell what is on screen -- fall through and post */
  }
  return sendEmergencyAlarmNotification(alert);
}
