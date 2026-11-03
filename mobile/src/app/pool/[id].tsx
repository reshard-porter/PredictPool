import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { FaceOff } from '@/components/faceoff';
import { Amount, Button, Card, Checkbox, Field, Gap, H2, KV, Loading, Notice, P, Pill, Screen, Sheet, SplitBar, s, toneFor } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { countdown, money, statusLabel, when } from '@/lib/money';
import { useSession } from '@/lib/session';
import { font, size, theme } from '@/lib/theme';
import { useLoad } from '@/lib/useLoad';
import type { Pool, Selection } from '@/lib/types';

/** Milliseconds until the deadline on the server's clock (client clock corrected by the skew seen at fetch time). */
function useCountdown(deadline: string | undefined, serverTime: string | undefined, receivedAt: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!deadline || !serverTime || receivedAt === undefined) return 0;
  const skew = new Date(serverTime).getTime() - receivedAt;
  return new Date(deadline).getTime() - (now + skew);
}

/** A selection on the floodlit band. Selected = amber; the winner after the result gets a mint edge. */
function SelectionTile({ sel, on, winner, disabled, currency, onPress }: {
  sel: Selection; on: boolean; winner: boolean; disabled: boolean; currency: string; onPress: () => void;
}) {
  return (
    <Pressable disabled={disabled} onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: on, disabled }}
      accessibilityLabel={`${sel.label}, ${sel.picks} picks, estimated bonus ${money(sel.bonusEstimate.estimateGrossMinor, currency)}`}
      style={({ pressed }) => [{
        borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12,
        backgroundColor: on ? theme.amber : theme.nightSoft, borderWidth: 2, borderColor: winner ? theme.mint : on ? theme.amber : theme.nightLine,
      }, pressed && { transform: [{ scale: 0.985 }] }]}>
      <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: on ? theme.night : theme.onNightMuted, alignItems: 'center', justifyContent: 'center' }}>
        {on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.night }} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: font.display, fontSize: size.xl - 4, color: on ? theme.night : theme.onNight }}>{sel.label}</Text>
        <Text style={{ fontFamily: font.bodyMedium, fontSize: size.xs + 1, color: on ? theme.night : theme.onNightMuted }}>
          {winner ? 'Official winner' : `${sel.picks} pick${sel.picks === 1 ? '' : 's'} so far`}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ fontFamily: font.bodyMedium, fontSize: size.xs, color: on ? theme.night : theme.onNightMuted }}>Bonus if right, est.</Text>
        <Text style={{ fontFamily: font.display, fontSize: size.lg + 2, color: on ? theme.night : theme.amber }}>{money(sel.bonusEstimate.estimateGrossMinor, currency)}</Text>
      </View>
    </Pressable>
  );
}

export default function PoolDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me, refresh: refreshMe } = useSession();
  const { data: p, error, refreshing, refresh, reload } = useLoad(async () => {
    const pool = await api.pool(id);
    return { ...pool, receivedAt: Date.now() };
  });
  const [pick, setPick] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const left = useCountdown(p?.entryDeadline, p?.serverTime, p?.receivedAt);

  if (!p) return <Screen title="Pool" back>{error ? <Notice tone="bad">{error}</Notice> : <Loading />}</Screen>;

  const d = p.disclosure;
  const mine = p.myEntry;
  const chosen = mine ? mine.selectionId : pick;
  const canEnter = p.status === 'OPEN' && !mine && left > 0;

  return (
    <Screen title={p.event.kind === 'MATCH' ? 'Match winner' : 'Tournament winner'} subtitle={`${p.event.sport}, ${p.entries} ${p.entries === 1 ? 'entry' : 'entries'} so far`} back refreshing={refreshing} onRefresh={refresh} hero={
      <View style={{ gap: 16 }}>
        <View style={[s.row, s.between, { alignItems: 'flex-start' }]}>
          <View style={{ flex: 1 }}><FaceOff pool={p} onNight /></View>
        </View>
        <View style={[s.row, { gap: 22 }]}>
          {p.status === 'OPEN' ? (
            <View>
              <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.xs + 1 }}>Entries close in</Text>
              <Text style={{ fontFamily: font.display, color: theme.amber, fontSize: size.xl, fontVariant: ['tabular-nums'] }}>{countdown(left)}</Text>
            </View>
          ) : <Pill label={statusLabel(p.status)} tone={toneFor(p.status)} onNight />}
          <View>
            <Text style={{ fontFamily: font.bodyMedium, color: theme.onNightMuted, fontSize: size.xs + 1 }}>Starts</Text>
            <Text style={{ fontFamily: font.display, color: theme.onNight, fontSize: size.xl }}>{when(p.event.startsAt)}</Text>
          </View>
        </View>
        <View style={{ gap: 10 }}>
          {p.selections.map((sel) => (
            <SelectionTile key={sel.id} sel={sel} on={chosen === sel.id} winner={p.winningSelectionId === sel.id}
              disabled={!canEnter} currency={p.currency} onPress={() => setPick(sel.id)} />
          ))}
        </View>
        {canEnter ? <Button label={pick ? 'Review entry' : 'Choose a winner to continue'} disabled={!pick} onPress={() => setConfirmOpen(true)} /> : null}
        {mine ? (
          <View style={[s.row, { gap: 10 }]}>
            <Button style={{ flex: 1 }} label="Receipt" kind="secondary" onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: mine.id } })} />
            {mine.status !== 'ACTIVE' ? <Button style={{ flex: 1 }} label="Statement" onPress={() => router.push({ pathname: '/statement/[id]', params: { id: mine.id } })} /> : null}
          </View>
        ) : null}
        <P small style={{ color: theme.onNightMuted }}>Bonus amounts are estimates. The prize is shared equally by everyone who picks the eventual winner, so it changes as others enter.</P>
      </View>
    }>
      {p.settlementReason ? <Notice tone={p.settlementOutcome === 'PAYOUT' ? 'good' : 'info'}>{p.settlementReason}</Notice> : null}

      <Card>
        <H2>Your deposit</H2>
        <View style={[s.row, s.between, { marginBottom: 14 }]}>
          <P muted>Locked until the pool settles</P>
          <Amount minor={d.depositMinor} currency={p.currency} sz={size.xl} />
        </View>
        <SplitBar refundMinor={d.refundableMinor} feeMinor={d.feeMinor} currency={p.currency} />
        <Gap h={10} />
        <KV label={`Platform fee, ${d.feeBps / 100}% of deposit`} value={`−${money(d.feeMinor, p.currency)}`} tone="red" />
        <KV label="Comes back to every participant" value={money(d.refundableMinor, p.currency)} tone="mint" strong />
        <Notice tone="bad">{d.youCanLose}</Notice>
      </Card>

      <Card>
        <H2>The prize</H2>
        <View style={[s.row, s.between]}>
          <P muted style={{ flex: 1 }}>Put up by the {d.prizeSource.toLowerCase()} and held in escrow. It never comes from deposits.</P>
          <Amount minor={d.prizeBudgetMinor} currency={p.currency} sz={size.xl} color={theme.mintDeep} />
        </View>
        <Gap h={6} />
        <KV label="Withholding" value={d.withholdingRule === 'NONE_CONFIGURED' ? 'None configured' : d.withholdingRule} muted />
        <KV label="Official result source" value={p.event.officialSource.replace(' (simulated official source)', '')} muted />
      </Card>

      <Card>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: rulesOpen }} onPress={() => setRulesOpen(!rulesOpen)} style={[s.row, s.between]}>
          <H2 style={{ marginBottom: 0 }}>Settlement rules</H2>
          <Text style={{ fontFamily: font.bodySemi, color: theme.info }}>{rulesOpen ? 'Hide' : 'Show'}</Text>
        </Pressable>
        <P muted small>Version {p.rulesVersion}. Cancelled events, unsupported ties and pools nobody gets right refund every deposit in full, with no fee.</P>
        {rulesOpen ? (
          <View style={{ marginTop: 10, gap: 8 }}>
            {p.settlementRules.map((r, i) => (
              <View key={i} style={[s.row, { alignItems: 'flex-start', gap: 10 }]}>
                <View style={[s.dot, { backgroundColor: theme.night, marginTop: 8 }]} />
                <P small style={{ flex: 1 }}>{r}</P>
              </View>
            ))}
            <P muted small>Terms fingerprint {p.termsHash.slice(0, 16)}</P>
          </View>
        ) : null}
      </Card>

      {mine && ['RESULT_REVIEW', 'RESULT_CONFIRMED', 'DISPUTED'].includes(p.status)
        ? <Button kind="ghost" label="Report a problem with the result" onPress={() => setDisputeOpen(true)} /> : null}

      {confirmOpen && pick ? (
        <ConfirmSheet pool={p} selectionId={pick} available={me?.balances.availableMinor ?? 0} verified={me?.profile.verificationStatus === 'VERIFIED'}
          onClose={() => setConfirmOpen(false)}
          onDone={async (entryId) => { setConfirmOpen(false); await refreshMe(); await reload(); router.push({ pathname: '/receipt/[id]', params: { id: entryId, fresh: '1' } }); }} />
      ) : null}
      {disputeOpen ? <DisputeSheet poolId={p.id} onClose={() => setDisputeOpen(false)} onDone={() => { setDisputeOpen(false); void reload(); }} /> : null}
    </Screen>
  );
}

function ConfirmSheet({ pool, selectionId, available, verified, onClose, onDone }: {
  pool: Pool; selectionId: string; available: number; verified: boolean; onClose: () => void; onDone: (entryId: string) => void;
}) {
  const [key] = useState(newIdempotencyKey);         // one key per confirmation: retries can't double-enter
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = pool.disclosure;
  const sel = pool.selections.find((x) => x.id === selectionId)!;
  const short = available < d.depositMinor;

  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.enter(pool.id, { selectionId, acceptedRulesVersion: pool.rulesVersion, acceptedTermsHash: pool.termsHash }, key);
      onDone(r.entryId);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Sheet visible onClose={onClose} title={`Back ${sel.label}?`}>
      <View style={{ backgroundColor: theme.bg, borderRadius: 16, padding: 16, gap: 12 }}>
        <View style={[s.row, s.between]}>
          <P>Deposit locked now</P>
          <Amount minor={d.depositMinor} currency={pool.currency} sz={size.xl} />
        </View>
        <SplitBar refundMinor={d.refundableMinor} feeMinor={d.feeMinor} currency={pool.currency} />
      </View>
      <Gap h={14} />
      <View style={{ gap: 10 }}>
        <Outcome tone="mint" title="If you’re right" body={`${money(d.refundableMinor, pool.currency)} back, plus about ${money(sel.bonusEstimate.estimateGrossMinor, pool.currency)} from the prize (estimate).`} />
        <Outcome tone="red" title="If you’re wrong" body={`${money(d.refundableMinor, pool.currency)} back. You lose the ${money(d.feeMinor, pool.currency)} fee.`} />
      </View>
      {!verified ? <Notice tone="bad">Verify your identity first, from the Account tab.</Notice> : null}
      {verified && short ? <Notice tone="bad">You have {money(available)} available, less than the deposit. Add funds in Wallet.</Notice> : null}
      <Checkbox checked={agree} onToggle={() => setAgree(!agree)} label={`I accept settlement rules ${pool.rulesVersion}`} />
      {err ? <Notice tone="bad">{err}</Notice> : null}
      <Button label={`Lock ${money(d.depositMinor, pool.currency)} and enter`} onPress={go} loading={busy} disabled={!agree || short || !verified} />
      <Gap h={8} />
      <Button kind="ghost" label="Not now" onPress={onClose} />
    </Sheet>
  );
}

function Outcome({ tone, title, body }: { tone: 'mint' | 'red'; title: string; body: string }) {
  const c = tone === 'mint' ? theme.mint : theme.red;
  return (
    <View style={[s.row, { alignItems: 'flex-start', gap: 12 }]}>
      <View style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, backgroundColor: c }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: font.bodyBold, color: theme.ink, fontSize: size.md - 1 }}>{title}</Text>
        <P small muted>{body}</P>
      </View>
    </View>
  );
}

function DisputeSheet({ poolId, onClose, onDone }: { poolId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try { await api.dispute(poolId, reason.trim()); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Report a result problem">
      <P muted small>Settlement waits while your report is reviewed against the official source.</P>
      <Gap h={12} />
      <Field label="What’s wrong with the result?" value={reason} onChangeText={setReason} multiline numberOfLines={4} style={{ minHeight: 110, textAlignVertical: 'top' }} />
      {err ? <Notice tone="bad">{err}</Notice> : null}
      <Button kind="dark" label="Send report" onPress={go} loading={busy} disabled={reason.trim().length < 5} />
    </Sheet>
  );
}
