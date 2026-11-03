import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Chips, Field, Notice, P, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const JURISDICTIONS = [['DEMO', 'DEMO region'], ['OTHER', 'Somewhere else']] as const;

export default function Verify() {
  const { me, refresh } = useSession();
  const [fullName, setFullName] = useState(me?.profile.displayName ?? '');
  const [dob, setDob] = useState('');
  const [doc, setDoc] = useState('');
  const [jur, setJur] = useState<string>('DEMO');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.verify({ fullName: fullName.trim(), dateOfBirth: dob.trim(), documentNumber: doc.trim(), jurisdiction: jur });
      await refresh();
      if (r.status === 'VERIFIED') router.back();
      else setErr(`We couldn’t verify you: ${r.reasons.map((x) => x.replace(/_/g, ' ').toLowerCase()).join(', ')}.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Screen title="Verify identity" subtitle="Needed once, before you add funds" back>
      <Card>
        <Field label="Full legal name" value={fullName} onChangeText={setFullName} textContentType="name" />
        <Field label="Date of birth" value={dob} onChangeText={setDob} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" maxLength={10} />
        <Field label="ID document number" value={doc} onChangeText={setDoc} autoCapitalize="characters" />
        <P muted small style={{ marginBottom: 8 }}>Where you live</P>
        <Chips options={JURISDICTIONS} value={jur} onChange={setJur} />
        <View style={{ height: 18 }} />
        {err ? <Notice tone="bad">{err}</Notice> : null}
        <Button label="Verify me" onPress={submit} loading={busy} disabled={!fullName || dob.length !== 10 || doc.length < 6} />
      </Card>
      <P muted small style={{ paddingHorizontal: 4 }}>Simulated check. Your details are encrypted; staff only see the last four characters of your document number.</P>
    </Screen>
  );
}
