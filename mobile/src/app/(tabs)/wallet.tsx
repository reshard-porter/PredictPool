import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Amount, Button, Card, Chips, Field, H2, Loading, Notice, P, Pill, Screen, s, toneFor } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { money, parseMinor, statusLabel, toInput, when } from '@/lib/money';
import { useSession } from '@/lib/session';
import { font, size, theme } from '@/lib/theme';
import { useLoad } from '@/lib/useLoad';

const QUICK = [1000, 2500, 5000] as const;
const TYPE_LABEL: Record<string, string> = {
  DEPOSIT: 'Added funds', ENTRY_DEPOSIT_LOCKED: 'Deposit locked for a pool', SETTLEMENT_PAYOUT: 'Pool settled', SETTLEMENT_FULL_REFUND: 'Pool refunded',
  WITHDRAWAL_HOLD: 'Withdrawal requested', WITHDRAWAL_PAID: 'Withdrawal paid', WITHDRAWAL_REVERSED: 'Withdrawal returned',
};
const ACCOUNT_LABEL: Record<string, string> = { USER_AVAILABLE: 'Available', USER_LOCKED: 'Locked', USER_PENDING_WITHDRAWAL: 'Pending withdrawal' };

/** Available / locked / pending as one stacked bar. */
function BalanceBar({ a, l, p }: { a: number; l: number; p: number }) {
  const total = a + l + p;
  if (!total) return <View style={{ height: 10, borderRadius: 5, backgroundColor: theme.nightLine }} />;
  return (
    <View style={{ height: 10, borderRadius: 5, overflow: 'hidden', flexDirection: 'row', gap: 2 }}>
      {a ? <View style={{ flex: a, backgroundColor: theme.amber }} /> : null}
      {l ? <View style={{ flex: l, backgroundColor: theme.onNightMuted }} /> : null}
      {p ? <View style={{ flex: p, backgroundColor: theme.mint }} /> : null}
    </View>
  );
}

function Legend({ color, label, minor }: { color: string; label: string; minor: number }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={s.row}><View style={[s.dot, { backgroundColor: color }]} /><Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.xs + 1 }}>{label}</Text></View>
      <Text style={{ fontFamily: font.display, color: theme.onNight, fontSize: size.lg }}>{money(minor)}</Text>
    </View>
  );
}

export default function Wallet() {
  const { me, refresh: refreshMe } = useSession();
  const { data, error, refreshing, refresh, reload } = useLoad(async () => {
    const [m, wd, tx] = await Promise.all([refreshMe(), api.withdrawals(), api.transactions()]);
    return { m, wd, tx };
  });
  const [dep, setDep] = useState<string>(toInput(2500));
  const [wdr, setWdr] = useState('');
  const [busy, setBusy] = useState<'dep' | 'wd' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const inFlight = data?.wd.some((w) => w.status === 'REQUESTED' || w.status === 'PROCESSING');
  useEffect(() => { if (!inFlight) return; const t = setInterval(() => void reload(), 1500); return () => clearInterval(t); }, [inFlight, reload]);

  const b = data?.m?.balances ?? me?.balances;
  const verified = me?.profile.verificationStatus === 'VERIFIED';

  const deposit = async () => {
    const amt = parseMinor(dep);
    if (!amt) return setMsg({ tone: 'bad', text: 'Enter an amount, for example 25.00' });
    setBusy('dep'); setMsg(null);
    try {
      const d = await api.createDeposit(amt, newIdempotencyKey());
      const r = await api.simulateCheckout(d.depositId);
      setMsg({ tone: 'good', text: r.status === 'credited' ? `Added ${money(amt)} to your balance` : `Deposit ${r.status}` });
      await reload();
    } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } finally { setBusy(null); }
  };
  const withdraw = async () => {
    const amt = parseMinor(wdr || (b ? toInput(b.availableMinor) : ''));
    if (!amt) return setMsg({ tone: 'bad', text: 'Enter an amount, for example 25.00' });
    setBusy('wd'); setMsg(null);
    try { await api.withdraw(amt, newIdempotencyKey()); setMsg({ tone: 'good', text: `Withdrawal of ${money(amt)} requested` }); setWdr(''); await reload(); }
    catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } finally { setBusy(null); }
  };

  return (
    <Screen title="Wallet" refreshing={refreshing} onRefresh={refresh} hero={b ? (
      <View style={{ gap: 14 }}>
        <View>
          <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.sm }}>Available to play or withdraw</Text>
          <Amount minor={b.availableMinor} sz={size.hero + 4} color={theme.onNight} />
        </View>
        <BalanceBar a={b.availableMinor} l={b.lockedMinor} p={b.pendingWithdrawalMinor} />
        <View style={s.row}>
          <Legend color={theme.amber} label="Available" minor={b.availableMinor} />
          <Legend color={theme.onNightMuted} label="Locked in pools" minor={b.lockedMinor} />
          <Legend color={theme.mint} label="On its way out" minor={b.pendingWithdrawalMinor} />
        </View>
      </View>
    ) : <Loading onNight />}>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}

      <Card>
        <H2>Add funds</H2>
        {!verified ? <Notice tone="warn">Verify your identity in Account before adding funds.</Notice> : null}
        <Chips options={QUICK.map((q) => [toInput(q), money(q)] as const)} value={dep} onChange={setDep} />
        <View style={{ height: 12 }} />
        <Field label="Amount" value={dep} onChangeText={setDep} keyboardType="decimal-pad" />
        <Button label={`Add ${parseMinor(dep) ? money(parseMinor(dep)!) : 'funds'}`} onPress={deposit} loading={busy === 'dep'} disabled={!verified} />
        <P muted small style={{ marginTop: 10 }}>Simulated checkout. Your balance updates when the payment provider confirms.</P>
      </Card>

      <Card>
        <H2>Withdraw</H2>
        <Field label="Amount" value={wdr} onChangeText={setWdr} keyboardType="decimal-pad" placeholder={b ? toInput(b.availableMinor) : ''}
          hint="Leave empty to withdraw everything available." />
        <Button kind="dark" label="Withdraw" onPress={withdraw} loading={busy === 'wd'} disabled={!b || b.availableMinor === 0} />
        <P muted small style={{ marginTop: 10 }}>If a payout fails, the money comes straight back to your available balance.</P>
      </Card>

      {data?.wd.length ? (
        <Card>
          <H2>Withdrawals</H2>
          {data.wd.map((w, i) => (
            <View key={w.withdrawalId} style={[s.row, s.between, { paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: theme.line }]}>
              <View style={{ flex: 1, gap: 4 }}>
                <Pill label={statusLabel(w.status)} tone={toneFor(w.status)} />
                <P muted small>{when(w.createdAt)}{w.failureReason ? `, ${w.failureReason.replace(/_/g, ' ').toLowerCase()}` : ''}</P>
              </View>
              <Amount minor={w.amountMinor} sz={size.lg} />
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <H2>Activity</H2>
        {!data ? <Loading /> : data.tx.length === 0 ? <P muted>Nothing yet. Add funds to get started.</P> : data.tx.map((t, i) => (
          <View key={t.transactionId + i} style={[s.row, s.between, { paddingVertical: 11, borderTopWidth: i ? 1 : 0, borderTopColor: theme.line }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: font.bodySemi, color: theme.ink, fontSize: size.md - 1 }}>{TYPE_LABEL[t.type] ?? statusLabel(t.type)}</Text>
              <P muted small>{when(t.at)}, {ACCOUNT_LABEL[t.account] ?? t.account} balance</P>
            </View>
            <Amount minor={t.amountMinor} sz={size.lg} color={t.amountMinor > 0 ? theme.mintDeep : theme.ink} sign />
          </View>
        ))}
      </Card>
    </Screen>
  );
}
