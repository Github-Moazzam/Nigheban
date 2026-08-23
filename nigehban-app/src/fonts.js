import { useEffect, useState } from 'react';

/**
 * Loads the two families the design system names, and never blocks on them.
 *
 * The same defensive shape as every other native dependency in this app: a
 * build made before the fonts were added still runs this JavaScript from
 * Metro, and a missing module has to degrade to the system face rather than
 * take the first screen down with it. `ready` therefore means "stop waiting",
 * not "the fonts arrived" -- if loading fails, React Native falls back to the
 * platform sans, and every size, weight and colour in the app still holds.
 */
export function useAppFonts() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { loadAsync } = require('expo-font');
        // Required one weight at a time. The package index pulls in all nine
        // faces of each family, and eight of them would ship in the APK unused.
        const Outfit_400Regular = require('@expo-google-fonts/outfit/400Regular/Outfit_400Regular.ttf');
        const Outfit_500Medium = require('@expo-google-fonts/outfit/500Medium/Outfit_500Medium.ttf');
        const Outfit_600SemiBold = require('@expo-google-fonts/outfit/600SemiBold/Outfit_600SemiBold.ttf');
        const SpaceGrotesk_500Medium = require('@expo-google-fonts/space-grotesk/500Medium/SpaceGrotesk_500Medium.ttf');
        const SpaceGrotesk_600SemiBold = require('@expo-google-fonts/space-grotesk/600SemiBold/SpaceGrotesk_600SemiBold.ttf');
        const SpaceGrotesk_700Bold = require('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf');

        await loadAsync({
          Outfit_400Regular, Outfit_500Medium, Outfit_600SemiBold,
          SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold,
        });
      } catch {
        /* system face it is */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  return ready;
}
