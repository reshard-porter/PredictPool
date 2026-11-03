import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { Amount, Card, H2, KV, Loading, Notice, P, Screen, SplitBar } from '@/components/ui';
import { api } from '@/lib/api';
import { money, when } from '@/lib/money';
import { font, size, theme } from '@/lib/theme';
import { useLoad } from '@/lib/useLoad';

export default function StatementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: st, error } = useLoad(() => api.statement(id));
  const item = (label: string) => st?.items.find((i) => i.label === label)?.amountMinor ?? 0;
  const net = st?.items.find((i) => i.total)?.amountMinor ?? 0;
  return (
    <Screen title="Settlement" subtitle={st?.poolName} back hero={st ? (
      <View>
        <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.sm }}>
          {st.outcome === 'FULL_REFUND' ? 'Full refund to your balance' : st.isCorrect ? `You called it: ${st.selection}` : `Your pick: ${st.selection}`}
        </Text>
        <Amount minor={net} currency={st.currency} sz={size.hero + 4} color={st.isCorrect || st.outcome === 'FULL_REFUND' ? theme.mint : theme.onNight} sign />
        <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.sm }}>credited to your available balance</Text>
      </View>
    ) : undefined}>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {!st ? <Loading /> : (
        <>
          <Notice tone={st.outcome === 'PAYOUT' ? 'good' : 'info'}>{st.reason}</Notice>
          <Card>
            <H2>Your deposit</H2>
            <SplitBar refundMinor={item('Returned deposit')} feeMinor={-item('Platform fee')} currency={st.currency} />
            <View style={{ marginTop: 10 }}>
              <KV label="Deposit" value={money(item('Deposit'), st.currency)} />
              <KV label="Platform fee" value={money(item('Platform fee'), st.currency)} tone="red" />
              <KV label="Returned deposit" value={money(item('Returned deposit'), st.currency)} strong />
            </View>
          </Card>
          <Card>
            <H2>Prize</H2>
            <KV label="Your share (gross)" value={money(item('Prize bonus (gross)'), st.currency)} tone={item('Prize bonus (gross)') ? 'mint' : undefined} />
            <KV label="Withholding" value={money(item('Withholding'), st.currency)} />
            <KV label="Net credit" value={money(net, st.currency)} strong tone="mint" />
          </Card>
          <P muted small style={{ paddingHorizontal: 4 }}>Settled {when(st.settledAt)}. Ledger reference {st.ledgerTransactionId.slice(0, 8)}.</P>
        </>
      )}
    </Screen>
  );
}
