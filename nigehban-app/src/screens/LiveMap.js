import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Linking, Modal, Platform, Share, StyleSheet, Text, View,
} from 'react-native';
import { SERVER_URL } from '../api';
import { useEdgeInsets } from '../safeArea';
import { C, R, S, T } from '../theme';
import { Button, Icon, IconButton, Txt } from '../ui';

/**
 * Watching somebody move, without leaving the app.
 *
 * WHAT THIS REPLACES. Every "see where they are" in this product opened
 * `https://maps.google.com/?q=<lat>,<lon>`, which is a photograph. The family
 * member taps it during a siren, sees a pin, and that pin is still sitting
 * there twenty minutes later while she is a kilometre away. It cannot be fixed
 * from this side: nothing lets an app push a new position into somebody else's
 * maps app. Google's own live sharing works because Google owns both ends.
 *
 * So the map is the server's own page -- see server/routes/share.py -- and
 * this embeds it. That choice is worth defending, because a native map
 * (react-native-maps) would look better:
 *
 *   - It is ONE map. The same page is what gets forwarded to the police, and
 *     an in-app map built separately would drift from it the first time either
 *     was touched. During an emergency the family and whoever they called must
 *     not be looking at two different answers.
 *   - It needs no Google Maps API key, no billing account, and no native
 *     configuration in a build that already carries plenty.
 *   - The live feed is already solved server-side. Nothing here polls, holds a
 *     socket, or knows what a coordinate is.
 *
 * Swapping the inside for a native map later changes this file and nothing
 * else; the server, the link and the token stay exactly as they are.
 *
 * WHO OWNS WHICH CHROME. The page is a whole product on its own -- it has a
 * heading, a Directions link and a Share button, because the person opening it
 * in a browser has nothing else. Embedded, all three landed directly underneath
 * this screen's own, so the name appeared twice and there were two Directions
 * buttons and two Shares stacked on one phone. Everything below is the native
 * side of that split: the app draws the identity and the actions, because it
 * can hand the coordinates to whichever navigation app the phone's owner
 * actually uses and open the system share sheet, and it asks the page for the
 * map alone with `?embed=1`. The page keeps the one claim only it can make --
 * how old the fix on screen is -- because it is the side that polls.
 *
 * DEGRADES RATHER THAN BREAKS. react-native-webview is loaded the way every
 * optional native module in this app is loaded -- inside a try, at module
 * scope -- so a build that does not have it yet falls back to the old static
 * pin instead of showing a white screen during an emergency. That is not
 * defensive habit: this screen is reached by somebody who has just been woken
 * by a siren, and "the map did not load" must never be the thing standing
 * between them and an address.
 */
let WebView = null;
try {
  ({ WebView } = require('react-native-webview'));
} catch {
  /* not in this build: the static pin below is the fallback */
}

/** Is the live map actually available in this binary? Used by Setup's diagnostics. */
export function liveMapAvailable() {
  return !!WebView;
}

/**
 * The absolute URL of the live page for an alert, or null if there isn't one.
 *
 * The server hands back a PATH rather than a full URL, deliberately: it sits
 * behind a tunnel in development and a load balancer in production and does
 * not reliably know its own public address. This app does know which host it
 * is talking to, so it composes the link and nobody has to guess.
 *
 * `embed` asks the same page for the map without its own heading and buttons.
 * It is a view of one page, never a second page: the link that leaves this
 * phone is always the complete one, because whoever receives it has no app
 * around it to supply the missing half.
 */
export function liveUrl(session, alert, { embed = false } = {}) {
  const path = alert?.share_path;
  if (!path) return null;
  // `session.url` OR SERVER_URL, exactly as `call` in api.js resolves it. Most
  // sessions carry no url at all -- the server address stopped being something
  // the app asks for -- so reading only the session would have left the live
  // map permanently unavailable while every other request worked fine.
  const base = (session?.url || SERVER_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  if (!embed) return base + path;
  return base + path + (path.includes('?') ? '&' : '?') + 'embed=1';
}

/** Metres between two fixes. Equirectangular -- exact enough under a kilometre. */
function metresBetween(a, b) {
  if (!a || !b) return 0;
  const R_M = 6371000, rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R_M;
}

// How far she has to move before the directions somebody is already driving on
// are worth redoing. Two hundred metres is roughly a city block: far enough
// that a nudge is not noise every ten seconds, close enough that nobody
// arrives at the wrong end of a street.
const REROUTE_M = 200;

export default function LiveMap({ visible, alert, session, onClose }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Bumped to remount the WebView, which is the only way to retry a load that
  // failed: the component does not re-request on its own.
  const [attempt, setAttempt] = useState(0);
  // Where she was when Directions was last pressed. Null until it has been.
  const [routedTo, setRoutedTo] = useState(null);
  const insets = useEdgeInsets();

  // The forwardable link and the embedded view of it. Both null together.
  const url = liveUrl(session, alert);
  const embedUrl = liveUrl(session, alert, { embed: true });
  const name = alert?.user?.name || 'They';

  // A different alert is a different map: a failure and a route belonging to
  // the last one must not be carried onto it. Keyed on the URL rather than on
  // `visible`, so closing and reopening the same alert still remembers where
  // the driver was sent.
  useEffect(() => {
    setLoading(true);
    setFailed(false);
    setRoutedTo(null);
  }, [embedUrl]);

  // Where to send somebody who taps Directions. The LIVE position when there
  // is one -- pressing it again after she has moved routes to where she is
  // now, not to where this screen was opened.
  const lat = alert?.live_lat ?? alert?.lat;
  const lon = alert?.live_lon ?? alert?.lon;

  /**
   * Hand the coordinates to whatever navigation app this person actually uses.
   *
   * `geo:` is Android's own intent for "here is a place", and the phone routes
   * it to the app its owner has chosen -- Google Maps, OsmAnd, Waze, HERE.
   * That is better than naming one: somebody driving to an emergency should be
   * in the app they know, not the app we assumed, and this product has no
   * business having an opinion about it. It also means nothing here depends on
   * a Google account, a key or a billing plan -- the map above already renders
   * from OpenStreetMap, and this closes the last gap.
   *
   * The https link stays last in the list as the thing that always works: a
   * phone with no maps app at all still has a browser, and `canOpenURL` on
   * Android can answer false for a scheme that is genuinely handled. Falling
   * through to it costs nothing; failing to open anything costs an address.
   */
  const openDirections = async () => {
    if (lat == null) return;
    setRoutedTo({ lat, lon });
    const web = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
    const label = encodeURIComponent(name);
    const first = Platform.OS === 'android'
      ? `geo:${lat},${lon}?q=${lat},${lon}(${label})`
      : `maps://?daddr=${lat},${lon}`;
    for (const u of [first, web]) {
      try {
        if (await Linking.canOpenURL(u)) { await Linking.openURL(u); return; }
      } catch { /* try the next one */ }
    }
    try { await Linking.openURL(web); } catch { /* nothing can open it */ }
  };

  const canEmbed = !!WebView && !!embedUrl && !failed;
  // The one origin this view may ever show. Without it a redirect could put
  // anything at all on a screen somebody reached from a siren.
  const origin = (session?.url || SERVER_URL || '').replace(/\/+$/, '');

  // Google Maps was handed ONE coordinate and it will not follow her. It
  // re-routes as the driver moves, which is what navigation does, but the
  // destination is frozen at the moment the button was pressed -- and no maps
  // app on any platform accepts a moving destination from a URL.
  //
  // So the app says so, rather than letting somebody drive confidently to
  // where she was ten minutes ago. This is the one piece of the live-location
  // story that cannot be solved and can only be admitted.
  const drift = routedTo && lat != null
    ? metresBetween(routedTo, { lat, lon }) : 0;
  const stale = drift >= REROUTE_M;
  const drifted = Math.round(drift / 10) * 10;

  const shareLink = async () => {
    if (!url) return;
    try {
      await Share.share({
        message: `${name} needs help. Watch their live location: ${url}`,
        url,
      });
    } catch { /* the sheet was dismissed */ }
  };

  const retry = () => {
    setFailed(false);
    setLoading(true);
    setAttempt((n) => n + 1);
  };

  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={s.root}>
        <View style={[s.head, { paddingTop: insets.top + S.md }]}>
          <View style={{ flex: 1 }}>
            <Txt variant="h2" color={C.text} numberOfLines={1}>{name}</Txt>
            <Text style={[T.meta, { color: C.dim }]} numberOfLines={2}>
              {canEmbed
                ? 'Live location — the map moves as they do'
                : 'Last known position'}
            </Text>
          </View>
          <IconButton name="x" onPress={onClose} label="Close the map" tone={C.dim} />
        </View>

        <View style={s.map}>
          {canEmbed ? (
            <>
              <WebView
                key={attempt}
                source={{ uri: embedUrl }}
                style={{ flex: 1, backgroundColor: C.bg }}
                onLoadEnd={() => setLoading(false)}
                // A failure here is not cosmetic -- it is somebody looking for
                // an address during an emergency -- so it falls through to the
                // static pin rather than sitting on a blank screen.
                onError={() => { setFailed(true); setLoading(false); }}
                onHttpError={() => { setFailed(true); setLoading(false); }}
                // The page is ours and it is the only thing this view may ever
                // show. Without this a redirect could put anything on a screen
                // the user reached from a siren.
                originWhitelist={[origin + '/*']}
                javaScriptEnabled
                domStorageEnabled
                startInLoadingState={false}
              />
              {loading ? (
                <View style={s.loading} pointerEvents="none">
                  <ActivityIndicator color={C.green} />
                  <Text style={[T.meta, { color: C.dim }]}>Finding them…</Text>
                </View>
              ) : null}
            </>
          ) : (
            <View style={s.fallback}>
              <View style={s.fallbackIcon}>
                <Icon name="map-pin" size={22} color={C.amber} />
              </View>
              <Txt variant="h2" color={C.dim} style={s.centred}>
                {failed ? 'The map did not load' : 'Live map unavailable'}
              </Txt>
              <Text style={[T.meta, { color: C.faint }, s.centred]}>
                {failed
                  ? 'The connection dropped or the server could not be reached. Their last reported position still opens in Maps.'
                  : alert?.maps
                    ? 'Open their last reported position in Maps instead. It will not update as they move.'
                    : 'No position has been reported for this alert.'}
              </Text>
              <View style={s.fallbackActs}>
                {failed ? (
                  <Button title="TRY AGAIN" icon="refresh-cw" filled tone={C.green}
                          onPress={retry} />
                ) : null}
                {alert?.maps ? (
                  <Button title="OPEN IN MAPS" icon="navigation"
                          tone={failed ? C.dim : C.green} filled={!failed}
                          onPress={() => Linking.openURL(alert.maps)} />
                ) : null}
              </View>
            </View>
          )}
        </View>

        {/* One bar, one surface, one hairline. Whatever the map is doing above
            it, the two things a person can do about it stay in the same place
            and clear of the system navigation bar. */}
        <View style={[s.acts, { paddingBottom: insets.bottom + S.md }]}>
          {stale ? (
            // Amber, worded, and above the button it corrects, so it is read
            // before Directions is pressed again rather than after.
            <Button
              title="UPDATE DIRECTIONS"
              sub={`They have moved about ${drifted} m since you set off`}
              icon="corner-up-right"
              tone={C.amber}
              filled
              onPress={openDirections}
              accessibilityLabel={
                `Update directions. They have moved about ${drifted} metres.`}
            />
          ) : null}
          <View style={s.actRow}>
            {lat != null ? (
              <Button title="DIRECTIONS" icon="navigation" filled tone={C.green}
                      onPress={openDirections} style={s.grow}
                      accessibilityLabel={`Directions to ${name}`} />
            ) : null}
            {url ? (
              // The reason the link exists at all. The person who most needs it
              // is often not a Nigehban user -- the police, a neighbour, the
              // cousin who never installed anything -- and this is how it
              // reaches them. Secondary tone: on this screen the one thing
              // somebody is usually here to do is drive.
              <Button title="SEND LINK" icon="share-2" tone={C.dim}
                      onPress={shareLink} style={s.grow}
                      accessibilityLabel={`Send a link to ${name}'s live location`} />
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: S.md,
    paddingHorizontal: S.lg, paddingBottom: S.md,
  },
  map: { flex: 1, backgroundColor: C.bg },
  centred: { textAlign: 'center' },
  loading: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center',
    justifyContent: 'center', gap: S.sm, backgroundColor: C.bg,
  },
  fallback: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    gap: S.sm, paddingHorizontal: S.xl,
  },
  fallbackIcon: {
    width: 48, height: 48, borderRadius: R.card, backgroundColor: C.surface,
    alignItems: 'center', justifyContent: 'center', marginBottom: S.xs,
  },
  fallbackActs: { alignSelf: 'stretch', gap: S.sm, marginTop: S.md },
  acts: {
    gap: S.sm, paddingHorizontal: S.lg, paddingTop: S.md,
    backgroundColor: C.bg,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line,
  },
  actRow: { flexDirection: 'row', gap: S.sm },
  grow: { flex: 1 },
});
