import { Text, View } from 'react-native';
import { Display } from '@/components/ui';
import { font, size, theme } from '@/lib/theme';
import type { Pool } from '@/lib/types';

/** Match: "Home vs Away" in scoreboard type. Tournament: the field of contenders. */
export function FaceOff({ pool, onNight, compact }: { pool: Pool; onNight?: boolean; compact?: boolean }) {
  const ink = onNight ? theme.onNight : theme.ink;
  const sub = onNight ? theme.onNightMuted : theme.muted;
  const big = compact ? size.xl : size.xxl;
  if (pool.event.kind === 'MATCH' && pool.selections.length === 2) {
    // Show the home side first regardless of API sort order.
    const [a, b] = [...pool.selections].sort((x, y) => (x.code === 'HOME' ? -1 : y.code === 'HOME' ? 1 : 0));
    return (
      <View>
        <Display size={big} color={ink} lines={2}>{a.label}</Display>
        <Text style={{ fontFamily: font.displayMedium, fontSize: size.md, color: onNight ? theme.amber : theme.amberDeep, marginVertical: 2 }}>vs</Text>
        <Display size={big} color={ink} lines={2}>{b.label}</Display>
      </View>
    );
  }
  return (
    <View>
      <Display size={big} color={ink} lines={2}>{pool.event.name.replace(/ — Tournament Winner$/, '')}</Display>
      <Text style={{ fontFamily: font.bodyMedium, fontSize: size.sm, color: sub, marginTop: 4 }}>
        {pool.selections.length} contenders: {pool.selections.map((x) => x.label).join(', ')}
      </Text>
    </View>
  );
}
