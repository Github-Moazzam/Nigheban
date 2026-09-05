import React, { useState } from 'react';
import {
  ActivityIndicator, Linking, Modal, Platform, Pressable, Share, StyleSheet,
  Text, View,
} from 'react-native';
import { SERVER_URL } from '../api';
import { C, S, T } from '../theme';
import { Icon, Txt } from '../ui';

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
 */
export function liveUrl(session, alert) {
  const path = alert?.share_path;
  if (!path) return null;
  // `session.url` OR SERVER_URL, exactly as `call` in api.js resolves it. Most
  // sessions carry no url at all -- the server address stopped being something
  // the app asks for -- so reading only the session would have left the live
  // map permanently unavailable while every other request worked fine.
  const base = (session?.url || SERVER_URL || '').replace(/\/+$/, '');
  return base ? base + path : null;
}

export default function LiveMap({ visible, alert, session, onClose }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const url = liveUrl(session, alert);
  const name = alert?.user?.name || 'They';

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

  const canEmbed = !!WebView && !!url && !failed;
  // The one origin this view may ever show. Without it a redirect could put
  // anything at all on a screen somebody reached from a siren.
  const origin = (session?.url || SERVER_URL || '').replace(/\/+$/, '');

  const shareLink = async () => {
    if (!url) return;
    try {
      await Share.share({
        message: `${name} needs help. Watch their live location: ${url}`,
        url,
      });
    } catch { /* the sheet was dismissed */ }
  };

  return (
    <Modal visible={!!visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.root}>
        <View style={s.head}>
          <View style={{ flex: 1 }}>
            <Txt variant="h2" color={C.text}>{name}</Txt>
            <Text style={[T.meta, { color: C.dim }]}>
              {canEmbed
                ? 'Live location — the map moves as they do'
                : 'Last known position'}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close the map"
            style={({ pressed }) => [s.close, pressed && { opacity: 0.7 }]}
          >
            <Icon name="x" size={18} color={C.text} />
          </Pressable>
        </View>

        <View style={{ flex: 1 }}>
          {canEmbed ? (
            <>
              <WebView
                source={{ uri: url }}
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
              <Icon name="map-pin" size={28} color={C.amber} />
              <Txt variant="h2" color={C.text} style={{ textAlign: 'center' }}>
                Live map unavailable
              </Txt>
              <Text style={[T.body, { color: C.dim, textAlign: 'center' }]}>
                {alert?.maps
                  ? 'Open their last reported position in Maps instead. It will not update as they move.'
                  : 'No position has been reported for this alert.'}
              </Text>
              {alert?.maps ? (
                <Pressable
                  onPress={() => Linking.openURL(alert.maps)}
                  style={({ pressed }) => [s.btn, pressed && { opacity: 0.8 }]}
                >
                  <Text style={[T.button, { color: C.bg }]}>OPEN IN MAPS</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>

        <View style={s.acts}>
          {lat != null ? (
            <Pressable
              onPress={openDirections}
              style={({ pressed }) => [s.btn, { flex: 1 }, pressed && { opacity: 0.8 }]}
            >
              <Icon name="navigation" size={16} color={C.bg} />
              <Text style={[T.button, { color: C.bg }]}>DIRECTIONS</Text>
            </Pressable>
          ) : null}
          {url ? (
            // The reason the link exists at all. The person who most needs it
            // is often not a Nigehban user -- the police, a neighbour, the
            // cousin who never installed anything -- and this is how it
            // reaches them.
            <Pressable
              onPress={shareLink}
              style={({ pressed }) => [s.btn, s.ghost, { flex: 1 }, pressed && { opacity: 0.8 }]}
            >
              <Icon name="share-2" size={16} color={C.text} />
              <Text style={[T.button, { color: C.text }]}>SEND LINK</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: S.md,
    paddingHorizontal: S.lg, paddingTop: S.xxl, paddingBottom: S.md,
  },
  close: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center',
    justifyContent: 'center', backgroundColor: C.card,
  },
  loading: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center',
    justifyContent: 'center', gap: S.sm, backgroundColor: C.bg,
  },
  fallback: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    gap: S.md, padding: S.xl,
  },
  acts: {
    flexDirection: 'row', gap: S.sm, padding: S.lg, paddingBottom: S.xxl,
  },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: S.sm, minHeight: 50, borderRadius: 12, paddingHorizontal: S.lg,
    backgroundColor: C.green,
  },
  ghost: { backgroundColor: C.card },
});
