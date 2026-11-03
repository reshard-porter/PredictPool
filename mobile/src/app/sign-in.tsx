import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button, Card, Display, Field, Notice, P, Screen, SplitBar, s } from '@/components/ui';
import { useSession } from '@/lib/session';
import { font, size, theme } from '@/lib/theme';

export default function SignIn() {
  const { signIn, register } = useSession();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (mode === 'in') await signIn(email.trim(), password);
      else await register(name.trim(), email.trim(), password);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Screen title="PredictPool" hero={
      <View>
        <Display size={size.hero} color={theme.amber}>Pick the winner.</Display>
        <P style={{ color: theme.onNightMuted, marginTop: 10, maxWidth: 340 }}>
          Your deposit comes back after the result, minus a fee you see up front. Right picks share a prize put up by a sponsor.
        </P>
        <View style={{ marginTop: 20, backgroundColor: theme.nightSoft, borderRadius: 16, padding: 16 }}>
          <Text style={{ color: theme.onNight, fontFamily: font.bodySemi, fontSize: size.sm, marginBottom: 10 }}>On a 10.00 deposit</Text>
          <SplitBar refundMinor={950} feeMinor={50} onNight />
        </View>
      </View>
    }>
      <Card>
        <View style={[s.row, { backgroundColor: theme.bg, borderRadius: 12, padding: 4, marginBottom: 18 }]}>
          {(['in', 'up'] as const).map((m) => (
            <Pressable key={m} accessibilityRole="tab" accessibilityState={{ selected: mode === m }} onPress={() => { setMode(m); setError(null); }}
              style={{ flex: 1, paddingVertical: 10, borderRadius: 9, backgroundColor: mode === m ? '#fff' : 'transparent' }}>
              <Text style={{ textAlign: 'center', fontFamily: font.bodySemi, color: mode === m ? theme.ink : theme.muted }}>{m === 'in' ? 'Sign in' : 'Create account'}</Text>
            </Pressable>
          ))}
        </View>
        {mode === 'up' ? <Field label="Name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" /> : null}
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
        <Field label={mode === 'up' ? 'Password (8+ characters)' : 'Password'} value={password} onChangeText={setPassword} secureTextEntry
          autoComplete={mode === 'up' ? 'new-password' : 'current-password'} textContentType={mode === 'up' ? 'newPassword' : 'password'} onSubmitEditing={submit} />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Button label={mode === 'in' ? 'Sign in' : 'Create account'} onPress={submit} loading={busy} disabled={!email || !password} style={{ marginTop: 4 }} />
      </Card>
      <P muted small style={{ paddingHorizontal: 4 }}>You can lose the fee. There is no guaranteed profit. One entry per verified account in each pool.</P>
    </Screen>
  );
}
