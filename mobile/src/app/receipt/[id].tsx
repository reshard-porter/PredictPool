import { router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { Amount, Button, Display, KV, Loading, Notice, P, Screen, SplitBar, Ticket, s } from '@/components/ui';
import { api } from '@/lib/api';
import { font, size, theme } from '@/lib/theme';
import { useLoad } from '@/lib/useLoad';

export default function ReceiptScreen() {
  const { id, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const { data: r, error } = useLoad(() => api.receipt(id));
  const accepted = r ? new Date(r.acceptedAt) : null;
  return (
    <Screen title={fresh ? 'You’re in' : 'Your ticket'} subtitle={r?.poolName} back hero={r ? (
      <View>
        <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.sm }}>Your pick</Text>
        <Display size={size.hero - 4} color={theme.amber}>{r.selection.label}</Display>
      </View>
    ) : undefined}>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {!r || !accepted ? <Loading /> : (
        <>
          <Ticket stub={
            <View style={[s.row, s.between]}>
              <View>
                <Text style={{ fontFamily: font.body, color: theme.muted, fontSize: size.xs + 1 }}>Ticket</Text>
                <Text style={{ fontFamily: font.display, fontSize: size.xl, color: theme.ink, letterSpacing: 1 }}>{r.receiptId.replace('RCPT-', '')}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontFamily: font.body, color: theme.muted, fontSize: size.xs + 1 }}>Accepted, server time</Text>
                <Text style={{ fontFamily: font.display, fontSize: size.lg, color: theme.ink }}>{accepted.toISOString().slice(0, 10)} {accepted.toISOString().slice(11, 19)} UTC</Text>
              </View>
            </View>
          }>
            <View style={[s.row, s.between, { marginBottom: 14 }]}>
              <P muted>Deposit locked</P>
              <Amount minor={r.depositMinor} currency={r.currency} sz={size.xl} />
            </View>
            <SplitBar refundMinor={r.refundableMinor} feeMinor={r.feeMinor} currency={r.currency} />
            <View style={{ marginTop: 12 }}>
              <KV label="Rule version" value={r.rulesVersion} muted />
              <KV label="Terms fingerprint" value={r.termsHash.slice(0, 12)} muted />
              <KV label="Ledger reference" value={r.ledgerTransactionId.slice(0, 8)} muted />
              <KV label="Funds" value={r.fundsMode === 'SIMULATED' ? 'Simulated' : r.fundsMode} muted />
            </View>
          </Ticket>
          <P muted small style={{ paddingHorizontal: 4 }}>Your deposit stays locked until the official result is final and the pool settles. You’ll find this ticket under My entries.</P>
          <Button label="Done" kind="dark" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        </>
      )}
    </Screen>
  );
}
