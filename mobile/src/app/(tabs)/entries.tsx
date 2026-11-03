import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Amount, Button, Loading, Notice, P, Pill, Screen, Section, Ticket, s, toneFor } from '@/components/ui';
import { api } from '@/lib/api';
import { statusLabel, when } from '@/lib/money';
import { font, size, theme } from '@/lib/theme';
import { useLoad } from '@/lib/useLoad';
import type { MyEntry } from '@/lib/types';

function EntryTicket({ e }: { e: MyEntry }) {
  const open = () => router.push(e.settled ? { pathname: '/statement/[id]', params: { id: e.entryId } } : { pathname: '/pool/[id]', params: { id: e.poolId } });
  return (
    <Ticket label={`${e.poolName}, your pick ${e.selection}`} onPress={open} stub={
      <View style={[s.row, s.between]}>
        <Text style={{ fontFamily: font.bodyMedium, color: theme.muted, fontSize: size.sm }}>{e.settled ? 'Credited to you' : 'Locked deposit'}</Text>
        <Amount minor={e.settled ? e.netCreditMinor ?? 0 : e.depositMinor} currency={e.currency} sz={size.xl - 2} color={e.settled ? theme.mintDeep : theme.ink} sign={e.settled} />
      </View>
    }>
      <View style={[s.row, s.between, { marginBottom: 8 }]}>
        <Pill label={e.settled && e.isCorrect ? 'Called it' : statusLabel(e.poolStatus)} tone={e.settled && e.isCorrect ? 'good' : toneFor(e.poolStatus)} />
        <Text style={{ fontFamily: font.body, color: theme.muted, fontSize: size.xs + 1 }}>{when(e.acceptedAt)}</Text>
      </View>
      <Text style={{ fontFamily: font.display, fontSize: size.xl, color: theme.ink }}>{e.selection}</Text>
      <P muted small>{e.eventName}</P>
    </Ticket>
  );
}

export default function Entries() {
  const { data, error, refreshing, refresh } = useLoad(api.myEntries);
  const active = (data ?? []).filter((e) => !e.settled);
  const done = (data ?? []).filter((e) => e.settled);
  const locked = active.reduce((sum, e) => sum + e.depositMinor, 0);
  const credited = done.reduce((sum, e) => sum + (e.netCreditMinor ?? 0), 0);
  return (
    <Screen title="My entries" refreshing={refreshing} onRefresh={refresh} hero={data ? (
      <View style={[s.row, { gap: 28 }]}>
        <View>
          <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.sm }}>{active.length ? `Locked in ${active.length} ${active.length === 1 ? 'pool' : 'pools'}` : 'Nothing locked'}</Text>
          <Amount minor={locked} sz={size.xxl} color={theme.onNight} />
        </View>
        <View>
          <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.sm }}>{done.length ? `Credited from ${done.length} settled` : 'Credited so far'}</Text>
          <Amount minor={credited} sz={size.xxl} color={theme.mint} />
        </View>
      </View>
    ) : undefined}>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data && data.length === 0 ? (
        <View style={{ gap: 12, paddingTop: 8 }}>
          <P muted>You haven’t entered a pool yet. Pick a winner in an open pool to get your first ticket.</P>
          <Button kind="dark" label="See open pools" onPress={() => router.push('/')} />
        </View>
      ) : null}
      {active.length ? <Section title="Waiting on a result">{active.map((e) => <EntryTicket key={e.entryId} e={e} />)}</Section> : null}
      {done.length ? <Section title="Settled">{done.map((e) => <EntryTicket key={e.entryId} e={e} />)}</Section> : null}
    </Screen>
  );
}
