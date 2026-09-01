/**
 * Build-profile overrides on top of app.json.
 *
 * Expo reads app.json first and hands it to this function as `config`, so
 * app.json stays the single description of the app and this file holds only
 * the things that must differ between a dev build and a shipped one.
 *
 * Right now that is exactly one thing: cleartext HTTP.
 *
 * `usesCleartextTraffic` was true for every build, which is how you want a
 * development box to behave -- a laptop server on the LAN is plain http, and
 * the tunnel URL changes every restart. It is also how you get a release build
 * that will happily send a girl's live position over an unencrypted socket to
 * whatever address is typed into the server field, with nothing on screen to
 * say so. Android will not stop it, because we asked Android not to.
 *
 * So: on development and preview it stays on. On production it is off, and the
 * platform refuses plain http for us. ngrok already serves https, so the dev
 * tunnel is unaffected; what stops working on a production build is pointing
 * the app at `http://192.168.x.x:8000`, which is the intended outcome.
 *
 * EAS sets EAS_BUILD_PROFILE during a build. A local `expo prebuild` or
 * `expo run:android` sets nothing, and falls through to the permissive branch
 * -- correct, because that is a developer on their own machine.
 *
 * VERIFY THIS THE WAY THE TRAPS LIST SAYS: read android:usesCleartextTraffic
 * in the merged AndroidManifest.xml of the artifact. A green build proves
 * nothing about what ended up in the manifest.
 */

const PROFILE = process.env.EAS_BUILD_PROFILE || 'development';
const ALLOW_CLEARTEXT = PROFILE !== 'production';

module.exports = ({ config }) => {
  const plugins = (config.plugins || []).map((entry) => {
    if (!Array.isArray(entry) || entry[0] !== 'expo-build-properties') return entry;
    const [name, opts = {}] = entry;
    return [
      name,
      {
        ...opts,
        android: { ...(opts.android || {}), usesCleartextTraffic: ALLOW_CLEARTEXT },
      },
    ];
  });

  return { ...config, plugins };
};
