import React, { useState } from 'react';
import { View } from 'react-native';
import { S } from '../theme';
import { Button, Field } from '../ui';

/**
 * THE SECOND LOCK, asked for wherever the person actually is.
 *
 * There are two PIN prompts on the way to a linked band and only one of them
 * belongs to this app:
 *
 *   1. Android's own passkey dialog, raised by the OS the first time this phone
 *      pairs with the band. Nothing here draws it and nothing here can.
 *   2. This. The band asks again, over the now-encrypted link, because a bond
 *      proves the phone paired once and not that it still should be here.
 *
 * It lived only on the Band console to begin with, which was a mistake with an
 * obvious shape: the console is a diagnostics screen, Home is where somebody
 * presses CONNECT, and Home said "Band needs its PIN" with nothing to type
 * into. A gate you cannot reach from the screen that reports it is not a gate,
 * it is a dead end -- so it is a shared component and both screens mount it.
 *
 * Not the `PinSheet` keypad. That one is built for somebody being coerced --
 * its own keys, so the system keyboard cannot cover the cancel button -- and
 * this is a person setting up a wristband at a table. Reusing it would import
 * the constraint without the reason, and it is four digits deep besides.
 */
export default function BandPinEntry({ wrong, onSubmit, compact }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = /^\d{6}$/.test(pin);

  return (
    <View style={{ gap: S.sm }}>
      <Field
        label="Band PIN"
        value={pin}
        onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))}
        placeholder="six digits"
        keyboardType="number-pad"
        maxLength={6}
        secureTextEntry
        error={wrong ? 'The band did not accept this PIN.' : null}
        hint={compact
          ? 'The same six digits Android asked for.'
          : 'The same six digits Android asked for when it paired. A band '
            + 'nobody has changed is still on its factory PIN — the firmware '
            + 'prints it over USB at boot.'}
      />
      <Button
        title="UNLOCK THE BAND" filled icon="unlock"
        disabled={!ok || busy} loading={busy}
        onPress={async () => {
          setBusy(true);
          try { await onSubmit(pin); } finally { setBusy(false); }
        }}
      />
    </View>
  );
}
