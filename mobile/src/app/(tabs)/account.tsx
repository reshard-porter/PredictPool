import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Chips, Field, Gap, H2, KV, Notice, P, Pill, Screen, Sheet, s, toneFor } from '@/components/ui';
import { api } from '@/lib/api';
import { money, parseMinor, statusLabel, toInput, when } from '@/lib/money';
import { useSession } from '@/lib/session';
import { font, size, theme } from '@/lib/theme';

const PERIODS = [[1, '24 hours'], [7, '7 days'], [30, '30 days'], [180, '6 months']] as const;

export default function Account() {
  const { me, refresh, signOut, config } = useSession();
  const [limit, setLimit] = useState(me?.profile.dailyDepositLimitMinor != null ? toInput(me.profile.dailyDepositLimitMinor) : '');
  const [period, setPeriod] = useState<number>(7);
  const [sheet, setSheet] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const p = me?.profile;
  const excluded = p?.selfExcludedUntil && new Date(p.selfExcludedUntil) > new Date();
  const initials = (p?.displayName ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  const saveLimit = async () => {
    const v = parseMinor(limit);
    if (v === null) return setMsg({ tone: 'bad', text: 'Enter an amount, for example 200.00' });
    try { await api.setLimit(v); await refresh(); setMsg({ tone: 'good', text: `Daily deposit limit saved: ${money(v)}` }); }
    catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); }
  };
  const exclude = async () => {
    try { await api.selfExclude(period); await refresh(); setSheet(false); setMsg({ tone: 'good', text: 'Self-exclusion is on' }); }
    catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); setSheet(false); }
  };

  return (
    <Screen title="Account" onRefresh={() => void refresh()} hero={
      <View style={[s.row, { gap: 14 }]}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: theme.amber, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontFamily: font.display, fontSize: size.xl, color: theme.night }}>{initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: font.display, fontSize: size.xl, color: theme.onNight }}>{p?.displayName}</Text>
          <Text style={{ fontFamily: font.bodyMedium, fontSize: size.sm, color: theme.onNightMuted }}>{p?.email}</Text>
        </View>
      </View>
    }>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Card>
        <View style={[s.row, s.between]}>
          <H2 style={{ marginBottom: 0 }}>Identity</H2>
          <Pill label={statusLabel(p?.verificationStatus ?? 'UNVERIFIED')} tone={toneFor(p?.verificationStatus ?? 'UNVERIFIED')} />
        </View>
        <Gap h={8} />
        {p?.verificationStatus === 'VERIFIED' ? (
          <>
            <KV label="Document" value={p.documentMasked ?? '—'} />
            <KV label="Jurisdiction" value={p.jurisdiction ?? '—'} />
          </>
        ) : (
          <>
            <P muted>Verify once to add funds and enter pools.</P>
            <Gap h={10} />
            <Button label={p?.verificationStatus === 'REJECTED' ? 'Try verification again' : 'Verify identity'} onPress={() => router.push('/verify')} />
          </>
        )}
      </Card>

      <Card>
        <H2>Daily deposit limit</H2>
        <Field label="Limit per 24 hours" value={limit} onChangeText={setLimit} keyboardType="decimal-pad" />
        <Button kind="secondary" label="Save limit" onPress={saveLimit} />
      </Card>

      <Card>
        <H2>Take a break</H2>
        {excluded ? <Notice tone="warn">You’re on a break until {when(p!.selfExcludedUntil!)}. You can still withdraw.</Notice> : null}
        <P muted small style={{ marginBottom: 12 }}>Self-exclusion blocks deposits and new entries. It can’t be shortened once it starts.</P>
        <Chips options={PERIODS} value={period} onChange={setPeriod} />
        <Gap h={14} />
        <Button kind="danger" label={`Start a ${PERIODS.find(([d]) => d === period)?.[1]} break`} onPress={() => setSheet(true)} />
      </Card>

      <Card>
        <H2>About this build</H2>
        <KV label="Funds" value={config?.fundsMode === 'SIMULATED' ? 'Simulated' : config?.fundsMode ?? '—'} />
        <KV label="Launch region" value={config?.jurisdiction ?? '—'} />
        <KV label="Withholding" value={config?.withholdingRule === 'NONE_CONFIGURED' ? 'None configured' : config?.withholdingRule ?? '—'} />
      </Card>

      <Button kind="ghost" label="Sign out" onPress={() => void signOut()} />

      <Sheet visible={sheet} onClose={() => setSheet(false)} title="Start your break?">
        <P>No deposits or new entries for {PERIODS.find(([d]) => d === period)?.[1]}. Pools you’ve already entered still settle, and you can withdraw at any time.</P>
        <Gap h={16} />
        <Button kind="dark" label="Start break" onPress={exclude} />
        <Gap h={8} />
        <Button kind="ghost" label="Not now" onPress={() => setSheet(false)} />
      </Sheet>
    </Screen>
  );
}
