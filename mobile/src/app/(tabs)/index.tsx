import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { FaceOff } from '@/components/faceoff';
import { Amount, Loading, Notice, P, Pill, Screen, Section, SplitBar, Ticket, s, toneFor } from '@/components/ui';
import { api } from '@/lib/api';
import { countdown, money, statusLabel, when } from '@/lib/money';
import { useSession } from '@/lib/session';
import { font, size, theme } from '@/lib/theme';
import { useLoad } from '@/lib/useLoad';
import { useNow } from '@/lib/useNow';
import type { Pool } from '@/lib/types';

function PoolTicket({ p, now }: { p: Pool; now: number }) {
  const d = p.disclosure;
  const open = p.status === 'OPEN';
  const left = new Date(p.entryDeadline).getTime() - now;
  return (
    <Ticket label={`${p.name}, ${statusLabel(p.status)}`} onPress={() => router.push({ pathname: '/pool/[id]', params: { id: p.id } })}
      stub={
        <View style={{ gap: 12 }}>
          <SplitBar refundMinor={d.refundableMinor} feeMinor={d.feeMinor} currency={p.currency} />
          <View style={[s.row, s.between]}>
            <Text style={{ fontFamily: font.bodyMedium, color: theme.muted, fontSize: size.sm }}>Prize for right picks</Text>
            <Amount minor={d.prizeBudgetMinor} currency={p.currency} sz={size.lg} />
          </View>
        </View>
      }>
      <View style={[s.row, s.between, { marginBottom: 12 }]}>
        <Text style={{ fontFamily: font.bodySemi, color: theme.muted, fontSize: size.sm }}>{p.event.sport} {p.event.kind === 'MATCH' ? 'match' : 'tournament'}</Text>
        {open ? <Pill label={p.myEntry ? 'You’re in' : 'Open'} tone="good" /> : <Pill label={statusLabel(p.status)} tone={toneFor(p.status)} />}
      </View>
      <FaceOff pool={p} compact />
      <View style={[s.row, { marginTop: 14, gap: 18 }]}>
        <View>
          <Text style={{ fontFamily: font.body, color: theme.muted, fontSize: size.xs + 1 }}>{open ? 'Entries close in' : 'Event'}</Text>
          <Text style={{ fontFamily: font.display, fontSize: size.lg, color: theme.ink }}>{open ? countdown(left) : when(p.event.startsAt)}</Text>
        </View>
        <View>
          <Text style={{ fontFamily: font.body, color: theme.muted, fontSize: size.xs + 1 }}>Deposit</Text>
          <Text style={{ fontFamily: font.display, fontSize: size.lg, color: theme.ink }}>{money(d.depositMinor, p.currency)}</Text>
        </View>
        <View>
          <Text style={{ fontFamily: font.body, color: theme.muted, fontSize: size.xs + 1 }}>Entries</Text>
          <Text style={{ fontFamily: font.display, fontSize: size.lg, color: theme.ink }}>{p.entries}</Text>
        </View>
      </View>
    </Ticket>
  );
}

export default function Pools() {
  const { me } = useSession();
  const { data, error, refreshing, refresh } = useLoad(api.pools);
  const now = useNow(1000);
  const open = (data ?? []).filter((p) => p.status === 'OPEN');
  const rest = (data ?? []).filter((p) => p.status !== 'OPEN');
  const unverified = me && me.profile.verificationStatus !== 'VERIFIED';
  return (
    <Screen title="Pools" refreshing={refreshing} onRefresh={refresh} hero={me ? (
      <View style={[s.row, { alignItems: 'flex-end', justifyContent: 'space-between' }]}>
        <View>
          <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.sm }}>Ready to play</Text>
          <Amount minor={me.balances.availableMinor} sz={size.hero - 8} color={theme.onNight} />
        </View>
        <Pressable accessibilityRole="button" onPress={() => router.push('/wallet')} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: theme.amber }}>
          <Text style={{ fontFamily: font.bodyBold, color: theme.night }}>Add funds</Text>
        </Pressable>
      </View>
    ) : undefined}>
      {unverified ? (
        <Pressable accessibilityRole="button" onPress={() => router.push('/verify')}>
          <Notice tone="warn">Verify your identity to add funds and enter pools. Tap to start.</Notice>
        </Pressable>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data && open.length === 0 ? <P muted>No pools are open right now. Pull down to check again.</P> : null}
      {open.length ? <Section title={`Open now (${open.length})`}>{open.map((p) => <PoolTicket key={p.id} p={p} now={now} />)}</Section> : null}
      {rest.length ? <Section title="Closed and settled">{rest.map((p) => <PoolTicket key={p.id} p={p} now={now} />)}</Section> : null}
      {data ? <P muted small style={{ textAlign: 'center', marginTop: 4 }}>Results come from each event’s official source.</P> : null}
    </Screen>
  );
}
