import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { font, size, theme as t } from '@/lib/theme';
import { money } from '@/lib/money';

/* ───────────────────────────── text ───────────────────────────── */

export function Display({ children, size: sz = size.xxl, color = t.ink, style, lines }: {
  children: ReactNode; size?: number; color?: string; style?: StyleProp<TextStyle>; lines?: number;
}) {
  return <Text numberOfLines={lines} style={[{ fontFamily: font.display, fontSize: sz, lineHeight: Math.round(sz * 1.08), color, letterSpacing: 0.2 }, style]}>{children}</Text>;
}

export const P = ({ children, muted, small, style }: { children: ReactNode; muted?: boolean; small?: boolean; style?: StyleProp<TextStyle> }) =>
  <Text style={[s.p, small && s.small, muted && s.muted, style]}>{children}</Text>;

export const H2 = ({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) =>
  <Text style={[s.h2, style]} accessibilityRole="header">{children}</Text>;

export function Amount({ minor, currency, sz = size.lg, color = t.ink, sign }: { minor: number; currency?: string; sz?: number; color?: string; sign?: boolean }) {
  const txt = money(minor, currency);
  return <Text style={{ fontFamily: font.display, fontSize: sz, color, fontVariant: ['tabular-nums'] }}>{sign && minor > 0 ? '+' : ''}{txt}</Text>;
}

/* ───────────────────────────── screen ───────────────────────────── */

/**
 * Every screen opens on a floodlit band (night indigo) that carries the title and the screen's
 * key figure (`hero`); content sits below on the light pitch-line background.
 */
export function Screen({ title, subtitle, back, hero, children, refreshing, onRefresh, right }: {
  title: string; subtitle?: string; back?: boolean; hero?: ReactNode; children?: ReactNode;
  refreshing?: boolean; onRefresh?: () => void; right?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={s.screen}>
      {/* night backdrop behind the top half so iOS overscroll stays dark */}
      <View pointerEvents="none" style={s.backdropTop} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={t.amber} colors={[t.night]} /> : undefined}>
          <View style={[s.band, { paddingTop: insets.top + 10 }]}>
            <View style={s.headerRow}>
              {back ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}
                  onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} style={s.back}>
                  <View style={s.chevron} />
                </Pressable>
              ) : null}
              <View style={{ flex: 1 }} />
              {right ?? <SimChip />}
            </View>
            <Display size={size.xxl} color={t.onNight} lines={3} style={{ marginTop: 6 }}>{title}</Display>
            {subtitle ? <Text style={s.bandSub} numberOfLines={2}>{subtitle}</Text> : null}
            {hero ? <View style={{ marginTop: 18 }}>{hero}</View> : null}
          </View>
          <View style={[s.content, { paddingBottom: 36 + insets.bottom }]}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

export const SimChip = () => (
  <View style={s.simChip} accessibilityLabel="Simulated funds. No real money moves.">
    <View style={[s.dot, { backgroundColor: t.amber }]} />
    <Text style={s.simText}>Simulated funds</Text>
  </View>
);

/* ───────────────────────────── surfaces ───────────────────────────── */

export const Card = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => <View style={[s.card, style]}>{children}</View>;

/** A ticket: main body, a perforated tear line with notches, and a stub. */
export function Ticket({ children, stub, onPress, label, notch = t.bg }: {
  children: ReactNode; stub?: ReactNode; onPress?: () => void; label?: string; notch?: string;
}) {
  const body = (
    <>
      <View style={s.ticketBody}>{children}</View>
      {stub ? (
        <>
          <View style={s.tear}>
            <View style={[s.notch, { left: -11, backgroundColor: notch }]} />
            <View style={s.perf} />
            <View style={[s.notch, { right: -11, backgroundColor: notch }]} />
          </View>
          <View style={s.ticketStub}>{stub}</View>
        </>
      ) : null}
    </>
  );
  if (!onPress) return <View style={s.ticket}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [s.ticket, pressed && { transform: [{ scale: 0.985 }] }]}>
      {body}
    </Pressable>
  );
}

/** The deposit, split into what comes back (mint) and the fee you can lose (red). */
export function SplitBar({ refundMinor, feeMinor, currency, onNight, labels = true }: {
  refundMinor: number; feeMinor: number; currency?: string; onNight?: boolean; labels?: boolean;
}) {
  const total = Math.max(1, refundMinor + feeMinor);
  const feePct = feeMinor === 0 ? 0 : Math.max(2.5, (feeMinor / total) * 100);
  const txt = onNight ? t.onNightMuted : t.muted;
  return (
    <View accessibilityLabel={`${money(refundMinor, currency)} comes back to you, ${money(feeMinor, currency)} fee`}>
      <View style={[s.bar, { backgroundColor: onNight ? t.nightLine : t.line }]}>
        <View style={{ flex: 100 - feePct, backgroundColor: t.mint }} />
        {feePct ? <View style={{ flex: feePct, backgroundColor: t.red, marginLeft: 2 }} /> : null}
      </View>
      {labels ? (
        <View style={[s.row, { justifyContent: 'space-between', marginTop: 8 }]}>
          <View style={s.row}><View style={[s.dot, { backgroundColor: t.mint }]} /><Text style={[s.legend, { color: txt }]}>Back to you {money(refundMinor, currency)}</Text></View>
          <View style={s.row}><View style={[s.dot, { backgroundColor: t.red }]} /><Text style={[s.legend, { color: txt }]}>Fee {money(feeMinor, currency)}</Text></View>
        </View>
      ) : null}
    </View>
  );
}

/* ───────────────────────────── controls ───────────────────────────── */

type BtnKind = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger';
export function Button({ label, onPress, kind = 'primary', disabled, loading, small, style }: {
  label: string; onPress: () => void; kind?: BtnKind; disabled?: boolean; loading?: boolean; small?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const [bg, fg, border] = ({
    primary: [t.amber, t.night, t.amber], dark: [t.night, '#fff', t.night], secondary: ['#fff', t.night, t.night],
    ghost: ['transparent', t.ink, t.line], danger: [t.redSoft, t.redDeep, t.redSoft],
  } as const)[kind];
  const off = disabled || loading;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: off, busy: loading }}
      disabled={off} onPress={onPress}
      style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: bg, borderColor: border },
        off && { backgroundColor: kind === 'primary' ? '#E6E7F0' : bg, borderColor: kind === 'primary' ? '#E6E7F0' : border },
        pressed && !off && { transform: [{ scale: 0.98 }] }, style]}>
      {loading ? <ActivityIndicator color={fg} /> : (
        <Text style={[s.btnText, small && { fontSize: 15 }, { color: off && kind === 'primary' ? t.muted : fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const TONES = {
  good: [t.mintSoft, t.mintDeep, t.mint], warn: [t.amberSoft, t.amberDeep, t.amber], bad: [t.redSoft, t.redDeep, t.red],
  info: [t.infoSoft, t.info, t.info], muted: ['#E8E9F1', t.muted, '#A3A6BD'],
} as const;
type Tone = keyof typeof TONES;

export function toneFor(status: string): Tone {
  if (['OPEN', 'SETTLED', 'PAID', 'VERIFIED'].includes(status)) return 'good';
  if (['LOCKED', 'RESULT_REVIEW', 'RESULT_CONFIRMED', 'SETTLING', 'REQUESTED', 'PROCESSING', 'PENDING'].includes(status)) return 'warn';
  if (['DISPUTED', 'CANCELLED', 'FAILED', 'REJECTED'].includes(status)) return 'bad';
  if (['REFUNDED', 'UNVERIFIED'].includes(status)) return 'muted';
  return 'info';
}

export function Pill({ label, tone = 'info', onNight }: { label: string; tone?: Tone; onNight?: boolean }) {
  const [bg, fg, dot] = TONES[tone];
  return (
    <View style={[s.pill, { backgroundColor: onNight ? t.nightSoft : bg }]}>
      <View style={[s.dot, { backgroundColor: dot }]} />
      <Text style={[s.pillText, { color: onNight ? t.onNight : fg }]}>{label}</Text>
    </View>
  );
}

export function KV({ label, value, strong, muted, tone }: { label: string; value: string; strong?: boolean; muted?: boolean; tone?: 'mint' | 'red' }) {
  const color = tone === 'mint' ? t.mintDeep : tone === 'red' ? t.redDeep : muted ? t.muted : t.ink;
  return (
    <View style={[s.kv, strong && s.kvStrong]}>
      <Text style={[s.kvLabel, strong && { fontFamily: font.bodyBold }, muted && s.muted]}>{label}</Text>
      <Text style={[s.kvValue, strong && { fontFamily: font.bodyBold }, { color }]}>{value}</Text>
    </View>
  );
}

export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  const [bg, fg, bar] = TONES[tone];
  return (
    <View style={[s.notice, { backgroundColor: bg, borderLeftColor: bar }]}>
      <Text style={{ color: fg, fontFamily: font.bodyMedium, fontSize: size.sm, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor="#A3A6BD"
        {...props}
        onFocus={(e) => { setFocus(true); props.onFocus?.(e); }}
        onBlur={(e) => { setFocus(false); props.onBlur?.(e); }}
        style={[s.input, focus && { borderColor: t.night, borderWidth: 2, paddingHorizontal: 13 }, props.style]} />
      {hint ? <Text style={[s.small, s.muted, { marginTop: 6 }]}>{hint}</Text> : null}
    </View>
  );
}

/** Chip-style single choice. */
export function Chips<T extends string | number>({ options, value, onChange }: { options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={[s.row, { flexWrap: 'wrap', gap: 8 }]}>
      {options.map(([v, l]) => {
        const on = v === value;
        return (
          <Pressable key={String(v)} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => onChange(v)}
            style={[s.chip, on && { backgroundColor: t.night, borderColor: t.night }]}>
            <Text style={[s.chipText, on && { color: '#fff' }]}>{l}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Checkbox({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onToggle} style={[s.row, { marginVertical: 12, gap: 12 }]}>
      <View style={[s.box, checked && { backgroundColor: t.night, borderColor: t.night }]}>
        {checked ? <View style={s.tick} /> : null}
      </View>
      <Text style={[s.p, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[s.sheet, { paddingBottom: 20 + insets.bottom }]}>
        <View style={s.grabber} />
        <Display size={size.xl} style={{ marginBottom: 12 }}>{title}</Display>
        <ScrollView style={{ maxHeight: 580 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

export const Loading = ({ onNight }: { onNight?: boolean }) =>
  <View style={{ padding: 40 }}><ActivityIndicator color={onNight ? t.amber : t.night} /></View>;
export const Gap = ({ h = 12 }: { h?: number }) => <View style={{ height: h }} />;

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <View style={[s.row, { justifyContent: 'space-between', marginTop: 6 }]}>
        <Display size={size.lg + 2}>{title}</Display>{action}
      </View>
      {children}
    </View>
  );
}

/* ───────────────────────────── styles ───────────────────────────── */

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },
  backdropTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '45%', backgroundColor: t.night },
  band: { backgroundColor: t.night, paddingHorizontal: 20, paddingBottom: 24 },
  headerRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32 },
  back: { width: 36, height: 32, justifyContent: 'center' },
  chevron: { width: 13, height: 13, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: t.onNight, transform: [{ rotate: '45deg' }], marginLeft: 4 },
  bandSub: { fontFamily: font.bodyMedium, fontSize: size.sm + 1, color: t.onNightMuted, marginTop: 4, lineHeight: 21 },
  simChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: t.nightLine, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  simText: { color: t.onNightMuted, fontFamily: font.bodySemi, fontSize: size.xs },
  content: { flex: 1, backgroundColor: t.bg, padding: 16, gap: 14 },
  card: { backgroundColor: t.panel, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: t.line },
  ticket: { backgroundColor: t.panel, borderRadius: 18, borderWidth: 1, borderColor: t.line, overflow: 'hidden' },
  ticketBody: { padding: 18 },
  ticketStub: { paddingHorizontal: 18, paddingTop: 4, paddingBottom: 16 },
  tear: { height: 22, justifyContent: 'center' },
  notch: { position: 'absolute', top: 0, width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: t.line },
  perf: { marginHorizontal: 16, borderTopWidth: 1.5, borderStyle: 'dashed', borderColor: '#C9CDE0' },
  bar: { height: 12, borderRadius: 6, flexDirection: 'row', overflow: 'hidden' },
  legend: { fontFamily: font.bodyMedium, fontSize: size.xs + 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  btn: { borderRadius: 14, borderWidth: 1.5, paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', minHeight: 54 },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 14, minHeight: 40, borderRadius: 12 },
  btnText: { fontFamily: font.bodyBold, fontSize: size.md + 1, letterSpacing: 0.2 },
  pill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontFamily: font.bodySemi, fontSize: size.xs + 0.5 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, gap: 12 },
  kvStrong: { borderTopWidth: 1, borderTopColor: t.line, marginTop: 6, paddingTop: 12 },
  kvLabel: { color: t.ink, fontFamily: font.body, fontSize: size.md - 1, flexShrink: 1 },
  kvValue: { fontFamily: font.bodySemi, fontSize: size.md - 1, fontVariant: ['tabular-nums'], textAlign: 'right' },
  muted: { color: t.muted },
  notice: { borderRadius: 12, padding: 13, borderLeftWidth: 4, marginVertical: 4 },
  label: { fontSize: size.sm - 1, color: t.muted, marginBottom: 7, fontFamily: font.bodySemi },
  input: { borderWidth: 1.5, borderColor: t.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: size.md, fontFamily: font.bodyMedium, backgroundColor: '#fff', color: t.ink },
  chip: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1.5, borderColor: t.line, backgroundColor: '#fff' },
  chipText: { fontFamily: font.bodySemi, fontSize: size.sm, color: t.ink },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: '#A3A6BD', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  tick: { width: 11, height: 6, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: '#fff', transform: [{ rotate: '-45deg' }], marginTop: -2 },
  scrim: { flex: 1, backgroundColor: 'rgba(17,16,48,0.55)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingTop: 10 },
  grabber: { width: 44, height: 5, borderRadius: 3, backgroundColor: t.line, alignSelf: 'center', marginBottom: 14 },
  h2: { fontFamily: font.display, fontSize: size.lg + 2, color: t.ink, marginBottom: 8 },
  p: { fontFamily: font.body, fontSize: size.md - 1, color: t.ink, lineHeight: 22 },
  small: { fontSize: size.sm - 1, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  between: { justifyContent: 'space-between' },
  bold: { fontFamily: font.bodyBold },
  stat: { fontFamily: font.display, fontSize: size.xl, color: t.ink, fontVariant: ['tabular-nums'] },
});
